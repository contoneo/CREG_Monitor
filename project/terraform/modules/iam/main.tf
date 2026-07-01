variable "project_name" {}
variable "environment" {}
variable "aws_region" {}
variable "aws_account_id" {}

# ── Lambda execution role ─────────────────────────────────────────────────────
resource "aws_iam_role" "lambda_exec" {
  name = "${var.project_name}-${var.environment}-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda_exec_policy" {
  name = "${var.project_name}-${var.environment}-lambda-policy"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # CloudWatch Logs
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.project_name}-${var.environment}-*"
      },
      {
        # SES
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
      },
      {
        # DynamoDB — both tables
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Scan",
          "dynamodb:Query"
        ]
        Resource = [
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-config",
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-results"
        ]
      },
      {
        # SSM — Claude key + Ollama/Cloudflare secrets
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/claude-api-key",
          "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/ollama-api-key",
          "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/cf-access-client-id",
          "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/cf-access-client-secret",
        ]
      },
      {
        # X-Ray
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      },
      {
        # Self-invoke — run-alert asynchronously invokes itself as a worker to
        # escape API Gateway's hard 30s integration timeout (Ollama calls can
        # take 45-60s+). See project/CLAUDE.md "async job" section.
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${var.project_name}-${var.environment}-run-alert"
      }
    ]
  })
}

# ── EventBridge Scheduler role ────────────────────────────────────────────────
# Scheduler invokes the run-alert Lambda directly (it can't POST to an HTTP
# endpoint) — see modules/scheduler/main.tf.
resource "aws_iam_role" "scheduler" {
  name = "${var.project_name}-${var.environment}-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# The invoke permission for this role (lambda:InvokeFunction on run-alert) is
# attached in the scheduler module, which is where the target Lambda ARN is known.

output "lambda_exec_role_arn" { value = aws_iam_role.lambda_exec.arn }
output "scheduler_role_arn" { value = aws_iam_role.scheduler.arn }
output "scheduler_role_name" { value = aws_iam_role.scheduler.name }
