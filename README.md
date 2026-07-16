# Hotelia — Backend (Azure Functions)

Backend serverless del juego educativo **Hotelia** (Unity). Expone 8 funciones HTTP que actúan de intermediario seguro entre el cliente Unity y PlayFab/OpenAI: el juego nunca ve la Secret Key de PlayFab ni la API key de OpenAI.

```
Unity (juego)  ──POST + function key──►  Azure Functions  ──►  PlayFab Server/Admin API
                                              │
                                              └──►  OpenAI Responses API (diálogo NPC)

Secretos: Azure Key Vault ──(Key Vault references + managed identity)──► app settings
```

## Funciones

| Función | Ruta | Uso en Unity |
|---|---|---|
| `registerTeacher` | `POST /api/registerTeacher` | Registro de profesores (valida `TEACHER_ACCESS_CODE`) |
| `upsertStudentProfile` | `POST /api/upsertStudentProfile` | Alta/actualización de estudiante en el índice |
| `searchStudents` | `POST /api/searchStudents` | Búsqueda en el panel del profesor |
| `bulkCreateStudents` | `POST /api/bulkCreateStudents` | Importación masiva de estudiantes (CSV) |
| `getStudentPerformance` | `POST /api/getStudentPerformance` | Métricas de desempeño del estudiante |
| `saveAIQuestionParameters` | `POST /api/saveAIQuestionParameters` | Parámetros de preguntas IA por curso |
| `getAIQuestionParametersForStudent` | `POST /api/getAIQuestionParametersForStudent` | Carga de parámetros para el estudiante |
| `generateNpcDialogue` | `POST /api/generateNpcDialogue` | Diálogo NPC vía OpenAI |

Todas usan `authLevel: 'function'`: la URL debe incluir `?code=<function key>`. Los errores de negocio responden `200` con `success: false` (contrato que el cliente Unity ya espera); los errores de validación usan `400` y los de configuración/servidor `500`.

## Estructura

```
src/functions/   las 8 funciones HTTP
src/lib/         config.js (env vars), playfab.js (cliente único), http.js (respuestas)
tests/           suite Jest (82 tests) con umbral de cobertura que bloquea el build
infra/           Terraform (resource group, Function App, Key Vault, App Insights)
k8s/ + Dockerfile  demo de despliegue en contenedor usada solo por el job de DAST
```

## Desarrollo local

Requisitos: Node 22+, Azure Functions Core Tools v4.

```bash
npm ci
npm run lint     # ESLint
npm test         # Jest con cobertura (falla bajo el umbral)
npm start        # func start (requiere local.settings.json)
```

`local.settings.json` (no se commitea) necesita: `PLAYFAB_TITLE_ID`, `PLAYFAB_SECRET_KEY`, `TEACHER_ACCESS_CODE`, `OPENAI_API_KEY`, `OPENAI_MODEL`.

## CI/CD (GitHub Actions)

### `devsecops-cicd.yml` — aplicación

| Job | Bloquea | Descripción |
|---|---|---|
| Lint & Test | ✅ | ESLint + Jest con umbral de cobertura |
| CodeQL (SAST) | ✅ | Análisis estático de JavaScript |
| SonarQube | ✅ (si `SONAR_CONFIGURED=true`) | Calidad, deuda técnica, code smells y cobertura; falla si el quality gate del código nuevo está en rojo |
| Build, Scan & Sign | ✅ | Imagen Docker; **Trivy falla con CRITICAL corregibles**; firma con Cosign (solo push) |
| DAST (ZAP) | ⚠️ no bloqueante | Despliega a un Minikube efímero en el runner y corre ZAP baseline. Decisión explícita: entorno sin secretos reales |
| Deploy to Azure | ✅ | Solo en push a la rama default: login OIDC → `Azure/functions-action` → smoke test |

En pull requests la imagen se construye y escanea pero **no** se publica ni se despliega.

### `infra-cicd.yml` — infraestructura

- En PR que toque `infra/**`: `fmt` + `validate` (sin credenciales) y `plan` de solo lectura.
- En push a la rama default: `plan` + `apply` sobre `dev` (protege el environment `infra-dev` con reviewers para exigir aprobación humana).
- `workflow_dispatch` permite plan/apply manual sobre `dev` o `prod`.

