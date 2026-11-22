output "group_name" {
  description = "Grupo de schedules."
  value       = module.schedules.group_name
}

output "schedule_names" {
  description = "Schedules creados."
  value       = module.schedules.schedule_names
}

output "role_name" {
  description = "Rol de EventBridge Scheduler."
  value       = module.schedules.role_name
}
