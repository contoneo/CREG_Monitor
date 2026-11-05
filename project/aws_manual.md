# AWS Manual Deployment (Console-Only)

This describes how to build the same infrastructure as `terraform/` **by hand,
in the AWS Console** — no Terraform, no CLI (a couple of steps still need a
local zip file or the CLI for `s3 sync`, noted where that happens).

Use this if Terraform/CLI access isn't available, or to understand exactly
what Terraform is doing under the hood. **This file is a manual mirror, not
the source of truth** — if the Terraform config in `terraform/` changes
(new resource, new env var, new route, …), update this file too, or it will
drift and mislead the next person who follows it.

Resource names below use the same pattern Terraform uses:
`${project_name}-${environment}-<thing>`. This guide uses `alert-app-dev` as
the example (matching `terraform.tfvars.example`) — substitute your own
project name/environment consistently everywhere you see it.

**Pick one AWS region before starting and use it for every step.** All
resources below (Lambda, DynamoDB, API Gateway, SSM, EventBridge Scheduler)
must live in the same region to reference each other by name. S3/CloudFront
are the exception — S3 buckets are region-specific but CloudFront is global.

---

## Order of creation

Some resources reference others by ARN, so build in this order:

1. IAM roles + policies
2. SSM Parameter Store secrets
3. DynamoDB tables
4. SES identity
5. Lambda functions
6. API Gateway (HTTP API)
7. EventBridge Scheduler
8. S3 + CloudFront (frontend)
9. Build & upload the React app

IAM policies below reference DynamoDB table ARNs, SSM parameter ARNs, and the
`run-alert` Lambda's own ARN. All of these are **deterministic** (derived only
from account ID, region, and the resource name pattern — no random suffixes),
so you can write the IAM policies first even though the resources they
reference don't exist yet; AWS does not validate that a resource ARN in an
inline policy already exists.

Find your AWS account ID (needed in every ARN below): **IAM Console → top
right dropdown** shows it, or **CloudShell**: `aws sts get-caller-identity`.

---

## 1. IAM roles

### 1.1 Lambda execution role

**IAM → Roles → Create role**
- Trusted entity type: **AWS service**
- Use case: **Lambda**
- Skip attaching managed policies → **Next** → **Create role**
- Name: `alert-app-dev-lambda-exec`

