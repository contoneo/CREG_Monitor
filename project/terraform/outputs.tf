output "cloudfront_url" {
  description = "React frontend URL"
  value       = "https://${module.frontend.cloudfront_domain}"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID — used for cache invalidation"
  value       = module.frontend.distribution_id
}

output "s3_bucket_name" {
  description = "S3 bucket — upload React build here"
  value       = module.frontend.bucket_name
}

output "api_gateway_url" {
  description = "API Gateway base URL — set as REACT_APP_API_URL"
  value       = module.api.api_url
}

output "config_table_name" {
  description = "DynamoDB config table"
  value       = module.storage.config_table_name
}

output "results_table_name" {
  description = "DynamoDB results (master record) table"
  value       = module.storage.results_table_name
}
