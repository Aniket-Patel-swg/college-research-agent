#!/usr/bin/env bash
# Runs on the EC2 instance via SSM (GitHub Actions uploads the release tarball to S3 first).
set -euo pipefail

RELEASE_ID="${1:?usage: remote-deploy.sh <release-id>}"
APP_DIR="/opt/college-research-agent"
DEPLOY_BUCKET="${DEPLOY_BUCKET:?DEPLOY_BUCKET not set}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
KEY="releases/${RELEASE_ID}.tar.gz"
TMP="/tmp/college-research-agent-${RELEASE_ID}.tar.gz"

echo "Deploying s3://${DEPLOY_BUCKET}/${KEY} -> ${APP_DIR}"

aws s3 cp "s3://${DEPLOY_BUCKET}/${KEY}" "$TMP" --region "$AWS_REGION"
sudo -u ec2-user mkdir -p "$APP_DIR"
sudo -u ec2-user tar -xzf "$TMP" -C "$APP_DIR"
rm -f "$TMP"

cd "$APP_DIR"
sudo -u ec2-user npm ci --omit=dev --no-audit --no-fund

sudo systemctl daemon-reload
sudo systemctl enable college-research-agent
sudo systemctl restart college-research-agent
sudo systemctl is-active --quiet college-research-agent

echo "Deploy OK: $(curl -sf http://127.0.0.1:4810/health || echo 'health pending')"
