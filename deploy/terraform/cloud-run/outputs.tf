output "url" {
  description = "Where Titlesearch is reachable. Add it as a custom connector in Claude: <url>/mcp."
  value       = local.public_url
}

output "oauth_redirect_uri" {
  description = "Register this redirect URI with your identity provider for browser sign-in."
  value       = "${local.public_url}/auth/callback"
}

output "renderer_url" {
  description = "The renderer service, reachable only with the generated token."
  value       = local.renderer ? google_cloud_run_v2_service.renderer[0].uri : null
}
