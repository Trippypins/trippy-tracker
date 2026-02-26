import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

// Prefer local .env when running inside merch-outreach repo.
// On Render, env vars are set in the dashboard.
dotenv.config({ path: path.join(ROOT, ".env") });

const PORT = Number(process.env.PORT || 3000);
const LANDING_BASE = (process.env.LANDING_BASE || "").trim();

// Render disk can be ephemeral; /tmp is fine for basic tracking.
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "trippy-tracker");
const EVENTS_PATH = path.join(DATA_DIR, "events.jsonl");

fs.mkdirSync(DATA_DIR, { recursive: true });

function ipHash(ip) {
  try {
    return crypto.createHash("sha256").update(String(ip || "")).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function appendEvent(ev) {
  const line = JSON.stringify(ev) + "\n";
  await fs.promises.appendFile(EVENTS_PATH, line, "utf8");
}

async function readEvents() {
  try {
    const data = await fs.promises.readFile(EVENTS_PATH, "utf8");
    return data
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

function pickIndustryFromCampaign(campaign = "") {
  // campaign like "restaurants_v1"
  const idx = campaign.indexOf("_v");
  if (idx > 0) return campaign.slice(0, idx);
  return "";
}

const app = express();

// Tiny 1x1 gif (more compatible than png sometimes)
const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64"
);

app.get("/r/:lead_id", async (req, res) => {
  const lead_id = req.params.lead_id;
  const campaign = String(req.query.c || "");
  const industry = pickIndustryFromCampaign(campaign);
  const ua = req.get("user-agent") || "";
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "";
  const ev = {
    type: "click",
    lead_id,
    campaign,
    industry,
    ts: nowIso(),
    user_agent: ua,
    ip_hash: ipHash(ip),
  };

  try { await appendEvent(ev); } catch {}

  // Redirect to landing page with lid + utm params
  if (!LANDING_BASE) {
    return res.status(500).send("LANDING_BASE not configured");
  }

  const url = new URL(LANDING_BASE);
  url.searchParams.set("lid", lead_id);
  if (campaign) url.searchParams.set("utm_campaign", campaign);
  url.searchParams.set("utm_source", "coldemail");
  url.searchParams.set("utm_medium", "email");
  url.searchParams.set("c", campaign);

  res.redirect(302, url.toString());
});

app.get("/o/:lead_id.png", async (req, res) => {
  const lead_id = req.params.lead_id;
  const campaign = String(req.query.c || "");
  const industry = pickIndustryFromCampaign(campaign);
  const ua = req.get("user-agent") || "";
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "";
  const ev = {
    type: "open",
    lead_id,
    campaign,
    industry,
    ts: nowIso(),
    user_agent: ua,
    ip_hash: ipHash(ip),
  };

  try { await appendEvent(ev); } catch {}

  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.status(200).send(PIXEL_GIF);
});

app.get("/conv", async (req, res) => {
  const lead_id = String(req.query.lid || "");
  const campaign = String(req.query.c || "");
  const industry = pickIndustryFromCampaign(campaign);
  const ua = req.get("user-agent") || "";
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "";
  const ev = {
    type: "conv",
    lead_id,
    campaign,
    industry,
    ts: nowIso(),
    user_agent: ua,
    ip_hash: ipHash(ip),
  };

  try { await appendEvent(ev); } catch {}

  res.status(204).end();
});

// Simple stats page
app.get("/stats", async (_req, res) => {
  const events = await readEvents();

  const clicks = events.filter((e) => e.type === "click");
  const opens = events.filter((e) => e.type === "open");
  const conversions = events.filter((e) => e.type === "conv");

  function summarize(list) {
    const totalsByCampaign = {};
    const uniqueByCampaign = {};
    for (const e of list) {
      const c = e.campaign || "(none)";
      totalsByCampaign[c] = (totalsByCampaign[c] || 0) + 1;

      uniqueByCampaign[c] = uniqueByCampaign[c] || new Set();
      uniqueByCampaign[c].add(e.lead_id);
    }
    const rows = Object.keys(totalsByCampaign)
      .sort((a, b) => totalsByCampaign[b] - totalsByCampaign[a])
      .map((c) => ({
        campaign: c,
        total: totalsByCampaign[c],
        unique: uniqueByCampaign[c]?.size || 0,
      }));
    return rows;
  }

  const clickRows = summarize(clicks);
  const openRows = summarize(opens);
  const conversionRows = summarize(conversions);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <html>
      <head>
        <title>Trippy Tracker Stats</title>
        <style>
          body { font-family: -apple-system, system-ui, Segoe UI, Roboto, Arial; padding: 24px; }
          table { border-collapse: collapse; width: 100%; margin: 12px 0 28px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background: #f6f6f6; }
          .muted { color: #666; }
        </style>
      </head>
      <body>
        <h1>Trippy Tracker Stats</h1>
        <p class="muted">Events stored at: ${EVENTS_PATH}</p>

        <h2>Clicks</h2>
        <table>
          <tr><th>Campaign</th><th>Total</th><th>Unique Leads</th></tr>
          ${clickRows.map(r => `<tr><td>${r.campaign}</td><td>${r.total}</td><td>${r.unique}</td></tr>`).join("")}
        </table>

        <h2>Opens (directional)</h2>
        <table>
          <tr><th>Campaign</th><th>Total</th><th>Unique Leads</th></tr>
          ${openRows.map(r => `<tr><td>${r.campaign}</td><td>${r.total}</td><td>${r.unique}</td></tr>`).join("")}
        </table>

        <h2>Conversions</h2>
        <table>
          <tr><th>Campaign</th><th>Total</th><th>Unique Leads</th></tr>
          ${conversionRows.map(r => `<tr><td>${r.campaign}</td><td>${r.total}</td><td>${r.unique}</td></tr>`).join("")}
        </table>
      </body>
    </html>
  `);
});

app.get("/", (_req, res) => res.redirect("/stats"));

app.listen(PORT, () => {
  console.log(`Tracker running on port ${PORT}`);
});
