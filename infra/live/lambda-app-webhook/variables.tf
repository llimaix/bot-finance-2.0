variable "aws_region" {
  description = "Región de AWS donde vive el proyecto."
  type        = string
}

variable "project_name" {
  description = "Nombre del proyecto: prefijo de todos los recursos y valor del tag Project."
  type        = string
}

variable "environment" {
  description = "Entorno (valor del tag Environment)."
  type        = string
}

variable "repository" {
  description = "Repositorio de GitHub que gestiona la infraestructura (valor del tag Repository)."
  type        = string
}

variable "memory_size" {
  description = "Memoria de la función en MB."
  type        = number
}

variable "timeout" {
  description = "Timeout de la función en segundos (debe responder a Telegram rápido)."
  type        = number
}

variable "log_retention_days" {
  description = "Días de retención de los logs."
  type        = number
}
