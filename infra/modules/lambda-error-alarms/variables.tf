variable "name_prefix" {
  description = "Prefijo del nombre de las alarmas (debe coincidir con los permisos del rol de despliegue)."
  type        = string
}

variable "function_names" {
  description = "Lambdas vigiladas: clave corta → nombre de la función."
  type        = map(string)
}

variable "alarm_topic_arn" {
  description = "Tópico SNS al que se notifica la alarma y su recuperación."
  type        = string
}

variable "period_seconds" {
  description = "Ventana de evaluación de la métrica Errors."
  type        = number
  default     = 300
}

variable "threshold" {
  description = "Errores en la ventana a partir de los cuales salta la alarma."
  type        = number
  default     = 1
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider."
  type        = map(string)
  default     = {}
}
