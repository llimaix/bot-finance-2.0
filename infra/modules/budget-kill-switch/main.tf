data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  # Formato del filtro de Budgets: "user:<Clave>$<Valor>".
  tag_filter = format("user:%s$%s", var.cost_filter_tag.key, var.cost_filter_tag.value)
}

# ── Budget con avisos por correo ──────────────────────────────────────────
resource "aws_budgets_budget" "this" {
  name         = var.name
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [local.tag_filter]
  }

  dynamic "notification" {
    for_each = var.notification_thresholds
    content {
      notification_type          = "ACTUAL"
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  tags = var.tags
}

# ── Kill switch: Deny-all que Budgets adjunta a los roles de las Lambdas ──
resource "aws_iam_policy" "kill_switch" {
  name        = var.kill_switch_policy_name
  description = "Kill switch del budget ${var.name}: deniega todo a los roles de las Lambdas"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Deny", Action = "*", Resource = "*" }]
  })
  tags = var.tags
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "action" {
  name                 = var.action_role_name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

data "aws_iam_policy_document" "action" {
  statement {
    sid       = "AttachKillSwitchOnly"
    actions   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    resources = [for r in var.target_role_names : "arn:aws:iam::${local.account_id}:role/${r}"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [aws_iam_policy.kill_switch.arn]
    }
  }
}

resource "aws_iam_role_policy" "action" {
  name   = "${var.action_role_name}-policy"
  role   = aws_iam_role.action.id
  policy = data.aws_iam_policy_document.action.json
}

resource "aws_budgets_budget_action" "kill_switch" {
  budget_name        = aws_budgets_budget.this.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.action.arn

  action_threshold {
    action_threshold_type  = "ABSOLUTE_VALUE"
    action_threshold_value = var.monthly_limit_usd
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.kill_switch.arn
      roles      = var.target_role_names
    }
  }

  subscriber {
    address           = var.alert_email
    subscription_type = "EMAIL"
  }

  depends_on = [aws_iam_role_policy.action]
}
