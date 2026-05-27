terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40"
    }
  }

  backend "s3" {
    bucket         = "admissions-tfstate"
    key            = "college-research-agent/ec2/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "admissions-tfstate-locks"
    encrypt        = true
  }
}
