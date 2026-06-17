# CLAUDE.md

Guidance for Claude Code working in `project/` (the AWS/Terraform deployment of
Monitor CREG). Repo-wide context is in the root `CLAUDE.md`.

## Read first

- **`CONTEXT.md`** — the full design record: architecture, the four-endpoint
  HTTP contract, data schemas, key decisions (server-side key, single master
  record, email gating), infrastructure, and known issues. Start here.
- **`README.md`** — deployment runbook: prerequisites, variables, `terraform
  apply`, SES verification, building/uploading the frontend, teardown.

## Layout

```
lambdas/
  run-alert/        # POST /run-alert  — Claude call + merge master + SES email
  save-config/      # POST /save-config, GET /get-config
  get-master-json/  # GET  /get-master-json
src/api.js          # React API client used by the deployed frontend
terraform/          # modular IaC: iam, storage, email, api, scheduler, frontend
```

The Lambdas in `lambdas/*` are the **production** implementation of the same
HTTP contract that `BIA_react/api.js` mocks locally — keep them in sync when the
contract changes.

## Commands

```bash
cd terraform && terraform init && terraform plan && terraform apply
```

Lambda deps: `cd lambdas/<fn> && npm install`. Secrets are passed via
`TF_VAR_claude_api_key` / `TF_VAR_sender_email` (never commit). See `README.md`
for the full sequence and for building + uploading the frontend after apply.

## Conventions

- Lambdas are Node.js 20 ES modules (`index.mjs`, `export const handler`).
- The Claude API key is server-side only (SSM SecureString); never put it in the
  React bundle or Lambda env vars in plaintext.
- Email is sent only when alerts are `enabled`, there are new items, and
  `recipientEmail` is valid — the same regex the frontend uses.
