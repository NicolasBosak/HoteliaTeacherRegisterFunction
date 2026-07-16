output "resource_group_name" {
  value = azurerm_resource_group.rg.name
}

output "function_app_name" {
  value = module.teacher_api_backend.function_app_name
}

output "function_app_url" {
  value = module.teacher_api_backend.function_app_url
}

output "teacher_api_base_url" {
  value = module.teacher_api_backend.teacher_api_base_url
}

output "application_insights_name" {
  value = module.teacher_api_backend.application_insights_name
}

output "storage_account_name" {
  value = module.teacher_api_backend.storage_account_name
}

output "key_vault_name" {
  value = module.teacher_api_backend.key_vault_name
}

output "function_app_principal_id" {
  description = "Managed identity of the Function App (already granted Key Vault Secrets User)."
  value       = module.teacher_api_backend.function_app_principal_id
}
