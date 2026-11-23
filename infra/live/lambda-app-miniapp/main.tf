# API de solo lectura del dashboard (Telegram Mini App). Se expone únicamente
# por CloudFront (root miniapp-web): la Function URL usa AWS_IAM y solo la
# distribución, firmando con OAC, tiene permiso de invocarla. Además, cada
# petición debe traer el initData de Telegram firmado con el token del bot y
# del usuario permitido.
data "aws_caller_identity" "current" {}

data "aws_dynamodb_table" "main" {
  name = "${var.project_name}-finanzas"
}

data "aws_secretsmanager_secret" "telegram" {
  name = "${var.project_name}/telegram"
}

locals {
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/boundary-${var.project_name}"
}

module "function" {
  source = "../../modules/lambda-function"

  name                     = "${var.project_name}-miniapp"
  description              = "API de solo lectura del dashboard (Telegram Mini App)"
  memory_size              = var.memory_size
  timeout                  = var.timeout
  log_retention_days       = var.log_retention_days
  permissions_boundary_arn = local.boundary_arn

  environment = {
    TABLE_NAME                = data.aws_dynamodb_table.main.name
    TELEGRAM_SECRET_NAME      = data.aws_secretsmanager_secret.telegram.name
    ACCOUNTS_MODEL            = var.accounts_model
    INIT_DATA_MAX_AGE_SECONDS = tostring(var.init_data_max_age_seconds)
  }

  policy_statements = [
    {
      # Solo lectura: el chat es el único canal de escritura.
      sid       = "TableReadOnly"
      actions   = ["dynamodb:GetItem", "dynamodb:Query"]
      resources = [data.aws_dynamodb_table.main.arn, "${data.aws_dynamodb_table.main.arn}/index/*"]
    },
    {
      # bot_token para validar el initData y allowed_chat_id para el usuario.
      sid       = "ReadTelegramSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [data.aws_secretsmanager_secret.telegram.arn]
    },
  ]
}

resource "aws_lambda_function_url" "this" {
  function_name      = module.function.function_name
  authorization_type = "AWS_IAM"
}
