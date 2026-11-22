# HTTP API que recibe el webhook de Telegram. La Lambda se lee por nombre.
data "aws_lambda_function" "webhook" {
  function_name = "${var.project_name}-webhook"
}

module "api" {
  source = "../../modules/http-api"

  name                   = "${var.project_name}-webhook"
  route_key              = "POST /webhook"
  lambda_function_name   = data.aws_lambda_function.webhook.function_name
  lambda_invoke_arn      = data.aws_lambda_function.webhook.invoke_arn
  throttling_rate_limit  = var.throttling_rate_limit
  throttling_burst_limit = var.throttling_burst_limit
}
