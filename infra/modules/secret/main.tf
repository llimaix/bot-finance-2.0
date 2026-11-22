# Solo el contenedor: el valor (aws_secretsmanager_secret_version) se carga a
# mano para que nunca pase por el código, el plan ni el state de Terraform.
resource "aws_secretsmanager_secret" "this" {
  name                    = var.name
  description             = var.description
  recovery_window_in_days = var.recovery_window_in_days
  kms_key_id              = var.kms_key_id
  tags                    = var.tags
}
