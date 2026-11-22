# ── Código inicial ────────────────────────────────────────────────────────
# Terraform crea la función con placeholder.zip (versionado en este módulo,
# para que exista también en el job de apply) y nunca vuelve a tocar el
# código: lo despliega el pipeline de Lambdas (update-function-code).
locals {
  placeholder_zip = "${path.module}/placeholder.zip"
}

# ── Logs ──────────────────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# ── Rol de ejecución ──────────────────────────────────────────────────────
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = "${var.name}-role"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

data "aws_iam_policy_document" "this" {
  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = var.policy_statements
    content {
      sid       = statement.value.sid
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.name}-policy"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.this.json
}

# ── Función ───────────────────────────────────────────────────────────────
resource "aws_lambda_function" "this" {
  function_name    = var.name
  description      = var.description
  role             = aws_iam_role.this.arn
  handler          = var.handler
  runtime          = var.runtime
  architectures    = [var.architecture]
  memory_size      = var.memory_size
  timeout          = var.timeout
  filename         = local.placeholder_zip
  source_code_hash = filebase64sha256(local.placeholder_zip)

  environment {
    variables = var.environment
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  tags = var.tags

  lifecycle {
    # El código lo gestiona el pipeline de Lambdas, no Terraform.
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_iam_role_policy.this]
}
