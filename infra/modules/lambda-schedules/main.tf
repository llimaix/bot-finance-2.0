data "aws_caller_identity" "current" {}

locals {
  target_arns = distinct([for s in values(var.schedules) : s.function_arn])
}

resource "aws_scheduler_schedule_group" "this" {
  name = var.group_name
  tags = var.tags
}

# ── Rol que asume EventBridge Scheduler ───────────────────────────────────
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.role_name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

data "aws_iam_policy_document" "invoke" {
  statement {
    sid       = "InvokeTargets"
    actions   = ["lambda:InvokeFunction"]
    resources = local.target_arns
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.role_name}-invoke"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.invoke.json
}

# ── Schedules ─────────────────────────────────────────────────────────────
resource "aws_scheduler_schedule" "this" {
  for_each = var.schedules

  name                         = each.key
  group_name                   = aws_scheduler_schedule_group.this.name
  description                  = each.value.description
  schedule_expression          = "cron(${each.value.cron})"
  schedule_expression_timezone = var.timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = each.value.function_arn
    role_arn = aws_iam_role.this.arn
    input    = each.value.input

    retry_policy {
      maximum_retry_attempts = each.value.retry_attempts
    }
  }

  depends_on = [aws_iam_role_policy.this]
}
