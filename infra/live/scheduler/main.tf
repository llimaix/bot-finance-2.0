# Schedules en hora de Guatemala (mismos que la versión CDK). Las Lambdas
# destino se leen por nombre.
data "aws_caller_identity" "current" {}

data "aws_lambda_function" "reminder" {
  function_name = "${var.project_name}-reminder"
}

data "aws_lambda_function" "monthly_report" {
  function_name = "${var.project_name}-monthly-report"
}

locals {
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/boundary-${var.project_name}"
  reminder     = data.aws_lambda_function.reminder.arn
}

module "schedules" {
  source = "../../modules/lambda-schedules"

  group_name               = var.project_name
  role_name                = "${var.project_name}-scheduler-role"
  permissions_boundary_arn = local.boundary_arn
  timezone                 = var.timezone

  schedules = {
    payday-checkpoint = {
      # Corre a diario; el handler decide si mañana es día de pago (15 y fin de mes, día hábil).
      description  = "Plan de quincena 08:00 (solo habla en víspera de pago)"
      cron         = "0 8 * * ? *"
      function_arn = local.reminder
      input        = jsonencode({ kind = "payday" })
    }
    daily-guardian = {
      description  = "Guardián financiero 08:30 (solo habla si hay hallazgos)"
      cron         = "30 8 * * ? *"
      function_arn = local.reminder
      input        = jsonencode({ kind = "guardian" })
    }
    reminder-primary = {
      description  = "Recordatorio diario 17:00"
      cron         = "0 17 * * ? *"
      function_arn = local.reminder
      input        = jsonencode({ kind = "primary" })
    }
    reminder-followup = {
      description  = "Seguimiento 21:00 si no hubo respuesta"
      cron         = "0 21 * * ? *"
      function_arn = local.reminder
      input        = jsonencode({ kind = "followup" })
    }
    weekly-summary = {
      description  = "Resumen semanal y coach, domingo 20:00"
      cron         = "0 20 ? * SUN *"
      function_arn = local.reminder
      input        = jsonencode({ kind = "weekly" })
    }
    monthly-report = {
      description  = "Reporte del mes cerrado, día 1 08:00"
      cron         = "0 8 1 * ? *"
      function_arn = data.aws_lambda_function.monthly_report.arn
      input        = jsonencode({ kind = "monthly" })
    }
  }
}
