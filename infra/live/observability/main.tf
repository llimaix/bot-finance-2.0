# Alertas: tópico SNS con suscripción por correo y una alarma de errores por
# Lambda. Las funciones se leen por nombre (data) para fallar en el plan si
# alguna no existe.
locals {
  functions = {
    webhook        = "${var.project_name}-webhook"
    processor      = "${var.project_name}-processor"
    reminder       = "${var.project_name}-reminder"
    monthly-report = "${var.project_name}-monthly-report"
  }
}

data "aws_lambda_function" "watched" {
  for_each      = local.functions
  function_name = each.value
}

module "topic" {
  source = "../../modules/sns-email-topic"

  name         = "${var.project_name}-alerts"
  display_name = "${var.project_name} alertas"
  email        = var.alert_email
}

module "lambda_alarms" {
  source = "../../modules/lambda-error-alarms"

  name_prefix     = var.project_name
  function_names  = { for k, f in data.aws_lambda_function.watched : k => f.function_name }
  alarm_topic_arn = module.topic.topic_arn
}
