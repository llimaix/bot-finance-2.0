output "function_name" {
  description = "Nombre de la función (lo invoca el scheduler y lo usa el pipeline de código)."
  value       = module.function.function_name
}

output "function_arn" {
  description = "ARN de la función."
  value       = module.function.function_arn
}

output "role_name" {
  description = "Rol de ejecución (kill switch del budget)."
  value       = module.function.role_name
}
