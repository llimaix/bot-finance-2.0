output "alerts_topic_arn" {
  description = "Tópico de alertas (lo reutiliza el root budget)."
  value       = module.topic.topic_arn
}

output "alarm_names" {
  description = "Alarmas de errores creadas."
  value       = module.lambda_alarms.alarm_names
}