After creation, open the role → **Add permissions → Create inline policy** →
JSON tab → paste (substitute `<REGION>` and `<ACCOUNT_ID>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:<REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/alert-app-dev-*"
    },
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/alert-app-dev-config",
        "arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/alert-app-dev-results"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": [
        "arn:aws:ssm:<REGION>:<ACCOUNT_ID>:parameter/alert-app/dev/claude-api-key",
        "arn:aws:ssm:<REGION>:<ACCOUNT_ID>:parameter/alert-app/dev/ollama-api-key",
        "arn:aws:ssm:<REGION>:<ACCOUNT_ID>:parameter/alert-app/dev/cf-access-client-id",
        "arn:aws:ssm:<REGION>:<ACCOUNT_ID>:parameter/alert-app/dev/cf-access-client-secret"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction"],
      "Resource": "arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:alert-app-dev-run-alert"
    }
  ]
}
```

Name the policy `alert-app-dev-lambda-policy` → **Create policy**.

> The last statement lets `run-alert` invoke **itself** asynchronously (the
> "async job" worker pattern — see `project/CLAUDE.md`). It references its own
> function ARN before that function exists yet; that's fine.

### 1.2 EventBridge Scheduler role

**IAM → Roles → Create role**
- Trusted entity type: **Custom trust policy** → paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "scheduler.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
```

- Name: `alert-app-dev-scheduler`
- No managed policy needed yet — the inline policy is added in step 7, once
  the `run-alert` Lambda ARN is known for real.

---

## 2. SSM Parameter Store (secrets)

**Systems Manager → Parameter Store → Create parameter**, four times:

| Name | Type | Value |
|---|---|---|
| `/alert-app/dev/claude-api-key` | SecureString | your Anthropic API key |
| `/alert-app/dev/ollama-api-key` | SecureString | Ollama hosted web-search key (or `default` if using Claude) |
| `/alert-app/dev/cf-access-client-id` | SecureString | Cloudflare Access service-token client ID (or `default`) |
| `/alert-app/dev/cf-access-client-secret` | SecureString | Cloudflare Access service-token client secret (or `default`) |

Use the default KMS key (`alias/aws/ssm`) unless you have a specific CMK.

---

## 3. DynamoDB tables

### 3.1 Config table

**DynamoDB → Tables → Create table**
- Table name: `alert-app-dev-config`
- Partition key: `configKey` (String)
- Table settings: **Customize** → Capacity mode: **On-demand**
- After creation: **Backups → Point-in-time recovery → Enable**

Seed the default item — **Explore table items → Create item** → JSON view:

```json
{
  "configKey": "alert-config",
  "recipientEmail": "",
  "Tipos": [],
  "Areas": [],
  "Relevancia_min": 1,
  "calls_per_month": 3,
  "enabled": false,
  "updatedAt": "never"
}
```

### 3.2 Results table

**DynamoDB → Tables → Create table**
- Table name: `alert-app-dev-results`
- Partition key: `resultKey` (String)
- Capacity mode: **On-demand**
- After creation:
  - **Backups → Point-in-time recovery → Enable**
  - **Additional settings → Time to Live (TTL) → Enable**, attribute name `ttl`
    (this auto-expires the transient `job#<uuid>` async-job status records;
    the seeded `master` item below never sets `ttl`, so it's unaffected)

Seed the master record — **Explore table items → Create item** → JSON view:

```json
{
  "resultKey": "master",
  "rango_de_fechas": [],
  "fuentes_consultadas": [],
  "documentos": [],
  "proyectos_en_consulta": [],
  "lastUpdated": "never"
}
```

---

## 4. SES (email)

**SES → Verified identities → Create identity**
- Identity type: **Email address**
- Email: your sender address (e.g. `alerts@yourdomain.com`)
- Check that inbox and click the verification link AWS sends.

> SES starts in **sandbox mode**: both sender and every recipient must be
> verified identities. Verify the recipient the same way, or request
> production access: **SES → Account dashboard → Request production access**.

Optional (only if you want DKIM on a full domain instead of a single mailbox):
**Create identity → Domain** → enable **Easy DKIM** → add the 3 CNAME records
it gives you to your DNS provider.

---

## 5. Lambda functions

All three share: **Runtime `Node.js 22.x`**, **Architecture `x86_64`**,
**Execution role** = the existing role `alert-app-dev-lambda-exec` (created
in step 1.1 — choose "Use an existing role").

Each Lambda's code must be zipped **locally first**, including
`node_modules` (the console's inline editor can't handle installed
dependencies):

```bash
cd project/lambdas/run-alert       && npm install && zip -r /tmp/run-alert.zip .        && cd -
cd project/lambdas/save-config     && npm install && zip -r /tmp/save-config.zip .      && cd -
cd project/lambdas/get-master-json && npm install && zip -r /tmp/get-master-json.zip .  && cd -
```

### 5.1 `run-alert`

**Lambda → Create function**
- Name: `alert-app-dev-run-alert`
- Runtime: Node.js 22.x, existing role `alert-app-dev-lambda-exec`
- After creation:
  - **Code → Upload from → .zip file** → `/tmp/run-alert.zip`
  - Handler: `index.handler`
  - **Configuration → General configuration → Edit**: Timeout `5 min 0 sec`
    (300s), Memory `256 MB`
  - **Configuration → Monitoring and operations tools → Edit**: enable
    **Active tracing** (AWS X-Ray)
  - **Configuration → Environment variables → Edit** → add:

    | Key | Value |
    |---|---|
    | `CONFIG_TABLE` | `alert-app-dev-config` |
    | `RESULTS_TABLE` | `alert-app-dev-results` |
    | `SENDER_EMAIL` | your verified SES sender address |
    | `CLAUDE_API_KEY_SSM_PATH` | `/alert-app/dev/claude-api-key` |
    | `AWS_REGION_NAME` | `<REGION>` |
    | `API_PROVIDER` | `claude` (or `ollama`) |
    | `OLLAMA_BASE_URL` | Cloudflare Tunnel URL, or blank if using Claude |
    | `CF_ACCESS_CLIENT_ID_SSM_PATH` | `/alert-app/dev/cf-access-client-id` |
    | `CF_ACCESS_CLIENT_SECRET_SSM_PATH` | `/alert-app/dev/cf-access-client-secret` |
    | `OLLAMA_API_KEY_SSM_PATH` | `/alert-app/dev/ollama-api-key` |

### 5.2 `save-config`

**Lambda → Create function**
- Name: `alert-app-dev-save-config`
- Runtime: Node.js 22.x, existing role `alert-app-dev-lambda-exec`
- Code → upload `/tmp/save-config.zip`, handler `index.handler`
- Timeout `10 sec`, Memory `128 MB`
- Enable Active tracing (X-Ray)
- Environment variables: `CONFIG_TABLE=alert-app-dev-config`,
  `AWS_REGION_NAME=<REGION>`

### 5.3 `get-master-json`

**Lambda → Create function**
- Name: `alert-app-dev-get-master-json`
- Runtime: Node.js 22.x, existing role `alert-app-dev-lambda-exec`
- Code → upload `/tmp/get-master-json.zip`, handler `index.handler`
- Timeout `10 sec`, Memory `128 MB`
- Enable Active tracing (X-Ray)
- Environment variables: `RESULTS_TABLE=alert-app-dev-results`,
  `AWS_REGION_NAME=<REGION>`

---

## 6. API Gateway (HTTP API)

**API Gateway → Create API → HTTP API → Build**
- Name: `alert-app-dev-api`
- Don't add integrations/routes in the wizard — add them after, below.
- **CORS** (in the create wizard, or **Develop → CORS** after):
  - Access-Control-Allow-Origin: your CloudFront domain, e.g.
    `https://dXXXXXXXXXXXXX.cloudfront.net`, plus `http://localhost:3000`
  - Access-Control-Allow-Methods: `POST, GET, OPTIONS`
  - Access-Control-Allow-Headers: `Content-Type, Authorization, x-api-key`
  - Access-Control-Max-Age: `300`
  - (You'll need to come back and set the real CloudFront domain here once
    step 8 creates the distribution — there's a chicken/egg with the frontend
    module in Terraform too, which is why `allowed_origin` there is built from
    `module.frontend.cloudfront_domain`.)

### 6.1 Integrations

**Develop → Integrations → Create** — one per Lambda, **AWS_PROXY** type,
**Payload format version 2.0**:
- `run_alert` → target `alert-app-dev-run-alert`
- `save_config` → target `alert-app-dev-save-config`
- `get_master_json` → target `alert-app-dev-get-master-json`

### 6.2 Routes

**Develop → Routes → Create**, six total, each attached to the matching
integration above:

| Route | Integration |
|---|---|
| `POST /run-alert` | `run_alert` |
| `GET /run-alert-status` | `run_alert` (same integration — the `run-alert` Lambda dispatches on `event.routeKey` internally; this is the AWS-only polling route for the async job, see root `CLAUDE.md`) |
| `POST /save-config` | `save_config` |
| `GET /get-config` | `save_config` |
| `GET /get-master-json` | `get_master_json` |
| `POST /reset-master` | `get_master_json` (same Lambda handles the reset) |

### 6.3 Stage

**Develop → Stages** — the `$default` stage is created automatically with
**Auto-deploy** on. Edit it:
- **Logging → Access log destination**: create/select a CloudWatch Logs group
  `/aws/apigateway/alert-app-dev`; log format (JSON):
  ```json
  {"requestId":"$context.requestId","routeKey":"$context.routeKey","status":"$context.status","responseLength":"$context.responseLength","integrationError":"$context.integrationErrorMessage"}
  ```

### 6.4 Lambda resource-based permissions

Each Lambda needs to allow this specific API to invoke it. For **each** of the
3 Lambdas: **Lambda → function → Configuration → Permissions → Resource-based
policy → Add permissions**:
- Service: **API Gateway**
- Statement ID: `AllowAPIGatewayInvoke`
- Source ARN: `arn:aws:execute-api:<REGION>:<ACCOUNT_ID>:<API_ID>/*/*`
  (find `<API_ID>` on the API's **Details** page)

(The console usually offers to add this automatically when you create the
integration through the API Gateway UI — check **Lambda → Permissions** after
step 6.1 before doing this by hand; it may already be there.)

Note the **Invoke URL** shown on the API's **Details** page — you'll need it
as `VITE_API_BASE` in step 9.

---

## 7. EventBridge Scheduler

First, finish the scheduler IAM role from step 1.2 — now that the Lambda
exists, add the inline policy:

**IAM → Roles → `alert-app-dev-scheduler` → Add permissions → Create inline
policy** → JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunction",
    "Resource": "arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:alert-app-dev-run-alert"
  }]
}
```

Name it `alert-app-dev-scheduler-invoke`.

Then create the schedule — **Amazon EventBridge → Scheduler → Create
schedule**:
- Name: `alert-app-dev-periodic-job`
- Schedule pattern: **Recurring schedule** → rate-based, e.g. `1 hours`
  (or a cron expression, e.g. `0 8 * * ? *` for daily 08:00 UTC)
- Timezone: **UTC**
- Flexible time window: **On**, maximum `5` minutes
- Target: **AWS Lambda → Invoke** → function `alert-app-dev-run-alert`
- Input: `{"periodic": true}`
- Execution role: **Use existing role** → `alert-app-dev-scheduler`
- Retry policy: max retry attempts `2`, max age of event `300` seconds

> EventBridge Scheduler invokes the Lambda **directly**, not through API
> Gateway — its universal target can only call AWS SDK actions, not an
> arbitrary HTTP endpoint. This is also why the periodic path has no 30-second
> timeout ceiling (see root `CLAUDE.md`, "async job" section).

---

## 8. S3 + CloudFront (frontend)

### 8.1 S3 bucket

**S3 → Create bucket**
- Name: `alert-app-dev-frontend-<unique-suffix>` (S3 bucket names are
  globally unique — Terraform appends a random hex suffix; pick your own,
  e.g. a short random string)
- Region: same as everything else, for simplicity
- **Block all public access**: keep **ON** (all four checkboxes) — access is
  granted only to CloudFront, via OAC + bucket policy below, never directly
- **Bucket Versioning**: **Enable**

### 8.2 CloudFront Origin Access Control (OAC)

**CloudFront → Origin access → Create control setting**
- Name: `alert-app-dev-oac`
- Signing behavior: **Sign requests (recommended)**
- Origin type: **S3**

### 8.3 CloudFront distribution

**CloudFront → Distributions → Create distribution**
- Origin domain: select the S3 bucket (use the **bucket** option, not the
  website-endpoint one, so OAC applies)
- Origin access: **Origin access control settings** → select the OAC from 8.2
  (the console will offer to update the bucket policy automatically — accept,
  or paste it manually, see below)
- Viewer protocol policy: **Redirect HTTP to HTTPS**
- Allowed HTTP methods: **GET, HEAD**
- Cache policy: use a policy with `Cache-Control` respected, or set
  min/default/max TTL to `0` / `3600` / `86400` and disable forwarding query
  strings and cookies
- Compress objects automatically: **Yes**
- Default root object: `index.html`
- Price class: **Use only North America and Europe** (`PriceClass_100`) —
  adjust to your traffic needs
- IPv6: **On**

**Custom error responses** (SPA fallback — React Router needs unknown paths
to resolve to `index.html`) — add two, under **Error pages**:

| HTTP error code | Response page path | Response code |
|---|---|---|
| 403 | `/index.html` | 200 |
| 404 | `/index.html` | 200 |

### 8.4 S3 bucket policy

If the console didn't auto-attach it in 8.3, add manually — **S3 → bucket →
Permissions → Bucket policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::alert-app-dev-frontend-<unique-suffix>/*",
    "Condition": {
      "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DISTRIBUTION_ID>" }
    }
  }]
}
```

