import express from "express";
import sqlite3 from "sqlite3";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });

const PORT = Number(process.env.PORT || 3000);
const LANDING_BASE = process.env.LANDING_BASE || "";

const dbPath = path.join(__dirname, "data.sqlite");
const sqlite = sqlite3.verbose();
const db = new sqlite.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT NOT NULL,
      campaign TEXT,
      industry TEXT,
      ts TEXT NOT NULL,
      user_agent TEXT,
      ip_hash TEXT
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS opens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT NOT NULL,
      campaign TEXT,
      industry TEXT,
      ts TEXT NOT NULL,
      user_agent TEXT,
      ip_hash TEXT
    )
  `);
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(ip || "").digest("hex");
}

function getIndustryFromCampaign(campaign) {
  if (!campaign) return "";
  const idx = campaign.indexOf("_");
  return idx === -1 ? campaign : campaign.slice(0, idx);
}

const app = express();
app.set("trust proxy", true);

app.get("/r/:lead_id", async (req, res) => {
  const leadId = String(req.params.lead_id);
  const campaign = String(req.query.c || "");
  const industry = getIndustryFromCampaign(campaign);
  const ts = new Date().toISOString();
  const ua = req.headers["user-agent"] || "";
  const ipHash = hashIp(req.ip);

  await run(
    "INSERT INTO clicks (lead_id, campaign, industry, ts, user_agent, ip_hash) VALUES (?, ?, ?, ?, ?, ?)",
    [leadId, campaign, industry, ts, ua, ipHash]
  );

  const landing = LANDING_BASE || "";
  const redirectUrl = landing
    ? `${landing}?lid=${encodeURIComponent(leadId)}&utm_campaign=${encodeURIComponent(campaign)}`
    : `/stats`;

  res.redirect(302, redirectUrl);
});

app.get("/o/:lead_id.png", async (req, res) => {
  const leadId = String(req.params.lead_id);
  const campaign = String(req.query.c || "");
  const industry = getIndustryFromCampaign(campaign);
  const ts = new Date().toISOString();
  const ua = req.headers["user-agent"] || "";
  const ipHash = hashIp(req.ip);

  await run(
    "INSERT INTO opens (lead_id, campaign, industry, ts, user_agent, ip_hash) VALUES (?, ?, ?, ?, ?, ?)",
    [leadId, campaign, industry, ts, ua, ipHash]
  );

  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0G0b8AAAAASUVORK5CYII=",
    "base64"
  );
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.status(200).send(pixel);
});

app.get("/stats", async (req, res) => {
  const clickTotals = await all(
    "SELECT campaign, COUNT(*) as total FROM clicks GROUP BY campaign ORDER BY total DESC"
  );
  const clickUnique = await all(
    "SELECT campaign, COUNT(DISTINCT lead_id) as unique_leads FROM clicks GROUP BY campaign ORDER BY unique_leads DESC"
  );
  const industryTotals = await all(
    "SELECT industry, COUNT(*) as total FROM clicks GROUP BY industry ORDER BY total DESC"
  );
  const industryUnique = await all(
    "SELECT industry, COUNT(DISTINCT lead_id) as unique_leads FROM clicks GROUP BY industry ORDER BY unique_leads DESC"
  );

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Tracker Stats</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #222; }
    h1 { margin-bottom: 8px; }
    table { border-collapse: collapse; margin-bottom: 24px; width: 100%; max-width: 720px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>Merch Outreach Tracker</h1>
  <h2>Clicks by Campaign</h2>
  <table>
    <tr><th>Campaign</th><th>Total</th></tr>
    ${clickTotals.map(r => `<tr><td>${r.campaign || "(none)"}</td><td>${r.total}</td></tr>`).join("")}
  </table>
  <h2>Unique Clicks by Campaign</h2>
  <table>
    <tr><th>Campaign</th><th>Unique Leads</th></tr>
    ${clickUnique.map(r => `<tr><td>${r.campaign || "(none)"}</td><td>${r.unique_leads}</td></tr>`).join("")}
  </table>
  <h2>Clicks by Industry</h2>
  <table>
    <tr><th>Industry</th><th>Total</th></tr>
    ${industryTotals.map(r => `<tr><td>${r.industry || "(none)"}</td><td>${r.total}</td></tr>`).join("")}
  </table>
  <h2>Unique Clicks by Industry</h2>
  <table>
    <tr><th>Industry</th><th>Unique Leads</th></tr>
    ${industryUnique.map(r => `<tr><td>${r.industry || "(none)"}</td><td>${r.unique_leads}</td></tr>`).join("")}
  </table>
</body>
</html>`;

  res.status(200).send(html);
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Tracker running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error("Failed to init db", err);
  process.exit(1);
});
