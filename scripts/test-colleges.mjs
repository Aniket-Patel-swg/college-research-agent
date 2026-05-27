#!/usr/bin/env node
/**
 * End-to-end test of POST /college-details across a mix of well-known and
 * obscure colleges from the ACPC dataset. For each college we capture:
 *   - HTTP status + elapsed time
 *   - Which top-level fields are present / missing
 *   - Any fields that leaked through as empty strings, "N/A", null, or 0
 *   - Whether the result passes the cache-completeness gate
 *   - The full raw JSON (for manual inspection)
 *
 * Writes everything to ./test-results.txt next to the project root.
 *
 * Usage:
 *   AGENT_URL=http://localhost:4810 node scripts/test-colleges.mjs
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:4810";
const OUTPUT_PATH = resolve(process.cwd(), "test-results.txt");

const COLLEGES = [
  // Tier 1 — well known, should produce rich data
  "Dhirubhai Ambani Institute of Info. & Comm. Tech., Gandhinagar",
  "Faculty Of Technology & Engineering(MSU), Vadodara",
  "Birla Vishvakarma Maha Vidhyalaya(Gia), V.V.Nagar",
  "Chandubhai S Patel Institute Of Technology, Changa",
  "Ahmedabad University, Ahmedabad",
  // Tier 2 — obscure, exercises the "omit if unknown" behaviour
  "Arrdekta Inst. Of Technology, Khedbrahma, Sabarkantha",
  "Dalia Institute of Technology, Kanera",
];

const TOP_LEVEL_FIELDS = [
  "collegeName",
  "institutionType",
  "location",
  "establishedYear",
  "websiteUrl",
  "about",
  "quickStats",
  "topRecruiters",
  "cutoffTrends",
  "competitionLevel",
  "admissionType",
  "campusInfrastructure",
  "applicationDeadline",
  "yearlyFee",
  "contact",
  "highlights",
  "sources",
];

const NULLY_SENTINELS = new Set([
  "",
  "n/a",
  "na",
  "not available",
  "not applicable",
  "unknown",
  "none",
  "null",
  "-",
  "--",
  "tbd",
  "to be announced",
]);

// Mirrors src/agent.ts NULLY_PATTERN — catches the wordier ways the model
// excuses missing data inside string fields (e.g. "Not available.", "Not
// available. Student reviews suggest…").
const NULLY_PATTERN =
  /^(information\s+)?(?:not\s+(?:available|applicable|reported|specified|disclosed|found|known)|no\s+(?:data|information)\s+available|data\s+(?:not\s+)?(?:available|disclosed|reported)|n\/a)\b/i;

/**
 * Recursively scan an object and return dotted paths to any value that LOOKS
 * like a placeholder (empty string, "N/A", null, 0 for a year field, etc.).
 * These are exactly the values we DON'T want leaking through — the normaliser
 * should be dropping them upstream.
 */
function findLeakedEmpties(node, path = "") {
  const hits = [];
  if (node === null) {
    hits.push(`${path} = null`);
    return hits;
  }
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (NULLY_SENTINELS.has(trimmed.toLowerCase()) || NULLY_PATTERN.test(trimmed)) {
      hits.push(`${path} = ${JSON.stringify(node)}`);
    }
    return hits;
  }
  if (typeof node === "number") {
    if (path.endsWith("establishedYear") && (node === 0 || node < 1700)) {
      hits.push(`${path} = ${node}`);
    }
    return hits;
  }
  if (Array.isArray(node)) {
    if (node.length === 0 && path) {
      // Empty arrays at a leaf are fine in our schema (we just want them omitted
      // ideally, but JSON-wise it's still falsy). Flag only deeply nested ones.
    }
    node.forEach((item, idx) => {
      hits.push(...findLeakedEmpties(item, `${path}[${idx}]`));
    });
    return hits;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      hits.push(...findLeakedEmpties(v, path ? `${path}.${k}` : k));
    }
  }
  return hits;
}

function classifyPresence(data) {
  const present = [];
  const missing = [];
  for (const f of TOP_LEVEL_FIELDS) {
    const v = data[f];
    const isPresent =
      v !== undefined &&
      v !== null &&
      !(typeof v === "string" && v.trim() === "") &&
      !(Array.isArray(v) && v.length === 0) &&
      !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    (isPresent ? present : missing).push(f);
  }
  return { present, missing };
}

/**
 * Mirrors src/cache.ts::completenessScore + CACHE_MIN_SCORE so we can predict
 * whether each response would be persisted to DynamoDB under the new
 * score-based gate. Returns { score, cacheable, missing }.
 */
const CACHE_MIN_SCORE = 0.2;
function checkCompleteness(d) {
  let score = 0;
  if (d.location) score += 0.10;
  if (d.establishedYear) score += 0.05;
  if (d.websiteUrl) score += 0.05;
  if (d.about) score += 0.05;
  const stats = d.quickStats ?? {};
  const statsFilled = [
    stats.campusSize, stats.avgPackage, stats.highestPackage,
    stats.totalFaculty, stats.studentStrength, stats.nirfRank,
  ].filter(Boolean).length;
  score += Math.min(statsFilled / 6, 1) * 0.15;
  score += Math.min((d.topRecruiters?.length ?? 0) / 6, 1) * 0.15;
  score += Math.min((d.cutoffTrends?.length ?? 0) / 3, 1) * 0.15;
  score += Math.min((d.campusInfrastructure?.length ?? 0) / 4, 1) * 0.05;
  score += Math.min((d.highlights?.length ?? 0) / 4, 1) * 0.03;
  if (d.competitionLevel) score += 0.05;
  if (d.admissionType) score += 0.03;
  if (d.applicationDeadline) score += 0.02;
  if (d.yearlyFee) score += 0.05;
  const contact = d.contact ?? {};
  if (contact.admissionsEmail || contact.admissionsPhone) score += 0.05;
  score += Math.min((d.sources?.length ?? 0) / 4, 1) * 0.02;

  const missing = [];
  if (!d.location) missing.push("location");
  if (!d.establishedYear) missing.push("establishedYear");
  if (!d.websiteUrl) missing.push("websiteUrl");
  if ((d.topRecruiters?.length ?? 0) < 3) missing.push(`topRecruiters(${d.topRecruiters?.length ?? 0})`);
  if ((d.cutoffTrends?.length ?? 0) < 1) missing.push("cutoffTrends");
  if (!contact.admissionsEmail && !contact.admissionsPhone) missing.push("contact");
  if ((d.sources?.length ?? 0) < 2) missing.push(`sources(${d.sources?.length ?? 0})`);

  return { score: Math.min(score, 1), cacheable: Boolean(d.collegeName) && score >= CACHE_MIN_SCORE, missing };
}

