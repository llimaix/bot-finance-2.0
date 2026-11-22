# Tabla single-table del bot: movimientos, cuentas, categorías, memoria del
# agente y dedupe de updates de Telegram (mismo esquema que la versión CDK).
module "table" {
  source = "../../modules/dynamodb-table"

  name          = "${var.project_name}-finanzas"
  hash_key      = "PK"
  range_key     = "SK"
  ttl_attribute = "ttl"
}
