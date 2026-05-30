variable "service_name" {
  type    = string
  default = "college-research-agent"
}

variable "instance_type" {
  description = "EC2 instance type (t2.micro is AWS Free Tier eligible for 12 months)."
  type        = string
  default     = "t2.micro"
}

variable "app_port" {
  type    = number
  default = 4810
}

variable "cache_table_name" {
  type    = string
  default = "CollegeResearchCache"
}

variable "gemini_api_key" {
  description = "Gemini API key (stored in SSM SecureString, injected into EC2 .env)."
  type        = string
  sensitive   = true
}

variable "gemini_model" {
  type    = string
  default = "gemini-2.5-flash-lite"
}

variable "gemini_formatter_model" {
  type    = string
  default = "gemini-3.5-flash"
}

variable "allowed_origins" {
  description = "CORS allowlist for the Express app (comma-separated)."
  type        = string
  default     = "*"
}

variable "deploy_bucket_name" {
  description = "S3 bucket for CI release tarballs (globally unique)."
  type        = string
  default     = "admissions-college-research-agent-deploy"
}

variable "ssh_cidr_blocks" {
  description = "Optional SSH (22) ingress CIDRs. Leave empty to use SSM only (recommended)."
  type        = list(string)
  default     = []
}

variable "agent_ingress_cidr_blocks" {
  description = "CIDRs allowed to reach the agent HTTP port (4810). Use 0.0.0.0/0 for public API."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
