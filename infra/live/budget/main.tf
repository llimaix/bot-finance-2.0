# Presupuesto del gasto etiquetado con Project=<proyecto> y kill switch sobre
# los roles de las Lambdas. Las funciones se leen por nombre (data).
data "aws_caller_identity" "current" {}

data "aws_lambda_function" "guarded" {
  for_each      = toset(["webhook", "processor", "reminder", "monthly-report"])
  function_name = "${var.project_name}-${each.key}"
}

locals {
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/boundary-${var.project_name}"
  # Nombre del rol a partir de su ARN (arn:aws:iam::<cuenta>:role/<nombre>).
  lambda_role_names = sort([for f in data.aws_lambda_function.guarded : element(split("/", f.role), length(split("/", f.role)) - 1)])
}

# Configuración de toda la cuenta: sin esto el filtro por tag del budget no ve
# gasto. También desglosa por Project el gasto de otros proyectos de la cuenta.
resource "aws_ce_cost_allocation_tag" "project" {
  tag_key = "Project"
  status  = "Active"
}

module "budget" {
  source = "../../modules/budget-kill-switch"

  name                     = "${var.project_name}-mensual"
  monthly_limit_usd        = var.monthly_limit_usd
  cost_filter_tag          = { key = "Project", value = var.project_name }
  alert_email              = var.alert_email
  kill_switch_policy_name  = "${var.project_name}-kill-switch"
  action_role_name         = "${var.project_name}-budget-action-role"
  permissions_boundary_arn = local.boundary_arn
  target_role_names        = local.lambda_role_names

  depends_on = [aws_ce_cost_allocation_tag.project]
}
