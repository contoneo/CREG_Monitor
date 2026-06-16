variable "sender_email"  {}
variable "sender_domain" {}

resource "aws_ses_email_identity" "sender" {
  email = var.sender_email
}

resource "aws_ses_domain_identity" "sender_domain" {
  count  = var.sender_domain != "" ? 1 : 0
  domain = var.sender_domain
}

resource "aws_ses_domain_dkim" "sender_domain_dkim" {
  count  = var.sender_domain != "" ? 1 : 0
  domain = aws_ses_domain_identity.sender_domain[0].domain
}

output "ses_email_arn" { value = aws_ses_email_identity.sender.arn }

output "dkim_tokens" {
  description = "Add as CNAME: <token>._domainkey.<domain> → <token>.dkim.amazonses.com"
  value       = var.sender_domain != "" ? aws_ses_domain_dkim.sender_domain_dkim[0].dkim_tokens : []
}