### Configuración requerida en GitHub (una sola vez)

Secrets (Settings → Secrets and variables → Actions → Secrets):

| Secret | Modo | Valor |
|---|---|---|
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | publish-profile (actual) | XML de `az functionapp deployment list-publishing-profiles --xml` |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | oidc (futuro) | App Registration con federated credentials |

Variables (→ Variables):

| Variable | Valor |
|---|---|
| `AZURE_CONFIGURED` | `true` (habilita los jobs de deploy/infra) |
| `AZURE_AUTH_MODE` | vacío o `publish-profile` (actual); `oidc` cuando exista App Registration |
| `AZURE_FUNCTIONAPP_NAME` | `func-hotelia-dev-teacher-api-sc` |
| `AZURE_RESOURCE_GROUP` | `rg-hotelia-dev` |
| `SONAR_CONFIGURED` | `true` (habilita el job de SonarQube) |
| `SONAR_HOST_URL` | `https://sonarcloud.io` (o la URL de tu servidor SonarQube) |

### SonarQube

El análisis se configura en [`sonar-project.properties`](sonar-project.properties) y corre en el job `SonarQube` del pipeline. Mide deuda técnica, code smells, vulnerabilidades y cobertura (vía `coverage/lcov.info` que produce Jest) — es la evidencia directa de la métrica de **RNF-05** (deuda técnica ≤ 5 %, 0 fallos críticos).

**Puesta en marcha (SonarCloud, gratis para repos públicos):**

