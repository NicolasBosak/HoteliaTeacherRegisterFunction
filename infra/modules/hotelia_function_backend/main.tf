data "azurerm_client_config" "current" {}

locals {
  dash_suffix             = var.global_suffix != "" ? "-${var.global_suffix}" : ""
  default_key_vault_name  = "kv-${var.name_prefix}${local.dash_suffix}"
  resolved_key_vault_name = var.key_vault_name != null && var.key_vault_name != "" ? var.key_vault_name : local.default_key_vault_name
}

resource "azurerm_storage_account" "function_storage" {
  name                     = "st${var.project_name}${var.environment}${var.global_suffix}001"
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true

  tags = var.tags
}

resource "azurerm_application_insights" "app_insights" {
  name                = "appi-${var.name_prefix}"
  location            = var.location
  resource_group_name = var.resource_group_name
  application_type    = "web"

  tags = var.tags
}

resource "azurerm_service_plan" "function_plan" {
  name                = "plan-${var.name_prefix}-functions"
  resource_group_name = var.resource_group_name
  location            = var.location

  os_type  = "Windows"
  sku_name = "Y1"

  tags = var.tags
}

resource "azurerm_key_vault" "hotelia_secrets" {
  name                = local.resolved_key_vault_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = data.azurerm_client_config.current.tenant_id

  sku_name = "standard"

  rbac_authorization_enabled = true
  soft_delete_retention_days = var.key_vault_soft_delete_retention_days
  purge_protection_enabled   = var.key_vault_purge_protection

  tags = var.tags
}

# Secret VALUES are intentionally not managed here: they are seeded once via
# `az keyvault secret set` (see repository README) so they never touch git or
# the Terraform state. The app reads them through Key Vault references.
resource "azurerm_windows_function_app" "teacher_api" {
  name                = "func-${var.name_prefix}-teacher-api${local.dash_suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location

  service_plan_id            = azurerm_service_plan.function_plan.id
  storage_account_name       = azurerm_storage_account.function_storage.name
  storage_account_access_key = azurerm_storage_account.function_storage.primary_access_key

  https_only                  = true
  functions_extension_version = "~4"

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      node_version = "~22"
    }

    application_insights_key               = azurerm_application_insights.app_insights.instrumentation_key
    application_insights_connection_string = azurerm_application_insights.app_insights.connection_string
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME = "node"

    PLAYFAB_TITLE_ID = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.hotelia_secrets.name};SecretName=PLAYFAB-TITLE-ID)"

    PLAYFAB_SECRET_KEY = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.hotelia_secrets.name};SecretName=PLAYFAB-SECRET-KEY)"

    TEACHER_ACCESS_CODE = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.hotelia_secrets.name};SecretName=TEACHER-ACCESS-CODE)"

    OPENAI_API_KEY = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.hotelia_secrets.name};SecretName=OPENAI-API-KEY)"

    OPENAI_MODEL = var.openai_model

    HOTELIA_ENVIRONMENT = var.environment

    WEBSITE_RUN_FROM_PACKAGE = "1"
  }

  tags = var.tags
}

resource "azurerm_role_assignment" "function_key_vault_secrets_user" {
  scope                = azurerm_key_vault.hotelia_secrets.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_windows_function_app.teacher_api.identity[0].principal_id
}
