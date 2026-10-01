output "url" {
  description = "Where Titlesearch is reachable. Add it as a custom connector in Claude: <url>/mcp."
  value       = var.public_url != "" ? var.public_url : trimsuffix(aws_lambda_function_url.api.function_url, "/")
}

output "oauth_redirect_uri" {
  description = "Register this redirect URI with your identity provider for browser sign-in."
  value       = "${var.public_url != "" ? var.public_url : trimsuffix(aws_lambda_function_url.api.function_url, "/")}/auth/callback"
}

output "table" {
  value = aws_dynamodb_table.cache.name
}
