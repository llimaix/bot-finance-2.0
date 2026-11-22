# Webhook fino: valida el secret token y el chat, y delega al processor por
# invocación asíncrona. No toca la tabla ni la IA.
data "aws_caller_identity" "current" {}

data "aws_secretsmanager_secret" "telegram" {
  name = "${var.project_name}/telegram"
}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  boundary_arn = "arn:aws:iam::${local.account_id}:policy/boundary-${var.project_name}"

  # Por nombre y no por data: así este root no depende de que el processor
  # exista al planear. La invocación falla en ejecución si no está desplegado.
  processor_name = "${var.project_name}-processor"
  processor_arn  = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:${local.processor_name}"
}

module "function" {
  source = "../../modules/lambda-function"

  name                     = "${var.project_name}-webhook"
  description              = "Recibe el webhook de Telegram y delega al processor"
  memory_size              = var.memory_size
  timeout                  = var.timeout
  log_retention_days       = var.log_retention_days
  permissions_boundary_arn = local.boundary_arn

  environment = {
    TELEGRAM_SECRET_NAME    = data.aws_secretsmanager_secret.telegram.name
    PROCESSOR_FUNCTION_NAME = local.processor_name
  }

  policy_statements = [
    {
      sid       = "ReadTelegramSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [data.aws_secretsmanager_secret.telegram.arn]
    },
    {
      sid       = "InvokeProcessor"
      actions   = ["lambda:InvokeFunction"]
      resources = [local.processor_arn]
    },
  ]
}
