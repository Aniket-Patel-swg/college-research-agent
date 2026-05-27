import { GoogleGenAI, Type } from "@google/genai";

import type { CollegeDetails } from "./types.js";

/**
 * JSON-schema description of the `CollegeDetails` payload, used as Gemini's
 * `responseSchema`. Every field is optional (no `required` arrays) so the
 * model is free to omit anything it couldn't verify — far better than
 * fabricating an empty string. Gemini 2.5+ accepts schemas alongside the
 * `googleSearch` grounding tool, so we get structured output AND citations.
 *
 * `sources`, `generatedAt`, `fromCache`, `query` are NOT in the schema —
 * we populate them ourselves from `groundingMetadata` and request context.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    collegeName: { type: Type.STRING },
    institutionType: { type: Type.STRING },
    location: { type: Type.STRING },
    establishedYear: { type: Type.NUMBER },
    websiteUrl: { type: Type.STRING },
    about: { type: Type.STRING },
    quickStats: {
      type: Type.OBJECT,
      properties: {
        campusSize: { type: Type.STRING },
        avgPackage: { type: Type.STRING },
        highestPackage: { type: Type.STRING },
        totalFaculty: { type: Type.STRING },
        studentStrength: { type: Type.STRING },
        nirfRank: { type: Type.STRING },
      },
    },
    topRecruiters: { type: Type.ARRAY, items: { type: Type.STRING } },
    cutoffTrends: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          branch: { type: Type.STRING },
          rankRange: { type: Type.STRING },
          closingRankLow: { type: Type.NUMBER },
          closingRankHigh: { type: Type.NUMBER },
          notes: { type: Type.STRING },
        },
      },
    },
    competitionLevel: { type: Type.STRING },
    admissionType: { type: Type.STRING },
    campusInfrastructure: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
        },
      },
    },
    applicationDeadline: { type: Type.STRING },
    yearlyFee: { type: Type.STRING },
    contact: {
      type: Type.OBJECT,
      properties: {
        admissionsPhone: { type: Type.STRING },
        admissionsEmail: { type: Type.STRING },
        address: { type: Type.STRING },
      },
    },
    highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
};

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
// Pass 2 (formatting) doesn't need grounding, so we can use the same flash
// model with `responseSchema`. Override with GEMINI_FORMATTER_MODEL if you
// want a cheaper / smaller model for the second hop.
const FORMATTER_MODEL =
  process.env.GEMINI_FORMATTER_MODEL ?? "gemini-3.5-flash";

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

// ── system prompts ────────────────────────────────────────────────────────
//
// We can't combine `googleSearch` grounding and `responseSchema` in a single
// Gemini call on the free tier — the API rejects it with
// "Tool use with a response mime type: 'application/json' is unsupported".
// Instead we do a TWO-PASS run:
//   1. Research pass: grounded search → markdown report + groundingMetadata
//   2. Format pass: take the report, emit strict JSON via responseSchema
// Sources come from pass 1's groundingMetadata; pass 2 makes no web calls.

const RESEARCH_SYSTEM = `You are a research agent that helps Indian engineering aspirants by gathering accurate, up-to-date information about a specific engineering college.

You MUST use Google Search grounding to verify every numeric and factual claim from at least one authoritative source — the official college website, NIRF, AICTE, Shiksha, Collegedunia, Careers360, or major news outlets. Prefer official sources when they exist.

Run multiple targeted searches (e.g. "<college> placement report 2024", "<college> NIRF rank", "<college> ACPC cutoff", "<college> fees official").

Write the findings as a clean markdown brief with these sections (omit a section entirely if you can't verify it — DO NOT fabricate or write "N/A"):

## Basics
- Full official name
- Institution type (Private University / Govt-aided / Govt / Deemed / Autonomous)
- Location (City, State)
- Established year (4-digit)
- Official website URL
- 2–3 sentence overview

## Quick stats
- Campus size
- Latest average package
- Highest package
- Total faculty
- Student strength
- NIRF rank (with year)

## Top recruiters
Bulleted list of real companies known to recruit on campus (max 12).

## Cutoff trends
For 2–4 flagship branches, give the most recent ACPC/GUJCET/JoSAA closing rank (Open category) with year.

## Admissions
- Competition level: one of "Extremely High", "High", "Moderate", "Low"
- Admission route (e.g. "GUJCET + ACPC", "JEE Main + JoSAA")
- Application deadline (most recent / next)
- Yearly fee

## Campus infrastructure
2–6 notable facilities, one line each.

## Contact
- Admissions phone
- Admissions email
- Address

## Highlights
2–6 distinguishing achievements / facts.`;

const FORMAT_SYSTEM = `You are a data-extraction formatter. Convert the research brief in the user message into a single JSON object matching the response schema.

CORE INSTRUCTION: Extract EVERYTHING the brief contains. Be exhaustive — every list of recruiters, every cutoff trend, every infrastructure item, every highlight in the brief MUST appear in the corresponding JSON array. Treat the brief as the ground truth and copy facts faithfully.

RULES:
1. For each scalar field (location, establishedYear, websiteUrl, yearlyFee, etc.): if the brief mentions it, include it. If the brief truly doesn't mention it, omit that key entirely.
2. For ARRAYS (topRecruiters, cutoffTrends, campusInfrastructure, highlights): scan the brief for any bullets, paragraphs, or sentences that could populate them, and emit one entry per item. Only return [] if the brief contains zero relevant items.
3. For NESTED OBJECTS (quickStats, contact): fill every sub-key that the brief mentions, anywhere — even if expressed casually (e.g. "the campus spans 50 acres" → quickStats.campusSize = "50 acres").
4. Numbers (\`establishedYear\`, \`closingRankLow\`, \`closingRankHigh\`) must be plain numbers, not strings.
5. \`competitionLevel\` must be exactly one of "Extremely High", "High", "Moderate", "Low" or omitted.
6. Do NOT invent facts that are not in the brief. But if a fact is THERE, extract it.`;

// ── helpers ───────────────────────────────────────────────────────────────

function stripCodeFences(s: string): string {
  const t = s.trim();
  if (!t.startsWith("```")) return t;
  return t
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseAgentJson(raw: string): Record<string, unknown> {
  const cleaned = stripCodeFences(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error("Agent did not return JSON");
  }
  return JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
}

const NULLY_SENTINELS = new Set([
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

// Catches verbose model excuses like "Not available." / "Information not
// available" / "Data not reported" / "Not specified in the brief" — anywhere
// the model emits a refusal instead of omitting the key. We strip these even
// when they're preceded/followed by extra commentary.
const NULLY_PATTERN =
  /^(information\s+)?(?:not\s+(?:available|applicable|reported|specified|disclosed|found|known)|no\s+(?:data|information)\s+available|data\s+(?:not\s+)?(?:available|disclosed|reported)|n\/a)\b/i;

function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (NULLY_SENTINELS.has(trimmed.toLowerCase())) return undefined;
  // Drop strings whose entire purpose is to apologise for missing data, even
  // if the model dressed them up with extra commentary.
  if (NULLY_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[, ]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function asStringArray(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => asString(x) ?? "")
    .filter((x) => x.length > 0)
    .slice(0, limit);
}
function pickCompetition(v: unknown): CollegeDetails["competitionLevel"] {
  const s = asString(v);
  if (!s) return undefined;
  const n = s.toLowerCase();
  if (n.includes("extreme")) return "Extremely High";
  if (n.includes("high")) return "High";
  if (n.includes("moderate") || n.includes("medium")) return "Moderate";
  if (n.includes("low")) return "Low";
  return undefined;
}

function normaliseAgentJson(
  query: string,
  raw: Record<string, unknown>,
): CollegeDetails {
  const stats = (raw.quickStats as Record<string, unknown> | undefined) ?? {};
  const contact = (raw.contact as Record<string, unknown> | undefined) ?? {};

  const cutoffsIn = Array.isArray(raw.cutoffTrends) ? raw.cutoffTrends : [];
  const cutoffTrends = cutoffsIn
    .map((row): CollegeDetails["cutoffTrends"][number] | null => {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      const branch = asString(r.branch);
      if (!branch) return null;
      return {
        branch,
        rankRange: asString(r.rankRange),
        closingRankLow: asNumber(r.closingRankLow),
        closingRankHigh: asNumber(r.closingRankHigh),
        notes: asString(r.notes),
      };
    })
    .filter((x): x is CollegeDetails["cutoffTrends"][number] => x !== null)
    .slice(0, 6);

  const infraIn = Array.isArray(raw.campusInfrastructure)
    ? raw.campusInfrastructure
    : [];
  const campusInfrastructure = infraIn
    .map((row): CollegeDetails["campusInfrastructure"][number] | null => {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      const name = asString(r.name);
      if (!name) return null;
      return { name, description: asString(r.description) };
    })
    .filter(
      (x): x is CollegeDetails["campusInfrastructure"][number] => x !== null,
    )
    .slice(0, 8);

  return {
    query,
    collegeName: asString(raw.collegeName) ?? query,
    institutionType: asString(raw.institutionType),
    location: asString(raw.location),
    establishedYear: (() => {
      const y = asNumber(raw.establishedYear);
      // Reject placeholders the model occasionally emits when it doesn't know.
      if (y === undefined || y < 1700 || y > new Date().getFullYear() + 1)
        return undefined;
      return y;
    })(),
    websiteUrl: asString(raw.websiteUrl),
    logoUrl: asString(raw.logoUrl),
    about: asString(raw.about),
    quickStats: {
      campusSize: asString(stats.campusSize),
      avgPackage: asString(stats.avgPackage),
      highestPackage: asString(stats.highestPackage),
      totalFaculty: asString(stats.totalFaculty),
      studentStrength: asString(stats.studentStrength),
      nirfRank: asString(stats.nirfRank),
    },
    topRecruiters: asStringArray(raw.topRecruiters, 12),
    cutoffTrends,
    competitionLevel: pickCompetition(raw.competitionLevel),
    admissionType: asString(raw.admissionType),
    campusInfrastructure,
    applicationDeadline: asString(raw.applicationDeadline),
    yearlyFee: asString(raw.yearlyFee),
    contact: {
      admissionsPhone: asString(contact.admissionsPhone),
      admissionsEmail: asString(contact.admissionsEmail),
      address: asString(contact.address),
    },
    highlights: asStringArray(raw.highlights, 6),
    sources: [],
    generatedAt: new Date().toISOString(),
    fromCache: false,
  };
}

/**
 * Pull URL citations out of Gemini's `groundingMetadata.groundingChunks`.
 * Each chunk has a `web: { uri, title }` for the source that backed a claim.
 */
