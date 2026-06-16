variable "project_name"            {}
variable "environment"             {}
variable "aws_region"              {}
variable "lambda_exec_role_arn"    {}
variable "config_table_name"       {}
variable "results_table_name"      {}
variable "claude_api_key_ssm_path" {}
variable "sender_email"            {}
variable "allowed_origin"          {}

locals {
  run_alert_fn      = "${var.project_name}-${var.environment}-run-alert"
  save_config_fn    = "${var.project_name}-${var.environment}-save-config"
  get_master_json_fn = "${var.project_name}-${var.environment}-get-master-json"
}

# ── Lambda packages ───────────────────────────────────────────────────────────
data "archive_file" "run_alert" {
  type        = "zip"
  source_dir  = "${path.root}/../lambdas/run-alert"
  output_path = "${path.module}/builds/run-alert.zip"
  excludes    = ["node_modules/.cache"]
}

data "archive_file" "save_config" {
  type        = "zip"
  source_dir  = "${path.root}/../lambdas/save-config"
  output_path = "${path.module}/builds/save-config.zip"
  excludes    = ["node_modules/.cache"]
}

data "archive_file" "get_master_json" {
  type        = "zip"
  source_dir  = "${path.root}/../lambdas/get-master-json"
  output_path = "${path.module}/builds/get-master-json.zip"
  excludes    = ["node_modules/.cache"]
}

# ── CloudWatch Log Groups ──────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "run_alert" {
  name              = "/aws/lambda/${local.run_alert_fn}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "save_config" {
  name              = "/aws/lambda/${local.save_config_fn}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "get_master_json" {
  name              = "/aws/lambda/${local.get_master_json_fn}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "api_gw" {
  name              = "/aws/apigateway/${var.project_name}-${var.environment}"
  retention_in_days = 14
}

# ── Lambda: run-alert ─────────────────────────────────────────────────────────
resource "aws_lambda_function" "run_alert" {
  function_name    = local.run_alert_fn
  role             = var.lambda_exec_role_arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.run_alert.output_path
  source_code_hash = data.archive_file.run_alert.output_base64sha256
  timeout          = 60
  memory_size      = 256

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CONFIG_TABLE            = var.config_table_name
      RESULTS_TABLE           = var.results_table_name
      SENDER_EMAIL            = var.sender_email
      CLAUDE_API_KEY_SSM_PATH = var.claude_api_key_ssm_path
      AWS_REGION_NAME         = var.aws_region
    }
  }

  depends_on = [aws_cloudwatch_log_group.run_alert]
}

# ── Lambda: save-config ───────────────────────────────────────────────────────
resource "aws_lambda_function" "save_config" {
  function_name    = local.save_config_fn
  role             = var.lambda_exec_role_arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.save_config.output_path
  source_code_hash = data.archive_file.save_config.output_base64sha256
  timeout          = 10
  memory_size      = 128

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CONFIG_TABLE    = var.config_table_name
      AWS_REGION_NAME = var.aws_region
    }
  }

  depends_on = [aws_cloudwatch_log_group.save_config]
}

# ── Lambda: get-master-json ───────────────────────────────────────────────────
resource "aws_lambda_function" "get_master_json" {
  function_name    = local.get_master_json_fn
  role             = var.lambda_exec_role_arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.get_master_json.output_path
  source_code_hash = data.archive_file.get_master_json.output_base64sha256
  timeout          = 10
  memory_size      = 128

  tracing_config { mode = "Active" }

  environment {
    variables = {
      RESULTS_TABLE   = var.results_table_name
      AWS_REGION_NAME = var.aws_region
    }
  }

  depends_on = [aws_cloudwatch_log_group.get_master_json]
}

# ── API Gateway ───────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-${var.environment}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [var.allowed_origin, "http://localhost:3000"]
    allow_methods = ["POST", "GET", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization", "x-api-key"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }
}

# ── Integrations ──────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_integration" "run_alert" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.run_alert.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "save_config" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.save_config.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "get_master_json" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.get_master_json.invoke_arn
  payload_format_version = "2.0"
}

# ── Routes ────────────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_route" "run_alert" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /run-alert"
  target    = "integrations/${aws_apigatewayv2_integration.run_alert.id}"
}

resource "aws_apigatewayv2_route" "save_config" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /save-config"
  target    = "integrations/${aws_apigatewayv2_integration.save_config.id}"
}

resource "aws_apigatewayv2_route" "get_config" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /get-config"
  target    = "integrations/${aws_apigatewayv2_integration.save_config.id}"
}

resource "aws_apigatewayv2_route" "get_master_json" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /get-master-json"
  target    = "integrations/${aws_apigatewayv2_integration.get_master_json.id}"
}

# ── Lambda permissions ────────────────────────────────────────────────────────
resource "aws_lambda_permission" "run_alert" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.run_alert.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "save_config" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.save_config.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "get_master_json" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_master_json.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

output "api_url"          { value = aws_apigatewayv2_api.main.api_endpoint }
output "run_alert_fn"     { value = aws_lambda_function.run_alert.function_name }
