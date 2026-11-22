variable "name" {
  description = "Nombre del secreto (p. ej. bot-finance/telegram). El valor se carga a mano; este módulo nunca lo gestiona."
  type        = string
}

variable "description" {
  description = "Descripción del secreto: qué claves contiene, sin valores."
  type        = string
}

variable "recovery_window_in_days" {
  description = "Días para recuperar el secreto tras borrarlo (0 = inmediato, o entre 7 y 30)."
  type        = number
  default     = 7

  validation {
    condition     = var.recovery_window_in_days == 0 || (var.recovery_window_in_days >= 7 && var.recovery_window_in_days <= 30)
    error_message = "Debe ser 0 o un valor entre 7 y 30."
  }
}

variable "kms_key_id" {
  description = "KMS key para cifrar el secreto. null usa la clave administrada aws/secretsmanager."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider."
  type        = map(string)
  default     = {}
}
