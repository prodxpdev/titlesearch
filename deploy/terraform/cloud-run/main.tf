# Titlesearch on Cloud Run: the API service, the renderer as a separate
# service with a permissionless identity (invariant 8), Firestore for the
# cache with TTL policies, and Secret Manager for every secret.
# See docs/setup/google-cloud-run.md.

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  # Cloud Run's deterministic URL, known before the service exists.
  service_url = "https://${var.name}-${data.google_project.this.number}.${var.region}.run.app"
  public_url  = var.public_url != "" ? var.public_url : local.service_url
  renderer    = var.renderer_image != ""
}

resource "google_project_service" "services" {
  for_each           = toset(["run.googleapis.com", "firestore.googleapis.com", "secretmanager.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# --- Firestore -----------------------------------------------------------

resource "google_firestore_database" "cache" {
  project     = var.project_id
  name        = var.name
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.services]
}

# Firestore deletes documents within about a day after expireAt; reads check
# the exact expiry themselves (ADR 18).
resource "google_firestore_field" "ttl" {
  for_each   = toset(["titlesearch_cache", "titlesearch_blobs", "titlesearch_blob_chunks"])
  project    = var.project_id
  database   = google_firestore_database.cache.name
  collection = each.value
  field      = "expireAt"
  ttl_config {}
  index_config {}
}

# --- Identities ----------------------------------------------------------

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "${var.name}-api"
  display_name = "Titlesearch API"
}

# The renderer runs third-party JavaScript. Its identity has no roles at all,
# so the metadata server can give a compromised browser only a powerless token.
resource "google_service_account" "renderer" {
  count        = local.renderer ? 1 : 0
  project      = var.project_id
  account_id   = "${var.name}-renderer"
  display_name = "Titlesearch renderer (no permissions)"
}

resource "google_project_iam_member" "api_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.api.email}"
  condition {
    title      = "Titlesearch database only"
    expression = "resource.name.startsWith(\"projects/${var.project_id}/databases/${var.name}\")"
  }
}

# --- Secrets -------------------------------------------------------------

resource "random_password" "session" {
  length  = 48
  special = false
}

resource "random_password" "renderer_token" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "generated" {
  for_each  = toset(local.renderer ? ["SESSION_SECRET", "RENDERER_TOKEN"] : ["SESSION_SECRET"])
  project   = var.project_id
  secret_id = "${var.name}-${lower(replace(each.value, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = google_secret_manager_secret.generated
  secret      = each.value.id
  secret_data = each.key == "SESSION_SECRET" ? random_password.session.result : random_password.renderer_token.result
}

locals {
  api_secrets = merge(
    { for k, s in google_secret_manager_secret.generated : k => s.secret_id },
    var.secret_ids,
  )
}

resource "google_secret_manager_secret_iam_member" "api" {
  for_each  = local.api_secrets
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "renderer" {
  count     = local.renderer ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.generated["RENDERER_TOKEN"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.renderer[0].email}"
}

# --- Renderer ------------------------------------------------------------

resource "google_cloud_run_v2_service" "renderer" {
  count               = local.renderer ? 1 : 0
  project             = var.project_id
  name                = "${var.name}-renderer"
  location            = var.region
  deletion_protection = false
  # Reachable over HTTPS; the shared token authenticates the API's calls.
  invoker_iam_disabled = true

  template {
    service_account                  = google_service_account.renderer[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 2
    timeout                          = "60s"
    scaling {
      max_instance_count = var.max_instances
    }
    containers {
      image = var.renderer_image
      resources {
        limits = { cpu = "2", memory = "2Gi" }
      }
      env {
        name  = "RENDER_CONCURRENCY"
        value = "2"
      }
      env {
        name = "RENDERER_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.generated["RENDERER_TOKEN"].secret_id
            version = "latest"
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.renderer, google_secret_manager_secret_version.generated]
}

# --- API -----------------------------------------------------------------

locals {
  api_env = merge(
    {
      PUBLIC_URL            = local.public_url
      OIDC_ISSUER           = var.oidc_issuer
      ALLOWED_EMAILS        = join(",", var.allowed_emails)
      ALLOWED_EMAIL_DOMAINS = join(",", var.allowed_email_domains)
      ALLOWED_SUBJECTS      = join(",", var.allowed_subjects)
      CACHE_BACKEND         = "firestore"
      GOOGLE_CLOUD_PROJECT  = var.project_id
      FIRESTORE_DATABASE    = google_firestore_database.cache.name
    },
    var.oidc_audience != "" ? { OIDC_AUDIENCE = var.oidc_audience } : {},
    var.oidc_client_id != "" ? { OIDC_CLIENT_ID = var.oidc_client_id } : {},
    var.required_scope != "" ? { REQUIRED_SCOPE = var.required_scope } : {},
    var.required_role != "" ? { REQUIRED_ROLE = var.required_role } : {},
    local.renderer ? { RENDERER_URL = google_cloud_run_v2_service.renderer[0].uri } : {},
    var.settings,
  )
}

resource "google_cloud_run_v2_service" "api" {
  project             = var.project_id
  name                = var.name
  location            = var.region
  deletion_protection = false
  # Public: the app authenticates every API and MCP request itself (ADR 19).
  invoker_iam_disabled = true

  template {
    service_account = google_service_account.api.email
    timeout         = "300s"
    scaling {
      max_instance_count = var.max_instances
    }
    containers {
      image = var.api_image
      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.api_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.api, google_secret_manager_secret_version.generated]
}
