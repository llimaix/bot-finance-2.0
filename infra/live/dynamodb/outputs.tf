output "table_name" {
  description = "Nombre de la tabla (las Lambdas la leen con data \"aws_dynamodb_table\")."
  value       = module.table.name
}

output "table_arn" {
  description = "ARN de la tabla."
  value       = module.table.arn
}
