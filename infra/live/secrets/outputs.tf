output "secret_names" {
  description = "Nombres de los secretos (las Lambdas los leen con data \"aws_secretsmanager_secret\")."
  value       = { for k, s in module.secret : k => s.name }
}

output "secret_arns" {
  description = "ARN de cada secreto."
  value       = { for k, s in module.secret : k => s.arn }
}
