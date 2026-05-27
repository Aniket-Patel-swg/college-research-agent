# college-research-agent

A small, standalone Node.js + Express service that takes a college name, runs a **Google Gemini** agent with the built-in **Google Search** grounding tool, and returns structured JSON for the **College Details** page.

Results are cached in DynamoDB for **7 days** (configurable). The cache is **gated on completeness** — if the agent couldn't find enough fields, the response is still returned to the caller but it is NOT persisted, so the next request will re-run the agent instead of serving a half-empty record for a week.

```
┌────────────────┐   POST /college-details   ┌──────────────────────┐
│ Next.js front  │ ───────────────────────▶ │ college-research-agent│
│  /college/[…]  │                          │  (this service)       │
└────────────────┘                          └─────┬──────────┬──────┘
                                                  │ hit       │ miss
                                       ┌──────────▼───┐  ┌────▼────────────────────┐
                                       │ DynamoDB     │  │ Gemini 2.5 Flash        │
                                       │ cache (TTL)  │  │ + googleSearch tool     │
                                       └──────────────┘  └─────────────────────────┘
                                              ▲
                                              └──── write only if response passes
                                                    `checkCompleteness()`
```

## Quick start

```bash
cd "Admission Buddy/college-research-agent"
cp .env.example .env        # then fill GEMINI_API_KEY
npm install
npm run dev
```

Sanity check:

```bash
curl -s -X POST http://localhost:4810/college-details \
  -H 'content-type: application/json' \
  -d '{"collegeName":"DA-IICT Gandhinagar"}' | jq
```

The console will log either:

- `cached "DA-IICT Gandhinagar" (key=da-iict-gandhinagar)` — full record, now persisted.
- `NOT caching "..." — missing: websiteUrl, sources(>=2, got 1)` — partial result returned but not stored, so it'll re-run next time.

## Endpoints

| Method | Path               | Body / Query                                     | Notes                                                                      |
| ------ | ------------------ | ------------------------------------------------ | -------------------------------------------------------------------------- |
| GET    | `/health`          | —                                                | Liveness check.                                                            |
| POST   | `/college-details` | `{ "collegeName": string, "refresh"?: boolean }` | Main endpoint. `refresh=true` bypasses the read cache (re-runs the agent). |
| GET    | `/college-details` | `?collegeName=...&refresh=true`                  | Same as above, browser-friendly.                                           |

Response shape: see [`src/types.ts`](src/types.ts) (`CollegeDetails`).

## What counts as "complete enough to cache"?

Defined in [`src/cache.ts`](src/cache.ts) as `checkCompleteness(details)`. The agent's output must have:

- `location`, `establishedYear`, `websiteUrl` (all 3 required)
- ≥ 2 of `quickStats.campusSize / avgPackage / highestPackage / totalFaculty / nirfRank`
- ≥ 3 entries in `topRecruiters`
- ≥ 1 entry in `cutoffTrends`
- At least one of `contact.admissionsEmail` or `contact.admissionsPhone`
- ≥ 2 sources cited by the grounding tool

Edit `checkCompleteness()` if you want to loosen or tighten the bar. Anything that fails the check is logged with the missing-field list and returned to the user but **not** persisted to DynamoDB.

## AWS setup

### DynamoDB cache table (one-time)

```bash
aws dynamodb create-table \
  --table-name CollegeResearchCache \
  --attribute-definitions AttributeName=cacheKey,AttributeType=S \
  --key-schema           AttributeName=cacheKey,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-south-1

aws dynamodb update-time-to-live \
  --table-name CollegeResearchCache \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region ap-south-1
```

### IAM permissions (minimum)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
      "Resource": "arn:aws:dynamodb:*:*:table/CollegeResearchCache"
    }
  ]
}
```

Set `CACHE_ENABLED=false` in `.env` to short-circuit DynamoDB during local dev.

## Gemini setup

1. Generate an API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free tier covers light usage).
2. Drop it into `GEMINI_API_KEY=AIza...` in `.env`.
3. Optional: change `GEMINI_MODEL` to `gemini-2.5-pro` for higher accuracy at ~10× the cost.

The `googleSearch` grounding tool is enabled automatically — Gemini handles search, snippet extraction, and citation collection internally. Citations come back as `groundingMetadata.groundingChunks[].web` and we surface them as the `sources[]` array in the response.

## Configuration

See [`.env.example`](.env.example) for the full list. Key vars:

- `GEMINI_API_KEY` (required)
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`.
- `CACHE_TTL_SECONDS` — defaults to `604800` (7 days).
- `CACHE_ENABLED` — set `false` to disable DynamoDB.
- `ALLOWED_ORIGINS` — comma-separated list, or `*` for any.

## Production (EC2 t2.micro + Terraform + GitHub Actions)

Deployed on a **Free Tier `t2.micro`** in `ap-south-1` with:

- **Terraform** — EC2, Elastic IP, DynamoDB, S3 deploy bucket, SSM secret ([`infra/terraform/README.md`](infra/terraform/README.md))
- **GitHub Actions** — `deploy.yml` builds the app, uploads to S3, deploys via **SSM** (no SSH key)
- **systemd** — `college-research-agent.service` on the instance

Quick path:

1. `infra/terraform/bootstrap` → `terraform apply` → GitHub secrets
2. `infra/terraform` → `terraform apply` with `gemini_api_key` in `terraform.tfvars`
3. Push to `main` or run **deploy** workflow
4. Set frontend `COLLEGE_AGENT_BASE_URL` to `terraform output agent_base_url`

Local production-style run:

```bash
npm run build
node dist/server.js
```
