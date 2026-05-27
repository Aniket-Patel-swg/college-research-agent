variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "admission-buddy"
      Service   = "college-research-agent"
      ManagedBy = "terraform"
    }
  }
}
