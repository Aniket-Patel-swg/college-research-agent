import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import type { CollegeDetails } from "./types.js";

const CACHE_ENABLED = process.env.CACHE_ENABLED !== "false";
const TABLE_NAME = process.env.CACHE_TABLE_NAME ?? "CollegeResearchCache";
const REGION = process.env.AWS_REGION ?? "ap-south-1";

let rawClient: DynamoDBClient | null = null;
let docClient: DynamoDBDocumentClient | null = null;

function getRawClient(): DynamoDBClient {
  if (!rawClient) {
    rawClient = new DynamoDBClient({ region: REGION });
  }
  return rawClient;
}

function getClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(getRawClient(), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

/**
 * Bootstrap the cache on app startup: create the DynamoDB table if it doesn't
 * exist and warm the SDK client so the first /college-details request doesn't
 * pay the credential-resolution cost.
 *
 * Idempotent — safe to call on every boot. Non-fatal on transient AWS errors
 * (we log and continue; cache reads/writes already swallow failures).
 */
export async function ensureCacheTable(): Promise<void> {
  if (!CACHE_ENABLED) {
    console.log("[cache] disabled (CACHE_ENABLED=false), skipping table init");
    return;
  }

  const ddb = getRawClient();

  try {
    await ddb.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    console.log(
      `[cache] DynamoDB table "${TABLE_NAME}" already exists in ${REGION}`,
    );
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      console.warn(
        `[cache] DescribeTable failed — continuing without auto-create:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
  }

  console.log(
    `[cache] Creating DynamoDB table "${TABLE_NAME}" in ${REGION}...`,
  );
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: "cacheKey", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "cacheKey", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }

  await waitUntilTableExists(
    { client: ddb, maxWaitTime: 60 },
    { TableName: TABLE_NAME },
  );
  console.log(`[cache] DynamoDB table "${TABLE_NAME}" is ACTIVE`);
}

/**
 * Normalise the user's college name into a stable cache key. We lowercase,
 * strip punctuation, and collapse whitespace so "DA-IICT", "da iict" and
 * "DA-IICT Gandhinagar" don't all hit the agent independently.
 */
export function buildCacheKey(collegeName: string): string {
  return collegeName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The cache is gated by a *score* rather than a binary "all-or-nothing" rule,
 * so a thin-but-useful result for a small college (e.g. Arrdekta, which has
 * no published recruiter list) still gets persisted — and on a future
 * refresh we can replace it with a richer payload if one becomes available.
 *
 * Weights roughly mirror what the frontend renders: the hero (name, type,
 * location, website, year) plus quickStats / recruiters / cutoffs carry the
 * most weight; nice-to-haves like applicationDeadline are minor. Returns a
 * number in [0, 1]; ~0.20 = "we know basic identifiers", ~0.50 = "useful",
 * ~0.80 = "complete enough to look polished in the UI".
 */
export function completenessScore(d: CollegeDetails): number {
  let score = 0;
  if (d.location) score += 0.10;
  if (d.establishedYear) score += 0.05;
  if (d.websiteUrl) score += 0.05;
  if (d.about) score += 0.05;

  const stats = [
    d.quickStats.campusSize,
    d.quickStats.avgPackage,
    d.quickStats.highestPackage,
    d.quickStats.totalFaculty,
    d.quickStats.studentStrength,
    d.quickStats.nirfRank,
  ].filter(Boolean).length;
  score += Math.min(stats / 6, 1) * 0.15;

  score += Math.min(d.topRecruiters.length / 6, 1) * 0.15;
  score += Math.min(d.cutoffTrends.length / 3, 1) * 0.15;
  score += Math.min(d.campusInfrastructure.length / 4, 1) * 0.05;
  score += Math.min((d.highlights?.length ?? 0) / 4, 1) * 0.03;

  if (d.competitionLevel) score += 0.05;
  if (d.admissionType) score += 0.03;
  if (d.applicationDeadline) score += 0.02;
  if (d.yearlyFee) score += 0.05;
  if (d.contact.admissionsEmail || d.contact.admissionsPhone) score += 0.05;
  score += Math.min(d.sources.length / 4, 1) * 0.02;

  return Math.min(score, 1);
}

/**
 * Minimum score to enter the cache. Anything below this is genuinely empty
 * (e.g. the agent only managed to echo the college name) and not worth
 * burning a row on.
 */
export const CACHE_MIN_SCORE = 0.2;

export function isCacheable(d: CollegeDetails): boolean {
  // Need a real name plus *something* useful beyond just the name itself.
  return Boolean(d.collegeName) && completenessScore(d) >= CACHE_MIN_SCORE;
}

/**
 * Diagnostic helper — returns the list of missing top-level features along
 * with the score, so server logs can explain why a payload is rich/thin.
 */
export function checkCompleteness(d: CollegeDetails): {
  score: number;
  missing: string[];
} {
  const missing: string[] = [];
  if (!d.location) missing.push("location");
  if (!d.establishedYear) missing.push("establishedYear");
  if (!d.websiteUrl) missing.push("websiteUrl");
  if (d.topRecruiters.length < 3) missing.push(`topRecruiters(${d.topRecruiters.length})`);
  if (d.cutoffTrends.length < 1) missing.push("cutoffTrends");
  if (!d.contact.admissionsEmail && !d.contact.admissionsPhone) missing.push("contact");
  if (d.sources.length < 2) missing.push(`sources(${d.sources.length})`);
  return { score: completenessScore(d), missing };
}

type CacheRow = {
  cacheKey: string;
  payload: CollegeDetails;
};

export async function getCached(
  cacheKey: string,
): Promise<CollegeDetails | null> {
  if (!CACHE_ENABLED) return null;
  try {
    const res = await getClient().send(
      new GetCommand({ TableName: TABLE_NAME, Key: { cacheKey } }),
    );
    const item = res.Item as CacheRow | undefined;
    if (!item) return null;
    return { ...item.payload, fromCache: true };
  } catch (err) {
    console.warn("[cache] DynamoDB get failed, falling through:", err);
    return null;
  }
}

export async function putCached(
  cacheKey: string,
  payload: CollegeDetails,
): Promise<void> {
  if (!CACHE_ENABLED) return;
  try {
    const row: CacheRow = {
      cacheKey,
      payload: { ...payload, fromCache: false },
    };
    await getClient().send(
      new PutCommand({ TableName: TABLE_NAME, Item: row }),
    );
  } catch (err) {
    console.warn("[cache] DynamoDB put failed:", err);
  }
}
