output "function_name" {
  description = "Nombre de la función (lo usa el pipeline de código y el root miniapp-web)."
  value       = module.function.function_name
}

output "function_url" {
  description = "Function URL (AWS_IAM): solo invocable a través de CloudFront."
  value       = aws_lambda_function_url.this.function_url
}

output "role_name" {
  description = "Rol de ejecución (kill switch del budget)."
  value       = module.function.role_name
}
