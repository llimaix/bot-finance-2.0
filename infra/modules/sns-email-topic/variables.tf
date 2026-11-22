variable "name" {
  description = "Nombre del tópico SNS."
  type        = string
}

variable "display_name" {
  description = "Nombre visible en los correos de SNS."
  type        = string
}

variable "email" {
  description = "Correo suscrito al tópico. SNS envía un correo de confirmación que hay que aceptar."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.email))
    error_message = "Debe ser un correo válido."
  }
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider."
  type        = map(string)
  default     = {}
}
