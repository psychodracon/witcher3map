"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_PATH = path.join(DATA_DIR, "state.sqlite");
const DEFAULT_SAVE_INTERVAL_SECONDS = 30;
const JSON_BODY_LIMIT = "2mb";

const parseSaveInterval = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SAVE_INTERVAL_SECONDS;
  }
  return Math.floor(parsed);
};

const saveIntervalInSeconds = parseSaveInterval(
  process.env.SAVE_INTERVAL_IN_SECONDS
);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asStringMap = (value) => {
  if (!isPlainObject(value)) {
    return null;
  }

  const normalized = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return null;
    }
    normalized[key] = entry;
  }
  return normalized;
};

const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const selectState = db.prepare("SELECT data FROM app_state WHERE id = 1");
const upsertState = db.prepare(`
  INSERT INTO app_state (id, data, updated_at)
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    data = excluded.data,
    updated_at = excluded.updated_at
`);

console.log(
  `SQLite database: ${DB_PATH} — mount a host directory here or settings are lost when the container is removed`
);
console.log(
  `Save interval: ${saveIntervalInSeconds}s (SAVE_INTERVAL_IN_SECONDS)`
);

const storedRow = () => selectState.get() || null;

let latestRevision = 0;

const readState = () => {
  const row = storedRow();
  if (!row) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(row.data);
  } catch (err) {
    throw httpError(500, "Stored map state is not valid JSON");
  }

  const normalized = asStringMap(parsed);
  if (!normalized) {
    throw httpError(500, "Stored map state is not a string map");
  }
  return normalized;
};

const writeState = (data, revision) => {
  upsertState.run(JSON.stringify(data), new Date().toISOString());
  latestRevision = revision;
};

const parseRevision = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
};

const app = express();
const rootDir = __dirname;

app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.get("/api/state", (_req, res) => {
  res.json({
    data: readState(),
    revision: latestRevision,
    saveIntervalInSeconds,
  });
});

const saveStateRequest = (req, res) => {
  const normalized = asStringMap(req.body);
  if (!normalized) {
    throw httpError(
      400,
      "Body must be a JSON object with string values only"
    );
  }

  const revision = parseRevision(req.query.rev);
  if (revision === null) {
    throw httpError(400, "Missing revision");
  }
  if (revision < latestRevision) {
    res.json({ ok: true });
    return;
  }

  writeState(normalized, revision);
  res.json({ ok: true });
};

app.put("/api/state", saveStateRequest);
app.post("/api/state", saveStateRequest);

const MAP_PAGES = ["w", "v", "g", "s", "k", "i", "t", "f"];

const setShortCache = (res, filePath) => {
  if (/\.(html?|js|css)$/i.test(filePath)) {
    res.setHeader("Cache-Control", "public, max-age=60");
  }
};

app.use(
  "/files/maps",
  express.static(path.join(rootDir, "files", "maps"), {
    maxAge: "7d",
    immutable: true,
  })
);

app.use(
  "/files",
  express.static(path.join(rootDir, "files"), {
    maxAge: "1h",
    setHeaders: setShortCache,
  })
);

for (const page of MAP_PAGES) {
  app.use(
    `/${page}`,
    express.static(path.join(rootDir, page), {
      index: "index.html",
      maxAge: "1h",
      setHeaders: setShortCache,
    })
  );
}

app.get(["/", "/index.html"], (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use((err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status = Number(err.status || err.statusCode) || 500;
  res.status(status).json({
    error:
      status < 500 && err.message
        ? err.message
        : "Failed to read or write map state",
  });
});

const server = app.listen(PORT, () => {
  console.log(`witcher3map server listening on http://0.0.0.0:${PORT}`);
});

let databaseClosed = false;

const closeDatabase = () => {
  if (databaseClosed) {
    return;
  }
  databaseClosed = true;
  db.close();
};

const shutdown = (signal) => {
  console.log(`${signal} received, closing server`);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => {
    closeDatabase();
    process.exit(0);
  }, 2000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
