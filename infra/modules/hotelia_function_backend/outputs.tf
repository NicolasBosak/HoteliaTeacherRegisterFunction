output "function_app_name" {
  value = azurerm_windows_function_app.teacher_api.name
}

output "function_app_url" {
  value = "https://${azurerm_windows_function_app.teacher_api.default_hostname}"
}

output "teacher_api_base_url" {
  value = "https://${azurerm_windows_function_app.teacher_api.default_hostname}/api"
}

output "application_insights_name" {
  value = azurerm_application_insights.app_insights.name
}

output "storage_account_name" {
  value = azurerm_storage_account.function_storage.name
}

output "key_vault_name" {
  value = azurerm_key_vault.hotelia_secrets.name
}

output "function_app_principal_id" {
  value = azurerm_windows_function_app.teacher_api.identity[0].principal_id
}
