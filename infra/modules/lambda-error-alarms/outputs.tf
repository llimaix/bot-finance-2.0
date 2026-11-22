output "alarm_names" {
  description = "Nombres de las alarmas creadas."
  value       = [for a in aws_cloudwatch_metric_alarm.errors : a.alarm_name]
}
