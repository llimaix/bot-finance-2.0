output "bucket_name" {
  description = "Bucket privado donde el pipeline sube el build del sitio."
  value       = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  description = "ID de la distribución (invalidaciones tras cada despliegue)."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "ARN de la distribución."
  value       = aws_cloudfront_distribution.this.arn
}

output "url" {
  description = "URL pública del sitio."
  value       = "https://${var.domain_name}"
}
