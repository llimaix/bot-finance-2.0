output "function_name" {
  description = "Nombre de la función (integración de API Gateway y pipeline de código)."
  value       = module.function.function_name
}

output "function_arn" {
  description = "ARN de la función."
  value       = module.function.function_arn
}

output "invoke_arn" {
  description = "ARN de invocación para la integración de API Gateway."
  value       = module.function.invoke_arn
}

output "role_name" {
  description = "Rol de ejecución (kill switch del budget)."
  value       = module.function.role_name
}
