variable "project_name"       {}
variable "environment"        {}
variable "scheduler_role_arn" {}
variable "api_endpoint"       {}   # full URL: https://xxx.execute-api.region.amazonaws.com/run-alert
variable "schedule_expression" {}

# EventBridge Scheduler → POST /run-alert (HTTP target)
# This replaces the old periodic Lambda entirely.
# The scheduler posts an empty body; run-alert reads config from DynamoDB.
resource "aws_scheduler_schedule" "periodic_job" {
  name                         = "${var.project_name}-${var.environment}-periodic-job"
  description                  = "Periodically calls /run-alert to check for new documents"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 5
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:apigateway:invoke"
    role_arn = var.scheduler_role_arn

    # HTTP target — EventBridge calls the API Gateway endpoint directly
    # Using the universal target for HTTP APIs
    input = jsonencode({
      # Empty body — Lambda reads everything from DynamoDB config
      # The periodic flag tells run-alert to use saved config (no override)
      periodic = true
    })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 300
    }
  }
}

output "schedule_arn" { value = aws_scheduler_schedule.periodic_job.arn }
