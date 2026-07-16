terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  # Remote state with locking. Initialize per environment:
  #   terraform init -backend-config=envs/dev.backend.hcl
  backend "azurerm" {}
}

provider "azurerm" {
  features {}

  # Student subscriptions cannot auto-register every resource provider.
  # The handful we need are registered once via `az provider register`
  # (see infra/scripts/bootstrap-remote-state.ps1 and the README).
  resource_provider_registrations = "none"
}
