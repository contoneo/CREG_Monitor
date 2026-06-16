variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-central-1"
}

variable "project_name" {
  description = "Project name prefix for all resources"
  type        = string
  default     = "alert-app"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "sender_email" {
  description = "Verified SES sender email address"
  type        = string
}

variable "sender_domain" {
  description = "Domain to verify in SES (leave empty to verify email only)"
  type        = string
  default     = ""
}

variable "claude_api_key" {
  description = "Anthropic Claude API key — stored in SSM SecureString"
  type        = string
  sensitive   = true
}

variable "schedule_expression" {
  description = "EventBridge Scheduler cron or rate expression"
  type        = string
  default     = "rate(1 hour)"
  # Examples:
  # "rate(30 minutes)"
  # "cron(0 8 * * ? *)"    → daily at 08:00 UTC
  # "cron(0 */6 * * ? *)"  → every 6 hours
}
