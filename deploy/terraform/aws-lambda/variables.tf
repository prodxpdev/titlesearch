variable "name" {
  description = "Prefix for every resource's name."
  type        = string
  default     = "titlesearch"
}

variable "api_image_uri" {
  description = "The API image in ECR (deploy/container/Dockerfile, target api), pinned by digest."
  type        = string
}

variable "renderer_image_uri" {
  description = "The renderer image in ECR (target renderer), pinned by digest. Empty to turn screenshots off."
  type        = string
  default     = ""
}

variable "architecture" {
  description = "The images' architecture: arm64 or x86_64."
  type        = string
  default     = "arm64"
}

variable "public_url" {
  description = "Where users reach Titlesearch, such as https://titlesearch.example.com behind CloudFront. Empty to use the API's function URL."
  type        = string
  default     = ""
}

variable "oidc_issuer" {
  description = "Your identity provider's issuer URL."
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

variable "secret_arns" {
  description = <<-EOT
    Existing Secrets Manager secret ARNs, by setting name. Supported names:
    OIDC_CLIENT_SECRET, PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY, NAMECOM_TOKEN,
    ANTHROPIC_API_KEY. Each secret holds the plain value as its SecretString.
  EOT
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([for k in keys(var.secret_arns) : contains(
      ["OIDC_CLIENT_SECRET", "PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY", "NAMECOM_TOKEN", "ANTHROPIC_API_KEY"], k
    )])
    error_message = "Unsupported secret name."
  }
}

variable "settings" {
  description = "Other non-secret settings, such as { NAMECOM_USERNAME = \"me\" }."
  type        = map(string)
  default     = {}
}

variable "extra_hosts" {
  description = "Other Host values to accept, such as the function URL's host when CloudFront serves public_url."
  type        = list(string)
  default     = []
}
