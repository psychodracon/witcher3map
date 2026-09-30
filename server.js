"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_PATH = path.join(DATA_DIR, "state.sqlite");
const DEFAULT_SAVE_INTERVAL = 30;

const parseSaveInterval = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SAVE_INTERVAL;
  }
  return Math.floor(parsed);
};

const saveIntervalInSeconds = parseSaveInterval(
  process.env.SAVE_INTERVAL_IN_SECONDS
);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

console.log(
  `SQLite database: ${DB_PATH} — mount a host directory here or settings are lost when the container is removed`
);
console.log(`Save interval: ${saveIntervalInSeconds}s (SAVE_INTERVAL_IN_SECONDS)`);

const readState = () => {
  const row = db.prepare("SELECT data FROM app_state WHERE id = 1").get();
  if (!row) {
    return null;
  }
  return JSON.parse(row.data);
};

const writeState = (data) => {
  const payload = JSON.stringify(data);
  const updatedAt = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO app_state (id, data, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `
  ).run(payload, updatedAt);
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeStateObject = (value) => {
  if (!isPlainObject(value)) {
    return null;
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return null;
    }
    normalized[key] = entry;
  }
  return normalized;
};

const app = express();
const rootDir = __dirname;

app.use(express.json({ limit: "2mb" }));

app.get("/api/state", (_req, res) => {
  res.json({
    data: readState(),
    saveIntervalInSeconds,
  });
});

app.put("/api/state", (req, res) => {
  const normalized = normalizeStateObject(req.body);
  if (!normalized) {
    res.status(400).json({
      error: "Body must be a JSON object with string values only",
    });
    return;
  }

  writeState(normalized);
  res.json({ ok: true });
});

app.use(
  "/files/maps",
  express.static(path.join(rootDir, "files", "maps"), {
    maxAge: "7d",
    immutable: true,
  })
);

app.use(
  express.static(rootDir, {
    maxAge: "1h",
    setHeaders: (res, filePath) => {
      if (/\.(html?|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=60");
      }
    },
  })
);

app.listen(PORT, () => {
  console.log(`witcher3map server listening on http://0.0.0.0:${PORT}`);
});
