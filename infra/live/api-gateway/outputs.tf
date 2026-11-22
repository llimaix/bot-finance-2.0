output "webhook_url" {
  description = "URL a registrar en Telegram con setWebhook."
  value       = module.api.url
}

output "api_id" {
  description = "ID de la HTTP API."
  value       = module.api.api_id
}
