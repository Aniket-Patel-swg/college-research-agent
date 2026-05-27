# One-time bootstrap: GitHub OIDC role for college-research-agent repo.
# Reuses admissions-tfstate bucket + existing GitHub OIDC provider when possible.

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "github_owner" {
  type = string
}

variable "github_repo" {
  type    = string
  default = "college-research-agent"
}

variable "github_oidc_provider_arn" {
  description = "Existing OIDC provider ARN from admissions-predictoins bootstrap."
  type        = string
  default     = ""
}

variable "deploy_bucket_name" {
  description = "Must match deploy_bucket_name in the main EC2 stack."
  type        = string
  default     = "admissions-college-research-agent-deploy"
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project   = "admission-buddy"
      Component = "bootstrap"
      Service   = "college-research-agent"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == "" ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  oidc_provider_arn = (
    var.github_oidc_provider_arn != ""
    ? var.github_oidc_provider_arn
    : aws_iam_openid_connect_provider.github[0].arn
  )
  account_id = data.aws_caller_identity.current.account_id
}

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_owner}/${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "github-actions-${var.github_repo}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid    = "TerraformState"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "arn:aws:s3:::admissions-tfstate",
      "arn:aws:s3:::admissions-tfstate/*",
    ]
  }

  statement {
    sid       = "TerraformLocks"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/admissions-tfstate-locks"]
  }

  statement {
    sid    = "DeployArtifacts"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetBucketLocation",
    ]
    resources = [
      "arn:aws:s3:::${var.deploy_bucket_name}",
      "arn:aws:s3:::${var.deploy_bucket_name}/*",
    ]
  }

  statement {
    sid    = "SSMDeploy"
    effect = "Allow"
    actions = [
      "ssm:SendCommand",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:DescribeInstanceInformation",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "EC2Read"
    effect = "Allow"
    actions = [
      "ec2:Describe*",
      "ec2:Get*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "EC2Terraform"
    effect = "Allow"
    actions = [
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:CreateTags",
      "ec2:DeleteTags",
      "ec2:AssociateAddress",
      "ec2:DisassociateAddress",
      "ec2:AllocateAddress",
      "ec2:ReleaseAddress",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:ModifyInstanceAttribute",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DynamoDB"
    effect = "Allow"
    actions = [
      "dynamodb:CreateTable",
      "dynamodb:DeleteTable",
      "dynamodb:DescribeTable",
      "dynamodb:UpdateTable",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:ListTagsOfResource",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "S3Infra"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:PutBucketVersioning",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutEncryptionConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:GetBucketVersioning",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:ListBucket",
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:TagResource",
      "s3:UntagResource",
      "s3:GetBucketTagging",
      "s3:PutBucketTagging",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "SSMParams"
    effect = "Allow"
    actions = [
      "ssm:PutParameter",
      "ssm:GetParameter",
      "ssm:DeleteParameter",
      "ssm:AddTagsToResource",
      "ssm:ListTagsForResource",
    ]
    resources = ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/college-research-agent/*"]
  }

  statement {
    sid    = "IAM"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:PassRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:GetInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "github_actions_role_arn" {
  value = aws_iam_role.github_actions.arn
}

output "aws_account_id" {
  value = local.account_id
}
