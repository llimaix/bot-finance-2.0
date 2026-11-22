# Sin SSE: CloudWatch no puede publicar en tópicos cifrados con la clave
# administrada aws/sns, y por aquí solo viajan metadatos de alarmas.
resource "aws_sns_topic" "this" {
  name         = var.name
  display_name = var.display_name
  tags         = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.this.arn
  protocol  = "email"
  endpoint  = var.email
}