1. Entra a [sonarcloud.io](https://sonarcloud.io) con la cuenta de GitHub y crea la organización enlazada al repo.
2. Importa el repositorio `HoteliaTeacherRegisterFunction`. Anota el **Project Key** y el **Organization Key**.
3. Si difieren de los valores por defecto, ajústalos en `sonar-project.properties` (`sonar.projectKey`, `sonar.organization`).
4. En SonarCloud → *My Account → Security*, genera un token.
5. En GitHub → *Settings → Secrets and variables → Actions*: crea el secret `SONAR_TOKEN` con ese valor y la variable `SONAR_CONFIGURED=true`.
6. En SonarCloud → *Administration → Analysis Method*: desactiva "Automatic Analysis" (el análisis lo hace el pipeline).

Para **SonarQube self-hosted**: mismo procedimiento, pero define además la variable `SONAR_HOST_URL` con la URL del servidor. Mientras `SONAR_CONFIGURED` no sea `true`, el job se omite y el pipeline sigue funcionando.

> **Nota del tenant (udla.edu.ec):** las cuentas de estudiante no pueden crear App Registrations (`Insufficient privileges`), así que el modo OIDC queda documentado para cuando un administrador del tenant lo provisione. Mientras tanto el deploy usa el **publish profile**, que es una credencial acotada a esta única Function App — trátala como secreto y regenérala si se filtra (`az functionapp deployment list-publishing-profiles` para obtenerla, "Reset publish profile" en el portal para rotarla).

## Infraestructura (Terraform)

Terraform vive en `infra/` (movido desde el repo de Unity para que infra y código compartan ciclo de vida). Estado remoto en Azure Storage con locking.

### Bootstrap (una sola vez)

```powershell
# 1. Storage del estado remoto + registro de resource providers
.\infra\scripts\bootstrap-remote-state.ps1

# 2. Init + plan + apply del ambiente dev
cd infra
terraform init -backend-config=envs/dev.backend.hcl
terraform plan -var-file=envs/dev.tfvars
terraform apply -var-file=envs/dev.tfvars
```

> El provider azurerm está configurado con `resource_provider_registrations = "none"` porque las suscripciones de estudiante no pueden registrar todos los providers; el script de bootstrap registra los cinco necesarios (`Microsoft.Web`, `Storage`, `Insights`, `KeyVault`, `OperationalInsights`).

### App Registration para GitHub Actions (OIDC, cuando el tenant lo permita)

```bash
az ad app create --display-name "github-hotelia-deploy"          # anota el appId
az ad sp create --id <appId>

# Federated credential para la rama default del repo
az ad app federated-credential create --id <appId> --parameters '{
  "name": "github-default-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:NicolasBosak/HoteliaTeacherRegisterFunction:ref:refs/heads/devsecops-cicd",
  "audiences": ["api://AzureADTokenExchange"]
}'
# Repite con subject "repo:...:environment:dev" e "environment:infra-dev" si proteges environments.

# Permisos: Contributor sobre el RG de la app y del estado + acceso al estado
az role assignment create --assignee <appId> --role Contributor --scope /subscriptions/<sub>/resourceGroups/rg-hotelia-dev
az role assignment create --assignee <appId> --role Contributor --scope /subscriptions/<sub>/resourceGroups/rg-hotelia-tfstate
az role assignment create --assignee <appId> --role "Storage Blob Data Contributor" --scope <id del storage sthoteliatfstate>
az role assignment create --assignee <appId> --role "Key Vault Secrets Officer" --scope <id del key vault kv-hotelia-dev-sc>
```

### Secretos (Key Vault)

Los **valores** nunca están en Terraform ni en git. Se cargan una vez por CLI (necesitas el rol *Key Vault Secrets Officer* sobre el vault):

```bash
az keyvault secret set --vault-name kv-hotelia-dev-sc --name PLAYFAB-TITLE-ID     --value "<valor>"
az keyvault secret set --vault-name kv-hotelia-dev-sc --name PLAYFAB-SECRET-KEY   --value "<valor>"
az keyvault secret set --vault-name kv-hotelia-dev-sc --name TEACHER-ACCESS-CODE  --value "<valor>"
az keyvault secret set --vault-name kv-hotelia-dev-sc --name OPENAI-API-KEY       --value "<valor>"
```

La Function App los lee vía Key Vault references con su managed identity (el role assignment lo crea Terraform). `OPENAI_MODEL` no es secreto: se define en `envs/*.tfvars`.

Para **rotar** un secreto: `az keyvault secret set` con el valor nuevo y reinicia la app (`az functionapp restart`).

## Conectar Unity

Cada campo de URL en los Inspectors necesita la URL completa con function key:

```bash
# Obtener la default function key
az functionapp keys list -g rg-hotelia-dev -n func-hotelia-dev-teacher-api-sc --query functionKeys.default -o tsv
```

URL a pegar: `https://func-hotelia-dev-teacher-api-sc.azurewebsites.net/api/<funcion>?code=<key>`

| Escena | Componente | Campo |
|---|---|---|
| Menú | `PlayfabManager` | `registerTeacherUrl`, `upsertStudentProfileUrl` |
| TeacherDashboard | `TeacherStudentsPanelUI` | `searchStudentsUrl`, `bulkCreateStudentsUrl` |
| TeacherDashboard | `TeacherPerformancePanelUI` | `getStudentPerformanceUrl` |
| TeacherDashboard | `TeacherAIQuestionParametersPanelUI` | `saveAIQuestionParametersUrl` |
| Juego | `StudentAIQuestionParametersLoader` | `getAIQuestionParametersForStudentUrl` |
| Hotel | `Ollama_Handler` | `azureFunctionUrl` (→ `generateNpcDialogue`) |

Mejora pendiente en el cliente: centralizar estas URLs en un `ScriptableObject` con `baseUrl` + key para no pegarlas una por una.

## Decisiones y deuda conocida

- **Contrato 200 + `success:false`** para errores de negocio: se conserva por compatibilidad con el cliente Unity ya desplegado. Migrar a códigos 4xx requiere un cambio coordinado en los paneles de Unity.
- **ZAP no bloqueante**: escanea un entorno efímero sin datos reales; los hallazgos se revisan como artifacts/issues.
- **`k8s/` + `Dockerfile`**: solo alimentan la demo de DAST del pipeline; el runtime real es la Function App de consumo (Y1).
- **`TEACHER_ACCESS_CODE` estático**: vulnerable a fuerza bruta/diccionario; pendiente rate limiting o códigos de un solo uso.
- **Function keys en el cliente**: un build de Unity distribuido expone las keys; la mitigación real es validar session tickets de PlayFab en cada función (varias ya reciben `sessionTicket`).
