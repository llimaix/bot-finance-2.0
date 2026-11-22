variable "name" {
  description = "Nombre de la HTTP API."
  type        = string
}

variable "route_key" {
  description = "Ruta expuesta, formato \"MÉTODO /ruta\"."
  type        = string
  default     = "POST /webhook"

  validation {
    condition     = can(regex("^(GET|POST|PUT|PATCH|DELETE) /[A-Za-z0-9/_-]*$", var.route_key))
    error_message = "Formato esperado: \"MÉTODO /ruta\" (p. ej. \"POST /webhook\")."
  }
}

variable "lambda_function_name" {
  description = "Nombre de la Lambda que atiende la ruta."
  type        = string
}

variable "lambda_invoke_arn" {
  description = "Invoke ARN de la Lambda que atiende la ruta."
  type        = string
}

variable "throttling_rate_limit" {
  description = "Peticiones por segundo sostenidas permitidas en el stage."
  type        = number
  default     = 5
}

variable "throttling_burst_limit" {
  description = "Ráfaga máxima de peticiones permitida en el stage."
  type        = number
  default     = 10
}

variable "tags" {
  description = "Tags adicionales a los default_tags del provider."
  type        = map(string)
  default     = {}
}
