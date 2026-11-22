# Reporte del mes cerrado (día 1, 08:00 GT). La invoca el root scheduler.
# Dependencias leídas por nombre.
data "aws_caller_identity" "current" {}

data "aws_dynamodb_table" "main" {
  name = "${var.project_name}-finanzas"
}

data "aws_secretsmanager_secret" "telegram" {
  name = "${var.project_name}/telegram"
}

data "aws_secretsmanager_secret" "llm" {
  name = "${var.project_name}/llm"
}

locals {
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/boundary-${var.project_name}"
}

module "function" {
  source = "../../modules/lambda-function"

  name                     = "${var.project_name}-monthly-report"
  description              = "Reporte mensual con análisis del mes cerrado"
  memory_size              = var.memory_size
  timeout                  = var.timeout
  log_retention_days       = var.log_retention_days
  permissions_boundary_arn = local.boundary_arn

  environment = {
    TABLE_NAME           = data.aws_dynamodb_table.main.name
    TELEGRAM_SECRET_NAME = data.aws_secretsmanager_secret.telegram.name
    LLM_SECRET_NAME      = data.aws_secretsmanager_secret.llm.name
    LLM_PROVIDER         = var.llm_provider
  }

  policy_statements = [
    {
      # Lee movimientos y escribe su consumo de IA (USAGE#).
      sid = "TableData"
      actions = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
      ]
      resources = [data.aws_dynamodb_table.main.arn, "${data.aws_dynamodb_table.main.arn}/index/*"]
    },
    {
      sid       = "ReadSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [data.aws_secretsmanager_secret.telegram.arn, data.aws_secretsmanager_secret.llm.arn]
    },
  ]
}
