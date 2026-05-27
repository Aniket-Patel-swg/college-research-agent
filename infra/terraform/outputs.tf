output "aws_account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  value = data.aws_region.current.name
}

output "instance_id" {
  description = "Set as GitHub variable EC2_INSTANCE_ID (or read from workflow terraform output)."
  value       = aws_instance.agent.id
}

output "elastic_ip" {
  value = aws_eip.agent.public_ip
}

output "agent_base_url" {
  description = "Set COLLEGE_AGENT_BASE_URL in admission-buddy-frontend to this value."
  value       = "http://${aws_eip.agent.public_ip}:${var.app_port}"
}

output "deploy_bucket" {
  value = aws_s3_bucket.deploy.bucket
}

output "cache_table_name" {
  value = aws_dynamodb_table.cache.name
}

output "health_check_url" {
  value = "http://${aws_eip.agent.public_ip}:${var.app_port}/health"
}
