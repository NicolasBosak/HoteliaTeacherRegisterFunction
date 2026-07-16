# Remote state for the dev environment.
# The storage account is created once by infra/scripts/bootstrap-remote-state.ps1
resource_group_name  = "rg-hotelia-tfstate"
storage_account_name = "sthoteliatfstate"
container_name       = "tfstate"
key                  = "hotelia/dev.terraform.tfstate"
