# One-time bootstrap of the Terraform remote state storage.
# Requires: az login with rights on the subscription.
#
# Usage: .\bootstrap-remote-state.ps1 [-Location brazilsouth]

param(
    [string]$Location = "brazilsouth",
    [string]$ResourceGroup = "rg-hotelia-tfstate",
    [string]$StorageAccount = "sthoteliatfstate",
    [string]$Container = "tfstate"
)

$ErrorActionPreference = "Stop"

# Required because the azurerm provider runs with resource_provider_registrations = "none"
# (student subscriptions cannot register every provider automatically).
foreach ($ns in @("Microsoft.Web", "Microsoft.Storage", "Microsoft.Insights", "Microsoft.KeyVault", "Microsoft.OperationalInsights")) {
    az provider register --namespace $ns --output none
}

az group create --name $ResourceGroup --location $Location --output none

az storage account create `
    --name $StorageAccount `
    --resource-group $ResourceGroup `
    --location $Location `
    --sku Standard_LRS `
    --kind StorageV2 `
    --min-tls-version TLS1_2 `
    --allow-blob-public-access false `
    --output none

az storage container create `
    --name $Container `
    --account-name $StorageAccount `
    --auth-mode login `
    --output none

Write-Output "Remote state ready: $StorageAccount/$Container (rg: $ResourceGroup)"
Write-Output "Initialize with: terraform init -backend-config=envs/dev.backend.hcl"
