variable "name" {
  description = "Prefijo de los recursos (bucket <name>-<cuenta>, OAC y políticas)."
  type        = string
}

variable "domain_name" {
  description = "Dominio público del sitio (alias de CloudFront y certificado ACM)."
  type        = string
}

variable "hosted_zone_name" {
  description = "Hosted zone pública de Route 53 que contiene domain_name."
  type        = string
}

variable "price_class" {
  description = "Clase de precio de CloudFront."
  type        = string
  default     = "PriceClass_100"
}

variable "content_security_policy" {
  description = "Cabecera Content-Security-Policy que CloudFront añade a cada respuesta."
  type        = string
}

variable "api_origin" {
  description = "Origen opcional de API: Lambda Function URL (auth AWS_IAM) servida en path_pattern y firmada con OAC. null = sitio solo estático."
  type = object({
    function_name = string
    function_url  = string
    path_pattern  = string
  })
  default = null
}

variable "noncurrent_version_days" {
  description = "Días que se conservan las versiones anteriores de los archivos (rollback)."
  type        = number
  default     = 30
}
