variable "name" {
  description = "Nombre de la función. Debe empezar con el prefijo del proyecto (permisos del rol de despliegue y del boundary)."
  type        = string
}

variable "description" {
  description = "Descripción de la función."
  type        = string
}

variable "handler" {
  description = "Handler en el bundle que despliega el pipeline de código."
  type        = string
  default     = "index.handler"
}

variable "runtime" {
  description = "Runtime de Lambda."
  type        = string
  default     = "nodejs24.x"
}

variable "architecture" {
  description = "Arquitectura de la función."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "Debe ser arm64 o x86_64."
  }
}

variable "memory_size" {
  description = "Memoria en MB."
  type        = number
  default     = 256
}

variable "timeout" {
  description = "Timeout en segundos."
  type        = number

  validation {
    condition     = var.timeout >= 1 && var.timeout <= 900
    error_message = "Debe estar entre 1 y 900 segundos."
  }
}

variable "environment" {
  description = "Variables de entorno. Nunca valores secretos: solo nombres de secretos y configuración."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  description = "Días de retención del log group."
  type        = number
  default     = 30
}

variable "permissions_boundary_arn" {
  description = "ARN del permissions boundary obligatorio para el rol de la función."
  type        = string
}

variable "policy_statements" {
  description = "Permisos adicionales del rol (además de escribir en su propio log group)."
  type = list(object({
    sid       = string
    actions   = list(string)
    resources = list(string)
  }))
  default = []
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider."
  type        = map(string)
  default     = {}
}
