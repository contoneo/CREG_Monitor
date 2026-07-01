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
  description = "Anthropic Claude API key — stored in SSM SecureString. Optional while run-alert serves mock data; required once the live Claude call is wired in."
  type        = string
  sensitive   = true
  default     = "default"
}

variable "use_mock" {
  description = "When true, run-alert replays the bundled mock JSON (sets the Lambda's USE_MOCK=1, no Claude key needed). When false (default), it makes the live Anthropic call and requires a valid claude_api_key."
  type        = bool
  default     = false
}

variable "api_provider" {
  description = "AI provider for run-alert: \"claude\" (default, Anthropic Messages API) or \"ollama\" (local model via Cloudflare Tunnel)."
  type        = string
  default     = "claude"
}

variable "ollama_base_url" {
  description = "Cloudflare Tunnel URL for the local Ollama instance, e.g. https://ollama.example.com. Required when api_provider=ollama."
  type        = string
  default     = ""
}

variable "ollama_api_key" {
  description = "Ollama hosted web-search API key. Required when api_provider=ollama. Stored in SSM SecureString."
  type        = string
  sensitive   = true
  default     = "default"
}

variable "cf_access_client_id" {
  description = "Cloudflare Access service-token client ID for the Ollama tunnel. Required when api_provider=ollama. Stored in SSM SecureString."
  type        = string
  sensitive   = true
  default     = "default"
}

variable "cf_access_client_secret" {
  description = "Cloudflare Access service-token client secret for the Ollama tunnel. Required when api_provider=ollama. Stored in SSM SecureString."
  type        = string
  sensitive   = true
  default     = "default"
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
