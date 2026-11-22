terraform {
  backend "s3" {
    bucket       = "bot-finance-tfstate"
    key          = "live/budget/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
