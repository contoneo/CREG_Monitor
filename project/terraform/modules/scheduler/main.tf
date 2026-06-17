variable "project_name"         {}
variable "environment"          {}
variable "scheduler_role_arn"   {}
variable "scheduler_role_name"  {}
variable "run_alert_lambda_arn" {}
variable "schedule_expression"  {}

# EventBridge Scheduler → invokes the run-alert Lambda directly.
#
# Scheduler's universal target only calls AWS SDK actions; it cannot POST to an
# arbitrary HTTP endpoint, so it targets the Lambda rather than API Gateway.
# This is equivalent in effect: the handler reads all config from DynamoDB and
# tolerates a direct-invoke event (body defaults to {}). The { periodic: true }
# payload becomes the Lambda `event`.
resource "aws_scheduler_schedule" "periodic_job" {
  name                         = "${var.project_name}-${var.environment}-periodic-job"
  description                  = "Periodically invokes run-alert to check for new documents"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 5
  }

  target {
    arn      = var.run_alert_lambda_arn
    role_arn = var.scheduler_role_arn

    input = jsonencode({
      periodic = true
    })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 300
    }
  }
}

# Allow the scheduler role to invoke the run-alert Lambda.
resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "${var.project_name}-${var.environment}-scheduler-invoke"
  role = var.scheduler_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = var.run_alert_lambda_arn
    }]
  })
}

output "schedule_arn" { value = aws_scheduler_schedule.periodic_job.arn }
