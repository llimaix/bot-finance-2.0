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
  description = "Timeout de la función en segundos (agente, visión y voz)."
  type        = number
}

variable "log_retention_days" {
  description = "Días de retención de los logs."
  type        = number
}

variable "llm_provider" {
  description = "Proveedor de IA (anthropic o minimax); los modelos se resuelven por proveedor en config.ts."
  type        = string

  validation {
    condition     = contains(["anthropic", "minimax"], var.llm_provider)
    error_message = "Debe ser anthropic o minimax."
  }
}
