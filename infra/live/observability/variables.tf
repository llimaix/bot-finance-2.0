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

variable "alert_email" {
  description = "Correo para alertas. Llega por TF_VAR_alert_email desde el GitHub secret ALERT_EMAIL; nunca en tfvars (repo público)."
  type        = string
  sensitive   = true
}
