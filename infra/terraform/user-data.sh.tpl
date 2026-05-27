#!/bin/bash
set -euxo pipefail

APP_DIR="/opt/${service_name}"
GEMINI_PARAM="${gemini_param_name}"

# Node.js 20 (required by package.json engines)
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs aws-cli
node --version
npm --version

mkdir -p "$APP_DIR/bin"
chown -R ec2-user:ec2-user "$APP_DIR"

# Systemd unit + deploy helper (updated by Terraform on instance replace)
cat >/etc/systemd/system/college-research-agent.service <<'SYSTEMD_UNIT'
${systemd_unit}
SYSTEMD_UNIT

cat >"$APP_DIR/bin/remote-deploy.sh" <<'REMOTE_DEPLOY'
${remote_deploy_sh}
REMOTE_DEPLOY
chmod +x "$APP_DIR/bin/remote-deploy.sh"
chown ec2-user:ec2-user "$APP_DIR/bin/remote-deploy.sh"

# Non-secret env (GEMINI_API_KEY appended below)
cat >"$APP_DIR/.env" <<'APP_ENV'
${app_env_content}
APP_ENV

GEMINI_KEY="$(aws ssm get-parameter --name "$GEMINI_PARAM" --with-decryption --query Parameter.Value --output text --region ${aws_region})"
echo "GEMINI_API_KEY=$GEMINI_KEY" >>"$APP_DIR/.env"
chown ec2-user:ec2-user "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

systemctl daemon-reload
systemctl enable college-research-agent || true

echo "Bootstrap complete — waiting for first GitHub Actions deploy to populate dist/"
