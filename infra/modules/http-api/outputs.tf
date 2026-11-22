output "api_id" {
  description = "ID de la HTTP API."
  value       = aws_apigatewayv2_api.this.id
}

output "api_endpoint" {
  description = "Endpoint base de la HTTP API."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "url" {
  description = "URL completa de la ruta (endpoint + ruta)."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}${local.route_path}"
}