### 8.5 Wire the real CloudFront domain back into API Gateway CORS

Now that the distribution exists, go back to **API Gateway → CORS** (step 6)
and set `Access-Control-Allow-Origin` to the actual
`https://dXXXXXXXXXXXXX.cloudfront.net` domain shown on the distribution's
**Details** page.

---

## 9. Build and upload the React app

This step still needs a terminal (the React build itself isn't an AWS
console action):

```bash
cd BIA_react
echo "VITE_API_BASE=https://<API_ID>.execute-api.<REGION>.amazonaws.com" > .env.production
npm run build
aws s3 sync dist/ "s3://alert-app-dev-frontend-<unique-suffix>" --delete
aws cloudfront create-invalidation --distribution-id <DISTRIBUTION_ID> --paths "/*"
```

Or do the S3 sync manually in the console: **S3 → bucket → Upload** →
drag in everything from `BIA_react/dist/` → and invalidate the cache:
**CloudFront → distribution → Invalidations → Create invalidation** → path
`/*`.

> `VITE_API_BASE` (not `REACT_APP_*`) and `dist/` (not `build/`) matter —
> Vite ignores `REACT_APP_*` vars, and a wrong build ships a bundle that falls
> back to `http://localhost:8787`. Confirm with
> `grep -c -F 'localhost:8787' dist/assets/*.js` → should print `0`.

