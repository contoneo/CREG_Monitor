terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # backend "s3" {
  #   bucket         = "your-terraform-state-bucket"
  #   key            = "alert-app/terraform.tfstate"
  #   region         = "eu-central-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-state-lock"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

# ── SSM: Claude API key ───────────────────────────────────────────────────────
resource "aws_ssm_parameter" "claude_api_key" {
  name        = "/${var.project_name}/${var.environment}/claude-api-key"
  description = "Anthropic Claude API Key"
  type        = "SecureString"
  value       = var.claude_api_key

  lifecycle {
    ignore_changes = [value]
  }
}

# ── Modules ───────────────────────────────────────────────────────────────────
module "iam" {
  source         = "./modules/iam"
  project_name   = var.project_name
  environment    = var.environment
  aws_region     = var.aws_region
  aws_account_id = data.aws_caller_identity.current.account_id
}

module "storage" {
  source       = "./modules/storage"
  project_name = var.project_name
  environment  = var.environment
}

module "email" {
  source        = "./modules/email"
  sender_email  = var.sender_email
  sender_domain = var.sender_domain
}

module "frontend" {
  source       = "./modules/frontend"
  project_name = var.project_name
  environment  = var.environment
}

module "api" {
  source                 = "./modules/api"
  project_name           = var.project_name
  environment            = var.environment
  aws_region             = var.aws_region
  lambda_exec_role_arn   = module.iam.lambda_exec_role_arn
  config_table_name      = module.storage.config_table_name
  results_table_name     = module.storage.results_table_name
  claude_api_key_ssm_path = "/${var.project_name}/${var.environment}/claude-api-key"
  sender_email           = var.sender_email
  allowed_origin         = "https://${module.frontend.cloudfront_domain}"
}

module "scheduler" {
  source              = "./modules/scheduler"
  project_name        = var.project_name
  environment         = var.environment
  scheduler_role_arn  = module.iam.scheduler_role_arn
  api_endpoint        = "${module.api.api_url}/run-alert"
  schedule_expression = var.schedule_expression
}
