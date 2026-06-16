# Alert App — AWS Serverless Infrastructure

## Architecture

```
React App (S3 + CloudFront)
  │
  ├─ POST /run-alert       → Lambda: run-alert
  │                              → SSM (Claude API key)
  │                              → DynamoDB config table (read config)
  │                              → Claude API (structured JSON)
  │                              → DynamoDB results table (merge master record)
  │                              → SES (if new items detected)
  │                            ← { newItems, emailSent }
  │
  ├─ POST /save-config     → Lambda: save-config → DynamoDB config table
  ├─ GET  /get-config      → Lambda: save-config → DynamoDB config table
  └─ GET  /get-master-json → Lambda: get-master-json → DynamoDB results table

EventBridge Scheduler (cron)
  └─ POST /run-alert  (same endpoint as React, body: { periodic: true })
```

## Lambda functions

| Function | Trigger | Responsibility |
|---|---|---|
| `run-alert` | API GW + EventBridge | Call Claude → merge master → detect new items → email if needed |
| `save-config` | API GW | Read/write alert config (Tipos, Areas, Rango, calls_per_month, etc.) |
| `get-master-json` | API GW | Return the single master results record |

## DynamoDB tables

### config table — one item
```json
{
  "configKey":      "alert-config",
  "recipientEmail": "user@example.com",
  "Tipos":          ["Resolución", "Circular"],
  "Areas":          ["Financiero"],
  "Relevancia_min": 1,
  "calls_per_month": 3,
  "enabled":        true
}
```

### results table — one master item
```json
{
  "resultKey":             "master",
  "rango_de_fechas":       ["2025-01-01", "2025-06-01"],
  "fuentes_consultadas":   ["https://..."],
  "documentos":            [{ "numero_nombre": "...", ... }],
  "proyectos_en_consulta": [{ "numero_nombre": "...", ... }],
  "lastUpdated":           "2025-06-01T12:00:00.000Z"
}
```

## Rango date computation (periodic)

```
interval_days = ceil(days_in_current_month / calls_per_month)
from_date     = today - interval_days
Rango         = [from_date, today]
```

Example: 3 calls/month in a 30-day month → interval = 10 days.

---

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- Node.js >= 18
- Anthropic API key

---

## Deployment

### 1. Install Lambda dependencies

```bash
cd lambdas/run-alert       && npm install && cd ../..
cd lambdas/save-config     && npm install && cd ../..
cd lambdas/get-master-json && npm install && cd ../..
```

### 2. Configure variables

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit non-secret values in terraform.tfvars

# Pass secrets via environment variables (never commit these):
export TF_VAR_claude_api_key="sk-ant-..."
export TF_VAR_sender_email="alerts@yourdomain.com"
```

### 3. Deploy

```bash
terraform init
terraform plan
terraform apply
```

### 4. Note the outputs

```bash
terraform output                              # show all
terraform output -raw api_gateway_url         # → REACT_APP_API_URL
terraform output -raw cloudfront_distribution_id
terraform output -raw s3_bucket_name
```

### 5. Verify SES sender email

Check the inbox of `sender_email` and click the AWS verification link.

> ⚠️ SES sandbox only sends to verified emails. Request production access in
> AWS Console → SES → Account Dashboard.

### 6. Build and deploy React app

```bash
# In your React project root:
API_URL=$(cd terraform && terraform output -raw api_gateway_url)
BUCKET=$(cd terraform && terraform output -raw s3_bucket_name)
DIST=$(cd terraform && terraform output -raw cloudfront_distribution_id)

echo "REACT_APP_API_URL=${API_URL}" > .env.production
npm run build

aws s3 sync build/ s3://${BUCKET} --delete

aws cloudfront create-invalidation \
  --distribution-id ${DIST} \
  --paths "/*"
```

---

## React Integration

The frontend is **Monitor CREG**, a single React component in `creg_monitor.jsx`
that mounts into `#root`. It talks to the API only through the four `src/api.js`
client functions below. Behaviors worth knowing:

- On startup it calls `getMasterJson()` (populate the dashboard) and `getConfig()`
  (hydrate the config tab).
- Config edits auto-save through `saveConfig()`, **debounced (~600 ms)** so rapid
  edits collapse into one request.
- "Buscar ahora" calls `runAlert()` and reads `{ newItems, emailSent }`: it
  refreshes the table from `getMasterJson()` when there are new items and tells
  the user whether the alert email was sent. The request is cancellable via an
  `AbortController`.
- The recipient email field uses the same validity regex as the backend, so the
  UI and the `run-alert` Lambda agree on when an email is actually sent.

Build it and upload the output to S3 after `terraform apply` (see step 6 above).

```js
import { runAlert, saveConfig, getConfig, getMasterJson } from './api';

// On app startup — load all accumulated data
const master = await getMasterJson();
// master.documentos, master.proyectos_en_consulta, master.rango_de_fechas

// Load saved config
const config = await getConfig();

// Save config
await saveConfig({
  recipientEmail: "user@exmple.com",
  Tipos:          ["Resolución", "Circular"],
  Areas:          ["Financiero"],
  Relevancia_min: 1,
  calls_per_month: 3,
  enabled:        true,
});

// Trigger an alert run (uses saved config, no override)
const result = await runAlert();
// result.newItems.documentos            → new documents found
// result.newItems.proyectos_en_consulta → new projects found
// result.emailSent                      → true only if alerts enabled,
//                                          new items found, AND recipientEmail valid

// Trigger with overridden ENTRADA
const result2 = await runAlert({
  Tipos:  ["Acuerdo"],
  Rango:  ["2025-01-01", "2025-06-01"],
  Areas:  ["Pensiones"],
  Relevancia_min: 2,
});
```

---

## Monitoring with AWS X-Ray

X-Ray is active on all Lambda functions. After the first invocation:

**AWS Console → CloudWatch → X-Ray traces → Service map**

You will see:
```
[EventBridge] → [API Gateway] → [run-alert Lambda] → [DynamoDB]
                                                    → [SSM]
                                                    → [Claude API]
                                                    → [SES]
```

**Useful trace filters:**
```
error = true                          # failed runs
responsetime > 10                     # slow runs
annotation.emailSent = "true"         # runs that triggered email
```

---

## Changing the schedule

Edit `schedule_expression` in `terraform.tfvars`, then `terraform apply`:

```hcl
schedule_expression = "rate(1 hour)"
schedule_expression = "cron(0 8 * * ? *)"    # daily 08:00 UTC
schedule_expression = "cron(0 */6 * * ? *)"  # every 6 hours
```

---

## Teardown

```bash
# Empty S3 bucket first
aws s3 rm s3://$(cd terraform && terraform output -raw s3_bucket_name) --recursive

cd terraform && terraform destroy
```

---

## Cost estimate (eu-central-1, ~3 calls/day)

| Service    | Usage                  | Monthly cost |
|------------|------------------------|-------------|
| Lambda     | ~90 invocations/mo     | ~$0.00      |
| API Gateway| ~90 requests/mo        | ~$0.00      |
| DynamoDB   | On-demand, 2 tables    | ~$0.00      |
| S3         | <1 GB static files     | ~$0.02      |
| CloudFront | <10 GB transfer        | ~$0.85      |
| SES        | <100 emails/mo         | ~$0.01      |
| X-Ray      | <100k traces/mo        | ~$0.00      |
| **Total**  |                        | **~$1/mo**  |

Claude API costs billed separately by Anthropic.
