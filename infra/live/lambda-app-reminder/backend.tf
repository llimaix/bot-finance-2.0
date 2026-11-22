terraform {
  backend "s3" {
    bucket       = "bot-finance-tfstate"
    key          = "live/lambda-app-reminder/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
