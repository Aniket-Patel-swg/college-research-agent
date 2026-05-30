import "dotenv/config";

import cors from "cors";
import express from "express";
import type { Request, Response } from "express";

import { researchCollege } from "./agent.js";
import {
  buildCacheKey,
  checkCompleteness,
  completenessScore,
  ensureCacheTable,
  getCached,
  isCacheable,
  putCached,
} from "./cache.js";
import { COLLEGES, isCollegeName } from "./colleges.js";

const PORT = Number(process.env.PORT ?? 4810);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
  }),
);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/colleges", (_req: Request, res: Response) => {
  res.json(
    (COLLEGES as readonly { instCode: string; name: string; featured?: boolean }[]).map(
      ({ instCode, name, featured }) => ({
        instCode,
        name,
        featured: featured ?? false,
      }),
    ),
  );
});

type CollegeDetailsRequest = { collegeName?: string; refresh?: boolean };

async function handleCollegeDetails(
  collegeName: string,
  refresh: boolean,
  res: Response,
): Promise<void> {
  if (!isCollegeName(collegeName)) {
    res.status(400).json({ error: "invalid college enum" });
    return;
  }

  const cacheKey = buildCacheKey(collegeName);
  const existing = await getCached(cacheKey);
  if (!refresh && existing) {
    res.json(existing);
    return;
  }

  try {
    const details = await researchCollege(collegeName);
    const { score, missing } = checkCompleteness(details);
    const oldScore = existing ? completenessScore(existing) : 0;
    const fmt = (n: number) => n.toFixed(2);

    if (!isCacheable(details)) {
      console.warn(
        `[college-details] NOT caching "${collegeName}" (score=${fmt(score)}, missing=${missing.join(",") || "—"})`,
      );
      res.json(existing ?? details);
      return;
    }

    if (score >= oldScore) {
      void putCached(cacheKey, details);
      console.log(
        `[college-details] cached "${collegeName}" (score=${fmt(score)}, was=${fmt(oldScore)}, missing=${missing.join(",") || "—"})`,
      );
      res.json(details);
    } else {
      console.log(
        `[college-details] keeping richer cache for "${collegeName}" (new=${fmt(score)} < cached=${fmt(oldScore)})`,
      );
      res.json(existing ?? details);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[college-details] agent failed:", message);
    res.status(502).json({ error: `Agent failed: ${message}` });
  }
}

/**
 * POST /college-details
 * body: { collegeName: string, refresh?: boolean }
 */
app.post("/college-details", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CollegeDetailsRequest;
  const collegeName =
    typeof body.collegeName === "string" ? body.collegeName.trim() : "";
  if (!collegeName) {
    res.status(400).json({ error: "`collegeName` (string) is required" });
    return;
  }
  await handleCollegeDetails(collegeName, body.refresh === true, res);
});

/**
 * GET /college-details?collegeName=...&refresh=true
 * Handy for browser testing.
 */
app.get("/college-details", async (req: Request, res: Response) => {
  const collegeName =
    typeof req.query.collegeName === "string"
      ? req.query.collegeName.trim()
      : "";
  if (!collegeName) {
    res.status(400).json({ error: "`collegeName` query param is required" });
    return;
  }
  await handleCollegeDetails(collegeName, req.query.refresh === "true", res);
});

async function main(): Promise<void> {
  await ensureCacheTable();
  app.listen(PORT, () => {
    console.log(`college-research-agent listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[startup] fatal error:", err);
  process.exit(1);
});
