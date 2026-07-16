variable "project_name" {
  type        = string
  description = "Project name used for Azure resource names."
  default     = "hotelia"
}

variable "environment" {
  type        = string
  description = "Deployment environment."
  default     = "dev"

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}

variable "azure_region" {
  type        = string
  description = "Azure region for all Hotelia resources."
  default     = "brazilsouth"
}

variable "key_vault_name" {
  type        = string
  description = "Optional custom Key Vault name. Must be globally unique in Azure."
  default     = null
}

variable "global_suffix" {
  type        = string
  description = "Short alphanumeric suffix for globally-unique names (storage, key vault, function app). Avoids collisions with other subscriptions deploying this same project."
  default     = ""

  validation {
    condition     = can(regex("^[a-z0-9]{0,6}$", var.global_suffix))
    error_message = "global_suffix must be 0-6 lowercase alphanumeric characters."
  }
}

variable "openai_model" {
  type        = string
  description = "OpenAI model used by generateNpcDialogue. Not a secret, so it lives in app settings."
  default     = "gpt-5.4-mini"
}

variable "key_vault_purge_protection" {
  type        = bool
  description = "Enable purge protection on the Key Vault (cannot be disabled once on; use for prod)."
  default     = false
}

variable "key_vault_soft_delete_retention_days" {
  type        = number
  description = "Days a deleted Key Vault or secret can be recovered."
  default     = 7
}
