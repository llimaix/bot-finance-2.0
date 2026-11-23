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

variable "domain_name" {
  description = "Dominio público de la Mini App."
  type        = string
}

variable "hosted_zone_name" {
  description = "Hosted zone pública de Route 53 que contiene domain_name."
  type        = string
}

variable "enable_api" {
  description = "Sirve la API de solo lectura (Lambda bot-finance-miniapp) bajo /api/*. Requiere que el root lambda-app-miniapp ya esté aplicado."
  type        = bool
}
