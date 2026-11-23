# Sitio estático privado: S3 sin acceso público servido solo por CloudFront
# (OAC), TLS con ACM validado por DNS y alias en Route 53. Opcionalmente, una
# Lambda Function URL (AWS_IAM) como origen de API, también firmada con OAC:
# nadie puede invocar la URL ni leer el bucket sin pasar por la distribución.
data "aws_caller_identity" "current" {}

data "aws_route53_zone" "this" {
  name         = var.hosted_zone_name
  private_zone = false
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

locals {
  s3_origin_id  = "s3-site"
  api_origin_id = "lambda-api"

  # https://<id>.lambda-url.<región>.on.aws/ → <id>.lambda-url.<región>.on.aws
  api_domain = var.api_origin == null ? null : trimsuffix(trimprefix(var.api_origin.function_url, "https://"), "/")
}

# ── Bucket privado ─────────────────────────────────────────────────────────

resource "aws_s3_bucket" "site" {
  bucket = "${var.name}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3: con SSE-KMS, CloudFront necesitaría además permiso sobre la llave.
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  depends_on = [aws_s3_bucket_versioning.site]
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "CloudFrontOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket     = aws_s3_bucket.site.id
  policy     = data.aws_iam_policy_document.site.json
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ── Certificado (us-east-1, requisito de CloudFront) ───────────────────────

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

# ── CloudFront ─────────────────────────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.name}-s3"
  description                       = "Acceso de CloudFront al bucket del sitio"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "lambda" {
  count                             = var.api_origin == null ? 0 : 1
  name                              = "${var.name}-lambda"
  description                       = "Firma SigV4 de CloudFront hacia la Function URL de la API"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.name}-security"
  comment = "HSTS, CSP, nosniff y referrer para el sitio"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    content_security_policy {
      content_security_policy = var.content_security_policy
      override                = true
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = var.name
  aliases             = [var.domain_name]
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = var.price_class

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  dynamic "origin" {
    for_each = var.api_origin == null ? [] : [var.api_origin]
    content {
      origin_id                = local.api_origin_id
      domain_name              = local.api_domain
      origin_access_control_id = aws_cloudfront_origin_access_control.lambda[0].id
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # API de solo lectura: sin caché y solo GET (OAC hacia Lambda exige firmar
  # el cuerpo en POST/PUT; la API no los necesita).
  dynamic "ordered_cache_behavior" {
    for_each = var.api_origin == null ? [] : [var.api_origin]
    content {
      path_pattern               = ordered_cache_behavior.value.path_pattern
      target_origin_id           = local.api_origin_id
      viewer_protocol_policy     = "https-only"
      allowed_methods            = ["GET", "HEAD", "OPTIONS"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.this.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# La Function URL (AWS_IAM) solo acepta a ESTA distribución. Desde octubre de
# 2025 Lambda exige ambos permisos para Function URLs.
resource "aws_lambda_permission" "cloudfront_url" {
  count                  = var.api_origin == null ? 0 : 1
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.api_origin.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.this.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_invoke" {
  count         = var.api_origin == null ? 0 : 1
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = var.api_origin.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.this.arn
}

# ── DNS ────────────────────────────────────────────────────────────────────

resource "aws_route53_record" "alias" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