async function testOne(collegeName) {
  const started = Date.now();
  let status = 0;
  let body = null;
  let error = null;
  try {
    const res = await fetch(`${AGENT_URL}/college-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collegeName, refresh: true }),
    });
    status = res.status;
    body = await res.json().catch(() => ({ _parseError: true }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { collegeName, status, body, error, elapsedMs: Date.now() - started };
}

function renderReport(results) {
  const lines = [];
  const now = new Date().toISOString();
  lines.push(`college-research-agent — test run @ ${now}`);
  lines.push(`endpoint: ${AGENT_URL}/college-details (refresh=true)`);
  lines.push(`colleges tested: ${results.length}`);
  lines.push("=".repeat(80));

  // Summary table
  lines.push("");
  lines.push("SUMMARY");
  lines.push("-".repeat(80));
  lines.push(
    [
      "#".padEnd(3),
      "status".padEnd(7),
      "elapsed".padEnd(9),
      "present/total".padEnd(14),
      "leaked".padEnd(7),
      "score".padEnd(7),
      "cacheable".padEnd(10),
      "college",
    ].join(" "),
  );
  results.forEach((r, i) => {
    const data = r.body ?? {};
    const { present } = classifyPresence(data);
    const leaks = findLeakedEmpties(data);
    const { score, cacheable } = checkCompleteness(data);
    lines.push(
      [
        String(i + 1).padEnd(3),
        String(r.status).padEnd(7),
        `${r.elapsedMs}ms`.padEnd(9),
        `${present.length}/${TOP_LEVEL_FIELDS.length}`.padEnd(14),
        String(leaks.length).padEnd(7),
        score.toFixed(2).padEnd(7),
        (cacheable ? "yes" : "no").padEnd(10),
        r.collegeName,
      ].join(" "),
    );
  });

  // Per-college detail
  results.forEach((r, i) => {
    lines.push("");
    lines.push("=".repeat(80));
    lines.push(`[${i + 1}] ${r.collegeName}`);
    lines.push("-".repeat(80));
    lines.push(`status: ${r.status}   elapsed: ${r.elapsedMs}ms`);
    if (r.error) {
      lines.push(`fetch error: ${r.error}`);
      return;
    }
    const data = r.body ?? {};
    const { present, missing } = classifyPresence(data);
    lines.push(`present fields (${present.length}): ${present.join(", ")}`);
    lines.push(`missing fields (${missing.length}): ${missing.join(", ") || "—"}`);

    const leaks = findLeakedEmpties(data);
    lines.push(`leaked-empty/null/placeholder values: ${leaks.length}`);
    if (leaks.length) {
      leaks.forEach((l) => lines.push(`   - ${l}`));
    }

    const { score, cacheable, missing: cacheMissing } = checkCompleteness(data);
    lines.push(
      `cache-gate: score=${score.toFixed(2)} → ${cacheable ? "PASS (would persist)" : "FAIL (below 0.20 threshold)"}` +
        (cacheMissing.length ? `; thin fields: ${cacheMissing.join(", ")}` : ""),
    );

    lines.push("");
    lines.push("raw response:");
    lines.push(JSON.stringify(data, null, 2));
  });

  return lines.join("\n");
}

async function main() {
  console.log(`Testing ${COLLEGES.length} colleges against ${AGENT_URL}…`);
  const results = [];
  // Each college costs 1 grounded call (gemini-2.5-flash, 5 RPM) + 1 format
  // call (gemini-3.5-flash, 15 RPM). Pause 12s between colleges so the slower
  // 2.5-flash quota always has room. If we still hit a 429-induced 502, retry
  // once after a longer pause.
  async function runWithRetry(college) {
    let r = await testOne(college);
    if (r.status === 502 && !r.error) {
      const looksLikeQuota =
        typeof r.body?.error === "string" &&
        /quota|exhausted|rate|429/i.test(r.body.error);
      if (looksLikeQuota || r.elapsedMs < 5000) {
        process.stdout.write(" (rate-limited, retrying in 30s) ");
        await new Promise((resolve) => setTimeout(resolve, 30000));
        r = await testOne(college);
      }
    }
    return r;
  }
  for (const [idx, c] of COLLEGES.entries()) {
    process.stdout.write(`  • ${c} … `);
    const r = await runWithRetry(c);
    console.log(
      r.error ? `ERROR (${r.error})` : `${r.status} in ${r.elapsedMs}ms`,
    );
    results.push(r);
    if (idx < COLLEGES.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 12000));
    }
  }
  const report = renderReport(results);
  await writeFile(OUTPUT_PATH, report, "utf8");
  console.log(`\nReport written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
