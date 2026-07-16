locals {
  name_prefix = "${var.project_name}-${var.environment}"

  tags = {
    project     = "Hotelia"
    environment = var.environment
    managed_by  = "Terraform"
    purpose     = "Unity teacher panel and PlayFab integration"
  }
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-${local.name_prefix}"
  location = var.azure_region

  tags = local.tags
}

module "teacher_api_backend" {
  source = "./modules/hotelia_function_backend"

  name_prefix         = local.name_prefix
  project_name        = var.project_name
  environment         = var.environment
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  key_vault_name      = var.key_vault_name
  global_suffix       = var.global_suffix

  openai_model = var.openai_model

  key_vault_purge_protection           = var.key_vault_purge_protection
  key_vault_soft_delete_retention_days = var.key_vault_soft_delete_retention_days

  tags = local.tags
}
