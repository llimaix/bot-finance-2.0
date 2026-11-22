output "budget_name" {
  description = "Nombre del budget."
  value       = aws_budgets_budget.this.name
}

output "kill_switch_policy_arn" {
  description = "ARN de la política Deny-all (para retirarla a mano si hiciera falta re-armar el bot)."
  value       = aws_iam_policy.kill_switch.arn
}

output "action_id" {
  description = "ID de la budget action (para resetearla tras un disparo)."
  value       = aws_budgets_budget_action.kill_switch.action_id
}
