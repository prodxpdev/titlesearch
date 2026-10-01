variable "project_id" {
  description = "The Google Cloud project to deploy into."
  type        = string
}

variable "region" {
  description = "The Cloud Run and Firestore region, such as us-central1."
  type        = string
}

variable "name" {
  description = "Prefix for every resource's name."
  type        = string
  default     = "titlesearch"
}

variable "api_image" {
  description = "The API image (deploy/container/Dockerfile, target api), pinned by digest."
  type        = string
}

variable "renderer_image" {
  description = "The renderer image (target renderer), pinned by digest. Empty to turn screenshots off; previews then use share images."
  type        = string
  default     = ""
}

variable "public_url" {
  description = "Where users reach Titlesearch, such as https://titlesearch.example.com. Empty to use the Cloud Run service URL."
  type        = string
  default     = ""
}

variable "oidc_issuer" {
  description = "Your identity provider's issuer URL, such as https://accounts.google.com."
  type        = string
}

variable "oidc_audience" {
  description = "The audience access tokens carry, if your identity provider can't use the MCP resource URL."
  type        = string
  default     = ""
}

variable "oidc_client_id" {
  description = "The OAuth client ID for browser sign-in."
  type        = string
  default     = ""
}

variable "allowed_emails" {
  description = "Email addresses allowed to use this server."
  type        = list(string)
  default     = []
}

variable "allowed_email_domains" {
  description = "Email domains allowed to use this server."
  type        = list(string)
  default     = []
}

variable "allowed_subjects" {
  description = "OAuth subjects allowed to use this server."
  type        = list(string)
  default     = []
}

variable "required_scope" {
  description = "A scope your identity provider grants only to permitted users."
  type        = string
  default     = ""
}

variable "required_role" {
  description = "An app role your identity provider assigns only to permitted users (the roles claim)."
  type        = string
  default     = ""
}

variable "secret_ids" {
  description = <<-EOT
    Existing Secret Manager secret IDs, by setting name. Supported names:
    OIDC_CLIENT_SECRET, PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY, NAMECOM_TOKEN,
    ANTHROPIC_API_KEY. Add each value with `gcloud secrets versions add`.
  EOT
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([for k in keys(var.secret_ids) : contains(
      ["OIDC_CLIENT_SECRET", "PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY", "NAMECOM_TOKEN", "ANTHROPIC_API_KEY"], k
    )])
    error_message = "Unsupported secret name."
  }
}

variable "settings" {
  description = "Other non-secret settings, such as { NAMECOM_USERNAME = \"me\", GODADDY_ENABLED = \"true\" }."
  type        = map(string)
  default     = {}
}

variable "max_instances" {
  description = "Upper bound on API instances."
  type        = number
  default     = 10
}
