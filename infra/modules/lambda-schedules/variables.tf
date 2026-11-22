variable "group_name" {
  description = "Nombre del grupo de schedules (debe coincidir con los permisos del rol de despliegue)."
  type        = string
}

variable "role_name" {
  description = "Nombre del rol que asume EventBridge Scheduler para invocar las Lambdas."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "ARN del permissions boundary obligatorio para el rol."
  type        = string
}

variable "timezone" {
  description = "Zona horaria IANA de las expresiones cron."
  type        = string
  default     = "America/Guatemala"
}

variable "schedules" {
  description = "Schedules por nombre: cron (sin el envoltorio cron()), Lambda destino y payload JSON."
  type = map(object({
    description    = string
    cron           = string
    function_arn   = string
    input          = string
    retry_attempts = optional(number, 2)
  }))
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider (los schedules no admiten tags; el grupo y el rol sí)."
  type        = map(string)
  default     = {}
}
