# Solo el ruleset de Terraform que trae TFLint integrado (no descarga plugins).
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