---

## Verification checklist

- [ ] Visit the CloudFront domain — the app loads
- [ ] SES sender (and recipient, if still in sandbox) show **Verified** in
      **SES → Verified identities**
- [ ] `POST /run-alert` from the app returns a result (or a `jobId` that
      resolves via polling)
- [ ] CloudWatch Logs has entries under all four log groups:
      `/aws/lambda/alert-app-dev-run-alert`,
      `/aws/lambda/alert-app-dev-save-config`,
      `/aws/lambda/alert-app-dev-get-master-json`,
      `/aws/apigateway/alert-app-dev`
- [ ] EventBridge Scheduler → the schedule shows **Enabled** and a next-run
      time
- [ ] DynamoDB → both tables show the seeded items

---

## Notes on parity with Terraform

- This manual reproduces every resource in `terraform/main.tf` and
  `terraform/modules/*`. If you add/remove a resource, env var, route, or IAM
  statement in Terraform, mirror the change here.
- Terraform's `lifecycle { ignore_changes = [item] }` on the two seeded
  DynamoDB items means Terraform won't fight you if the app later overwrites
  them — the console equivalent is simply: don't manually re-edit those items
  after the app has started writing to them.
- Manually-created resources are **not** tracked in `terraform.tfstate`. If
  you later want to manage this same infrastructure with Terraform, you'd need
  `terraform import` for each resource, or destroy and re-apply.
