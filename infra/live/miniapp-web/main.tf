# Mini App de Telegram: sitio estático privado en S3 servido por CloudFront,
# con la API de solo lectura (Lambda Function URL, AWS_IAM + OAC) bajo /api/*.
# La función se lee por nombre: el root lambda-app-miniapp va antes. El
# pipeline planea todos los roots antes de aplicar, así que la API se activa
# (enable_api) en un cambio posterior, cuando la función ya existe.
data "aws_lambda_function_url" "api" {
  count         = var.enable_api ? 1 : 0
  function_name = "${var.project_name}-miniapp"
}

module "site" {
  source = "../../modules/static-site"

  name             = "${var.project_name}-miniapp"
  domain_name      = var.domain_name
  hosted_zone_name = var.hosted_zone_name

  # telegram-web-app.js se carga desde telegram.org; frame-ancestors permite
  # abrir la Mini App dentro de Telegram Web.
  content_security_policy = join("; ", [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  ])

  api_origin = var.enable_api ? {
    function_name = data.aws_lambda_function_url.api[0].function_name
    function_url  = data.aws_lambda_function_url.api[0].function_url
    path_pattern  = "/api/*"
  } : null
}
