output "group_name" {
  description = "Nombre del grupo de schedules."
  value       = aws_scheduler_schedule_group.this.name
}

output "role_name" {
  description = "Rol que asume EventBridge Scheduler."
  value       = aws_iam_role.this.name
}

output "schedule_names" {
  description = "Nombres de los schedules creados."
  value       = keys(aws_scheduler_schedule.this)
}
