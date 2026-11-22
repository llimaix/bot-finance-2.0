variable "name" {
  description = "Nombre de la tabla. Debe empezar con el prefijo del proyecto para caber en los permisos del rol de despliegue."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9_.-]{3,255}$", var.name))
    error_message = "El nombre debe tener entre 3 y 255 caracteres: letras, números, '_', '-' o '.'."
  }
}

variable "hash_key" {
  description = "Atributo de partición (tipo String)."
  type        = string
  default     = "PK"
}

variable "range_key" {
  description = "Atributo de ordenamiento (tipo String). null para tablas sin sort key."
  type        = string
  default     = "SK"
}

variable "ttl_attribute" {
  description = "Atributo con la fecha de expiración (epoch en segundos). null desactiva el TTL."
  type        = string
  default     = null
}

variable "point_in_time_recovery" {
  description = "Habilita PITR (restauración a cualquier segundo de los últimos 35 días)."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Impide borrar la tabla, incluso con terraform destroy, hasta desactivarlo explícitamente."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider."
  type        = map(string)
  default     = {}
}
