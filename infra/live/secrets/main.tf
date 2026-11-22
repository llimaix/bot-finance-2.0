# Contenedores de secretos agrupados por proveedor. Los valores (JSON con las
# claves de la descripción) se cargan a mano en la consola: nunca pasan por
# Terraform. Las Lambdas reciben solo el nombre y leen el valor con el SDK.
locals {
  secrets = {
    telegram = "Telegram. Claves JSON: bot_token, webhook_secret, allowed_chat_id"
    llm      = "Proveedores LLM. Claves JSON: anthropic_api_key, minimax_api_key"
  }
}

module "secret" {
  source   = "../../modules/secret"
  for_each = local.secrets

  name        = "${var.project_name}/${each.key}"
  description = each.value
}
