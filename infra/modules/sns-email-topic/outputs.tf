output "topic_arn" {
  description = "ARN del tópico."
  value       = aws_sns_topic.this.arn
}

output "topic_name" {
  description = "Nombre del tópico."
  value       = aws_sns_topic.this.name
}
