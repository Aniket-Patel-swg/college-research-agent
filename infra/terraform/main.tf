data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ---------------------------------------------------------------------------
# DynamoDB cache (same schema as src/cache.ts)
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "cache" {
  name         = var.cache_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "cacheKey"

  attribute {
    name = "cacheKey"
    type = "S"
  }

  # Explicitly off — cache rows persist until overwritten via refresh.
  ttl {
    enabled = false
  }
}

# ---------------------------------------------------------------------------
# S3 — release artifacts from GitHub Actions
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "deploy" {
  bucket = var.deploy_bucket_name
}

resource "aws_s3_bucket_versioning" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "deploy" {
  bucket                  = aws_s3_bucket.deploy.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id

  rule {
    id     = "expire-old-releases"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# ---------------------------------------------------------------------------
# Secrets — Gemini key in SSM (read by EC2 on boot + deploy refreshes .env)
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "gemini_api_key" {
  name  = "/${var.service_name}/gemini-api-key"
  type  = "SecureString"
  value = var.gemini_api_key

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------
# IAM — EC2 instance profile
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name               = "${var.service_name}-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "ec2_app" {
  statement {
    sid    = "DynamoCache"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DescribeTable",
    ]
    resources = [aws_dynamodb_table.cache.arn]
  }

  statement {
    sid    = "DeployArtifacts"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.deploy.arn,
      "${aws_s3_bucket.deploy.arn}/*",
    ]
  }

  statement {
    sid    = "ReadGeminiKey"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
    ]
    resources = [aws_ssm_parameter.gemini_api_key.arn]
  }
}

resource "aws_iam_role_policy" "ec2_app" {
  name   = "app"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.ec2_app.json
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${var.service_name}-ec2"
  role = aws_iam_role.ec2.name
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

resource "aws_security_group" "agent" {
  name        = "${var.service_name}-ec2"
  description = "College research agent on EC2"

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = length(var.ssh_cidr_blocks) > 0 ? [1] : []
    content {
      description = "SSH (optional)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_cidr_blocks
    }
  }

  ingress {
    description = "Agent HTTP"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = var.agent_ingress_cidr_blocks
  }
}

# ---------------------------------------------------------------------------
# EC2
# ---------------------------------------------------------------------------

locals {
  app_env_content = <<-EOT
    PORT=${var.app_port}
    NODE_ENV=production
    AWS_REGION=${var.aws_region}
    CACHE_ENABLED=true
    CACHE_TABLE_NAME=${var.cache_table_name}
    GEMINI_MODEL=${var.gemini_model}
    GEMINI_FORMATTER_MODEL=${var.gemini_formatter_model}
    ALLOWED_ORIGINS=${var.allowed_origins}
    DEPLOY_BUCKET=${aws_s3_bucket.deploy.bucket}
  EOT

  user_data = templatefile("${path.module}/user-data.sh.tpl", {
    service_name        = var.service_name
    app_port            = var.app_port
    aws_region          = var.aws_region
    deploy_bucket       = aws_s3_bucket.deploy.bucket
    gemini_param_name   = aws_ssm_parameter.gemini_api_key.name
    systemd_unit        = file("${path.module}/../../deploy/college-research-agent.service")
    remote_deploy_sh    = file("${path.module}/../../deploy/remote-deploy.sh")
    app_env_content     = local.app_env_content
  })
}

resource "aws_instance" "agent" {
  ami                         = data.aws_ami.amazon_linux_2023.id
  instance_type               = var.instance_type
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  vpc_security_group_ids      = [aws_security_group.agent.id]
  associate_public_ip_address = true
  user_data                   = local.user_data
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_eip" "agent" {
  domain = "vpc"
  instance = aws_instance.agent.id

  depends_on = [aws_instance.agent]
}
