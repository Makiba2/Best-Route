const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SHARE_STOPS = 120;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
const dataDir = path.join(__dirname, "../../data/shared-routes");

function hasUpstashConfig() {
  return Boolean(
    String(process.env.UPSTASH_REDIS_REST_URL || "").trim() &&
      String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim(),
  );
}

function ensureShareStorageAvailable() {
  if (process.env.VERCEL === "1" && !hasUpstashConfig()) {
    const error = new Error(
      "Share links on Vercel need Upstash Redis. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to your environment.",
    );
    error.statusCode = 503;
    throw error;
  }
}

function isValidShareId(id) {
  return SHARE_ID_PATTERN.test(String(id || ""));
}

function validateSharePayload(payload) {
  if (!payload || payload.v !== 1) {
    const error = new Error("Invalid share payload.");
    error.statusCode = 400;
    throw error;
  }

  if (payload.kind === "route") {
    if (!Array.isArray(payload.stops) || !payload.stops.length) {
      const error = new Error("Shared route must include at least one stop.");
      error.statusCode = 400;
      throw error;
    }
    if (payload.stops.length > MAX_SHARE_STOPS) {
      const error = new Error(`Maximum ${MAX_SHARE_STOPS} stops per shared route.`);
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  if (payload.kind === "input") {
    const lines =
      typeof payload.stopsText === "string"
        ? payload.stopsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        : [];
    if (!lines.length) {
      const error = new Error("Shared route must include at least one address.");
      error.statusCode = 400;
      throw error;
    }
    if (lines.length > MAX_SHARE_STOPS) {
      const error = new Error(`Maximum ${MAX_SHARE_STOPS} stops per shared route.`);
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  const error = new Error("Unsupported share payload type.");
  error.statusCode = 400;
  throw error;
}

function createShareRecord(payload) {
  const now = Date.now();
  return {
    id: "",
    payload,
    createdAt: now,
    expiresAt: now + SHARE_TTL_MS,
  };
}

async function upstashRequest(pathSuffix, options = {}) {
  const baseUrl = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  const response = await fetch(`${baseUrl}${pathSuffix}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const error = new Error("Shared route storage is unavailable.");
    error.statusCode = 503;
    throw error;
  }

  return response.json();
}

async function saveToUpstash(record) {
  const ttlSeconds = Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000));
  const key = `share:${record.id}`;
  await upstashRequest(`/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(record))}?EX=${ttlSeconds}`, {
    method: "POST",
  });
}

async function readFromUpstash(id) {
  const key = `share:${id}`;
  const data = await upstashRequest(`/get/${encodeURIComponent(key)}`);
  if (data?.result == null) return null;
  try {
    return JSON.parse(data.result);
  } catch (error) {
    return null;
  }
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function shareFilePath(id) {
  return path.join(dataDir, `${id}.json`);
}

async function saveToFile(record) {
  await ensureDataDir();
  await fs.writeFile(shareFilePath(record.id), JSON.stringify(record), "utf8");
}

async function readFromFile(id) {
  try {
    const raw = await fs.readFile(shareFilePath(id), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function deleteExpiredFileShares() {
  await ensureDataDir();
  const files = await fs.readdir(dataDir);
  const now = Date.now();

  await Promise.all(
    files.map(async (fileName) => {
      if (!fileName.endsWith(".json")) return;
      const filePath = path.join(dataDir, fileName);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const record = JSON.parse(raw);
        if (!record?.expiresAt || record.expiresAt <= now) {
          await fs.unlink(filePath);
        }
      } catch (error) {
        // Ignore broken files during cleanup.
      }
    }),
  );
}

async function generateShareId() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = crypto.randomBytes(6).toString("base64url");
    if (!isValidShareId(id)) continue;

    if (hasUpstashConfig()) {
      const existing = await readFromUpstash(id);
      if (!existing) return id;
      continue;
    }

    await ensureDataDir();
    try {
      await fs.access(shareFilePath(id));
    } catch (error) {
      if (error.code === "ENOENT") return id;
      throw error;
    }
  }

  const error = new Error("Could not generate a unique share id.");
  error.statusCode = 500;
  throw error;
}

async function saveSharedRoute(payload) {
  validateSharePayload(payload);
  ensureShareStorageAvailable();

  if (!hasUpstashConfig()) {
    await deleteExpiredFileShares();
  }

  const record = createShareRecord(payload);
  record.id = await generateShareId();

  if (hasUpstashConfig()) {
    await saveToUpstash(record);
  } else {
    await saveToFile(record);
  }

  return record.id;
}

async function getSharedRoute(id) {
  if (!isValidShareId(id)) {
    const error = new Error("Invalid share link.");
    error.statusCode = 400;
    throw error;
  }

  ensureShareStorageAvailable();

  const record = hasUpstashConfig() ? await readFromUpstash(id) : await readFromFile(id);
  if (!record?.payload) {
    const error = new Error("Shared route not found or expired.");
    error.statusCode = 404;
    throw error;
  }

  if (record.expiresAt && record.expiresAt <= Date.now()) {
    const error = new Error("Shared route not found or expired.");
    error.statusCode = 404;
    throw error;
  }

  return record.payload;
}

module.exports = {
  saveSharedRoute,
  getSharedRoute,
  isValidShareId,
  validateSharePayload,
};
