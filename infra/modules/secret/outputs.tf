output "name" {
  description = "Nombre del secreto."
  value       = aws_secretsmanager_secret.this.name
}

output "arn" {
  description = "ARN del secreto."
  value       = aws_secretsmanager_secret.this.arn
}
