# Titlesearch on AWS Lambda: the API image behind a function URL (through the
# Lambda Web Adapter), the renderer as a separate function whose role can only
# write its logs (invariant 8), DynamoDB with TTL for the cache, and Secrets
# Manager for every secret. See docs/setup/aws-lambda.md.

locals {
  renderer = var.renderer_image_uri != ""
}

data "aws_region" "current" {}
data "aws_partition" "current" {}

# --- DynamoDB ------------------------------------------------------------

resource "aws_dynamodb_table" "cache" {
  name         = var.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  # Deletes items some time after `ttl`; reads check the exact expiry (ADR 18).
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
  point_in_time_recovery {
    enabled = false
  }
  server_side_encryption {
    enabled = true
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

resource "aws_secretsmanager_secret" "session" {
  name_prefix = "${var.name}-session-"
}

resource "aws_secretsmanager_secret_version" "session" {
  secret_id     = aws_secretsmanager_secret.session.id
  secret_string = random_password.session.result
}

resource "aws_secretsmanager_secret" "renderer_token" {
  count       = local.renderer ? 1 : 0
  name_prefix = "${var.name}-renderer-token-"
}

resource "aws_secretsmanager_secret_version" "renderer_token" {
  count         = local.renderer ? 1 : 0
  secret_id     = aws_secretsmanager_secret.renderer_token[0].id
  secret_string = random_password.renderer_token.result
}

# The function URL exists only after the function, so the API reads its own
# public URL from here at startup (PUBLIC_URL_ARN) instead of an environment
# variable, which would be a dependency cycle.
resource "aws_secretsmanager_secret" "public_url" {
  name_prefix = "${var.name}-public-url-"
}

resource "aws_secretsmanager_secret_version" "public_url" {
  secret_id     = aws_secretsmanager_secret.public_url.id
  secret_string = var.public_url != "" ? var.public_url : trimsuffix(aws_lambda_function_url.api.function_url, "/")
}

locals {
  api_secret_arns = merge(
    {
      SESSION_SECRET = aws_secretsmanager_secret.session.arn
      PUBLIC_URL     = aws_secretsmanager_secret.public_url.arn
    },
    local.renderer ? { RENDERER_TOKEN = aws_secretsmanager_secret.renderer_token[0].arn } : {},
    var.secret_arns,
  )
}

# --- Roles ---------------------------------------------------------------

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name_prefix        = "${var.name}-api-"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:BatchGetItem", "dynamodb:TransactWriteItems"]
    resources = [aws_dynamodb_table.cache.arn]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(local.api_secret_arns)
  }
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# The renderer runs third-party JavaScript: its role can write its own logs
# and read its own token, which only lets a caller use the renderer itself.
resource "aws_iam_role" "renderer" {
  count              = local.renderer ? 1 : 0
  name_prefix        = "${var.name}-renderer-"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy_attachment" "renderer_logs" {
  count      = local.renderer ? 1 : 0
  role       = aws_iam_role.renderer[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "renderer" {
  count = local.renderer ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.renderer_token[0].arn]
  }
}

resource "aws_iam_role_policy" "renderer" {
  count  = local.renderer ? 1 : 0
  role   = aws_iam_role.renderer[0].id
  policy = data.aws_iam_policy_document.renderer[0].json
}

# --- Renderer ------------------------------------------------------------

resource "aws_lambda_function" "renderer" {
  count         = local.renderer ? 1 : 0
  function_name = "${var.name}-renderer"
  role          = aws_iam_role.renderer[0].arn
  package_type  = "Image"
  image_uri     = var.renderer_image_uri
  architectures = [var.architecture]
  memory_size   = 2048
  timeout       = 60
  environment {
    variables = {
      RENDERER_TOKEN_ARN = aws_secretsmanager_secret.renderer_token[0].arn
      RENDER_CONCURRENCY = "1"
      # Chromium writes its profile under HOME; only /tmp is writable on Lambda.
      HOME = "/tmp"
    }
  }
}

resource "aws_lambda_function_url" "renderer" {
  count              = local.renderer ? 1 : 0
  function_name      = aws_lambda_function.renderer[0].function_name
  authorization_type = "NONE" # The shared token authenticates the API's calls.
}

# --- API -----------------------------------------------------------------

locals {
  api_env = merge(
    {
      OIDC_ISSUER           = var.oidc_issuer
      ALLOWED_EMAILS        = join(",", var.allowed_emails)
      ALLOWED_EMAIL_DOMAINS = join(",", var.allowed_email_domains)
      ALLOWED_SUBJECTS      = join(",", var.allowed_subjects)
      EXTRA_HOSTS           = join(",", var.extra_hosts)
      CACHE_BACKEND         = "dynamodb"
      DYNAMODB_TABLE        = aws_dynamodb_table.cache.name
    },
    { for k, arn in local.api_secret_arns : "${k}_ARN" => arn },
    var.oidc_audience != "" ? { OIDC_AUDIENCE = var.oidc_audience } : {},
    var.oidc_client_id != "" ? { OIDC_CLIENT_ID = var.oidc_client_id } : {},
    var.required_scope != "" ? { REQUIRED_SCOPE = var.required_scope } : {},
    var.required_role != "" ? { REQUIRED_ROLE = var.required_role } : {},
    local.renderer ? { RENDERER_URL = trimsuffix(aws_lambda_function_url.renderer[0].function_url, "/") } : {},
    var.settings,
  )
}

resource "aws_lambda_function" "api" {
  function_name = var.name
  role          = aws_iam_role.api.arn
  package_type  = "Image"
  image_uri     = var.api_image_uri
  architectures = [var.architecture]
  memory_size   = 1024
  timeout       = 120
  environment {
    variables = local.api_env
  }
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE" # The app authenticates every API and MCP request itself (ADR 19).
}
