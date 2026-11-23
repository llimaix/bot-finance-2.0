output "bucket_name" {
  description = "Bucket donde el pipeline sube el build del frontend."
  value       = module.site.bucket_name
}

output "distribution_id" {
  description = "Distribución a invalidar tras cada despliegue del frontend."
  value       = module.site.distribution_id
}

output "url" {
  description = "URL de la Mini App (se registra en el botón de menú del bot)."
  value       = module.site.url
}
