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

variable "throttling_rate_limit" {
  description = "Peticiones por segundo sostenidas permitidas (bot de un solo usuario)."
  type        = number
}

variable "throttling_burst_limit" {
  description = "Ráfaga máxima de peticiones permitida."
  type        = number
}
