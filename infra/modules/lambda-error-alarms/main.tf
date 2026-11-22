# Una alarma por Lambda: los errores dejan de fallar en silencio.
resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each = var.function_names

  alarm_name          = "${var.name_prefix}-${each.key}-errors"
  alarm_description   = "Errores en la Lambda ${each.value}"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = var.period_seconds
  evaluation_periods  = 1
  threshold           = var.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
  ok_actions    = [var.alarm_topic_arn]

  tags = var.tags
}
