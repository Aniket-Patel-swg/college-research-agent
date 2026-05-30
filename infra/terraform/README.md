# Terraform — college-research-agent (EC2 t2.micro)

Provisions a **Free Tier–eligible `t2.micro`** instance running the Express + Gemini agent, plus DynamoDB cache and S3 deploy artifacts.

```
GitHub push (src/**)
   ↓
GitHub Actions: build → S3 tarball → SSM → EC2 systemd restart

GitHub push (infra/terraform/**)
   ↓
GitHub Actions: terraform plan / apply
```

## Resources

| Resource | Purpose |
|----------|---------|
| `aws_instance` (t2.micro) | Runs `node dist/server.js` via systemd |
| `aws_eip` | Stable public IP for `COLLEGE_AGENT_BASE_URL` |
| `aws_dynamodb_table` | `CollegeResearchCache` (no TTL — persistent cache) |
| `aws_s3_bucket` | CI release tarballs (`releases/<id>.tar.gz`) |
| `aws_ssm_parameter` | SecureString for `GEMINI_API_KEY` |
| `aws_security_group` | TCP `${app_port}` (default 4810) |

## One-time setup

### 1. Bootstrap (GitHub OIDC role)

```bash
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply
```

Add GitHub secrets: `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`.

### 2. Main stack (from laptop first time)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Set gemini_api_key and a globally unique deploy_bucket_name if needed
terraform init
terraform apply
```

Note outputs: `agent_base_url`, `instance_id`, `health_check_url`.

Wait ~3 minutes for SSM agent to register, then run the **deploy** workflow (or push app code).

### 3. Frontend

```env
COLLEGE_AGENT_BASE_URL=http://<elastic_ip>:4810
```

In `admission-buddy-frontend` (and Vercel env). Consider `export const maxDuration = 300` on `/api/college-details` if Gemini runs are slow.

## Cost notes

- **t2.micro**: 750 hours/month free for 12 months on new AWS accounts.
- **DynamoDB on-demand**: pennies at low traffic.
- **Gemini API**: dominant cost — cache + flash models matter most.
- **Elastic IP**: free while attached to a running instance.

## SSM access (no SSH required)

```bash
aws ssm start-session --target <instance_id> --region ap-south-1
sudo journalctl -u college-research-agent -f
```
