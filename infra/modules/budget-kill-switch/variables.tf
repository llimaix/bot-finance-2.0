variable "name" {
  description = "Nombre del budget (debe coincidir con los permisos del rol de despliegue)."
  type        = string
}

variable "monthly_limit_usd" {
  description = "Tope mensual en USD: al superarlo se aplica el kill switch."
  type        = number

  validation {
    condition     = var.monthly_limit_usd > 0
    error_message = "Debe ser mayor que 0."
  }
}

variable "notification_thresholds" {
  description = "Porcentajes del tope (gasto real) que disparan un correo de aviso."
  type        = list(number)
  default     = [50, 80, 100]
}

variable "cost_filter_tag" {
  description = "Tag de asignación de costos que filtra el budget (clave y valor)."
  type = object({
    key   = string
    value = string
  })
}

variable "alert_email" {
  description = "Correo para avisos del budget y del kill switch."
  type        = string
  sensitive   = true
}

variable "kill_switch_policy_name" {
  description = "Nombre de la política Deny-all (el boundary solo permite adjuntar esta)."
  type        = string
}

variable "action_role_name" {
  description = "Nombre del rol que asume AWS Budgets para aplicar o retirar el kill switch."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "ARN del permissions boundary obligatorio para el rol."
  type        = string
}

variable "target_role_names" {
  description = "Roles a los que se adjunta el kill switch (los de ejecución de las Lambdas)."
  type        = list(string)
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider."
  type        = map(string)
  default     = {}
}
