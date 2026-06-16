variable "project_name" {}
variable "environment"  {}

# ── Config table ──────────────────────────────────────────────────────────────
resource "aws_dynamodb_table" "config" {
  name         = "${var.project_name}-${var.environment}-config"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "configKey"

  attribute {
    name = "configKey"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

# Default config item — the React UI overwrites this via POST /save-config
resource "aws_dynamodb_table_item" "default_config" {
  table_name = aws_dynamodb_table.config.name
  hash_key   = aws_dynamodb_table.config.hash_key

  item = jsonencode({
    configKey      = { S = "alert-config" }
    recipientEmail = { S = "" }
    Tipos          = { L = [] }
    Areas          = { L = [] }
    Relevancia_min = { N = "1" }
    calls_per_month = { N = "3" }
    enabled        = { BOOL = false }
    updatedAt      = { S = "never" }
  })

  lifecycle { ignore_changes = [item] }
}

# ── Results table ─────────────────────────────────────────────────────────────
# Stores a SINGLE master record (resultKey = "master") that is the
# union of all Claude API responses deduplicated by numero_nombre.
resource "aws_dynamodb_table" "results" {
  name         = "${var.project_name}-${var.environment}-results"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "resultKey"

  attribute {
    name = "resultKey"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

# Seed empty master record
resource "aws_dynamodb_table_item" "master_record" {
  table_name = aws_dynamodb_table.results.name
  hash_key   = aws_dynamodb_table.results.hash_key

  item = jsonencode({
    resultKey              = { S = "master" }
    rango_de_fechas        = { L = [] }
    fuentes_consultadas    = { L = [] }
    documentos             = { L = [] }
    proyectos_en_consulta  = { L = [] }
    lastUpdated            = { S = "never" }
  })

  lifecycle { ignore_changes = [item] }
}

output "config_table_name"  { value = aws_dynamodb_table.config.name }
output "results_table_name" { value = aws_dynamodb_table.results.name }
output "config_table_arn"   { value = aws_dynamodb_table.config.arn }
output "results_table_arn"  { value = aws_dynamodb_table.results.arn }