function extractSources(response: unknown): { title?: string; url: string }[] {
  const out: { title?: string; url: string }[] = [];
  const seen = new Set<string>();

  const candidates = (response as { candidates?: unknown[] }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return out;

  for (const cand of candidates) {
    const gm = (cand as { groundingMetadata?: unknown }).groundingMetadata as
      | { groundingChunks?: unknown[] }
      | undefined;
    const chunks = gm?.groundingChunks;
    if (!Array.isArray(chunks)) continue;

    for (const c of chunks) {
      const web = (c as { web?: { uri?: string; title?: string } }).web;
      if (!web?.uri) continue;
      if (seen.has(web.uri)) continue;
      seen.add(web.uri);
      out.push({ url: web.uri, title: web.title });
    }
  }
  return out;
}

function extractText(response: unknown): string {
  const direct = (response as { text?: string }).text;
  if (typeof direct === "string" && direct.trim()) return direct;

  // Fallback for older SDKs / streamed shapes: walk candidates -> content.parts.
  const candidates = (response as { candidates?: unknown[] }).candidates;
  if (!Array.isArray(candidates)) return "";
  let text = "";
  for (const cand of candidates) {
    const parts = ((cand as { content?: { parts?: unknown[] } }).content
      ?.parts ?? []) as { text?: string }[];
    for (const p of parts) {
      if (typeof p?.text === "string") text += p.text;
    }
  }
  return text;
}

/** Loose-typed handle to the Gemini SDK's `generateContent` method. The SDK's
 *  generic types vary across minor versions; this shim keeps us insulated. */
type GenerateContent = (args: Record<string, unknown>) => Promise<unknown>;
function genContent(): GenerateContent {
  const ai = getClient();
  return (
    ai as unknown as {
      models: { generateContent: GenerateContent };
    }
  ).models.generateContent;
}

/**
 * Pass 1 — research with Google Search grounding. Produces a markdown brief
 * and exposes citation chunks via `groundingMetadata`. No schema here, since
 * Gemini's free tier doesn't allow tool use + responseSchema in the same call.
 */
async function researchPass(collegeName: string): Promise<{
  brief: string;
  response: unknown;
}> {
  const userPrompt = `Research the engineering college named "${collegeName}" (assume India / Gujarat context unless the name clearly points elsewhere). Use Google Search aggressively to verify every fact.`;

  const response = await genContent().call(undefined, {
    model: MODEL,
    contents: userPrompt,
    config: {
      systemInstruction: RESEARCH_SYSTEM,
      // Famous colleges produce verbose briefs — leave plenty of headroom so
      // the report never truncates mid-section.
      maxOutputTokens: 8192,
      tools: [{ googleSearch: {} }],
    },
  });

  const brief = extractText(response);
  if (!brief.trim()) throw new Error("Research pass returned empty output");
  return { brief, response };
}

/**
 * Pass 2 — convert the research brief into strict JSON via `responseSchema`.
 * No tools, no grounding — pure structural reformat. This is where the user-
 * requested `responseMimeType: "application/json"` + `responseSchema` lives.
 */
async function formatPass(
  collegeName: string,
  brief: string,
): Promise<Record<string, unknown>> {
  const response = await genContent().call(undefined, {
    model: FORMATTER_MODEL,
    contents: `College name (for the collegeName field): ${collegeName}\n\nResearch brief:\n\n${brief}`,
    config: {
      systemInstruction: FORMAT_SYSTEM,
      // JSON output for famous colleges (lots of recruiters, cutoffs,
      // highlights) can easily exceed 4k. Truncation here produces an
      // unparseable response and a 502 to the caller.
      maxOutputTokens: 8192,
      // Disable thinking on the format pass — this is a pure structural
      // reformat and we've observed thinking-traces leaking into string
      // fields when it's left on. Gemini API rejects setting BOTH keys
      // ("You can only set only one of thinking budget and thinking level"),
      // so we pick whichever the active model accepts: 3.x → thinkingLevel,
      // 2.x → thinkingBudget.
      thinkingConfig: /^gemini-3/.test(FORMATTER_MODEL)
        ? { thinkingLevel: "low" }
        : { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const text = extractText(response);
  if (!text.trim()) {
    console.error(
      "[agent] format pass returned empty text. Response:",
      JSON.stringify(response).slice(0, 1200),
    );
    throw new Error("Format pass returned empty output");
  }
  try {
    return parseAgentJson(text);
  } catch (err) {
    console.error(
      `[agent] format pass JSON parse failed (text len=${text.length}, first 400 chars):\n${text.slice(0, 400)}\n…last 200:\n${text.slice(-200)}`,
    );
    throw err;
  }
}

/**
 * Public entry point. Runs research → format and stitches sources from pass 1
 * into the structured payload from pass 2.
 */
export async function researchCollege(
  collegeName: string,
): Promise<CollegeDetails> {
  const { brief, response: researchResponse } = await researchPass(collegeName);
  console.log(
    `[agent] research brief for "${collegeName}" len=${brief.length}`,
  );
  const parsed = await formatPass(collegeName, brief);
  const details = normaliseAgentJson(collegeName, parsed);
  details.sources = extractSources(researchResponse);
  return details;
}
