terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.5" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
}
