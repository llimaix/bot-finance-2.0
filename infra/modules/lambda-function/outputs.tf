output "function_name" {
  description = "Nombre de la función."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN de la función."
  value       = aws_lambda_function.this.arn
}

output "invoke_arn" {
  description = "ARN de invocación (integraciones de API Gateway)."
  value       = aws_lambda_function.this.invoke_arn
}

output "role_name" {
  description = "Nombre del rol de ejecución (lo usa el kill switch del budget)."
  value       = aws_iam_role.this.name
}

output "log_group_name" {
  description = "Log group de la función."
  value       = aws_cloudwatch_log_group.this.name
}
