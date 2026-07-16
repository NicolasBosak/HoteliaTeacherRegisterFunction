variable "name_prefix" {
  type        = string
  description = "Prefix used for resource names (project-environment)."
}

variable "project_name" {
  type        = string
  description = "Project name used for resource names that disallow dashes."
}

variable "environment" {
  type        = string
  description = "Deployment environment."
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group that will contain every backend resource."
}

variable "key_vault_name" {
  type        = string
  description = "Optional custom Key Vault name. Must be globally unique in Azure."
  default     = null
}

variable "global_suffix" {
  type        = string
  description = "Short alphanumeric suffix for globally-unique resource names."
  default     = ""
}

variable "openai_model" {
  type        = string
  description = "OpenAI model used by generateNpcDialogue."
  default     = "gpt-5.4-mini"
}

variable "key_vault_purge_protection" {
  type        = bool
  description = "Enable purge protection on the Key Vault."
  default     = false
}

variable "key_vault_soft_delete_retention_days" {
  type        = number
  description = "Days a deleted Key Vault or secret can be recovered."
  default     = 7
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource."
  default     = {}
}
