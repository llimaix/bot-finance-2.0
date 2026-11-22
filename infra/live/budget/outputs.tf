output "budget_name" {
  description = "Nombre del budget."
  value       = module.budget.budget_name
}

output "kill_switch_policy_arn" {
  description = "Política Deny-all: retirarla de los roles para re-armar el bot tras un disparo."
  value       = module.budget.kill_switch_policy_arn
}

output "guarded_roles" {
  description = "Roles a los que se aplica el kill switch."
  value       = local.lambda_role_names
}
