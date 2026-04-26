require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const { parse } = require("csv-parse/sync");
const { geocodeAddresses } = require("./src/services/geocode");
const { optimizeRoute } = require("./src/services/optimize");

const app = express();
const port = Number(process.env.PORT || 4000);
const publicDir = path.join(__dirname, "public");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  return res.sendFile(path.join(publicDir, "index.html"));
});

function normalizeInputAddresses({ addresses, pastedText, csvText }) {
  const fromList = Array.isArray(addresses) ? addresses : [];
  const fromPaste = typeof pastedText === "string" ? pastedText.split(/\r?\n/) : [];

  let fromCsv = [];
  if (typeof csvText === "string" && csvText.trim()) {
    const records = parse(csvText, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    fromCsv = records.map((row) => row.join(" ").trim());
  }

  return [...fromList, ...fromPaste, ...fromCsv]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

app.post("/api/optimize-route", async (req, res) => {
  try {
    const { transportMode = "driving", provider = "osm" } = req.body || {};
    const inputAddresses = normalizeInputAddresses(req.body || {});
    const { startAddress = "", startLocation = null } = req.body || {};

    if (!inputAddresses.length) {
      return res.status(400).json({ error: "No addresses provided." });
    }

    if (inputAddresses.length > 120) {
      return res.status(400).json({ error: "Maximum 120 destinations per request." });
    }

    const geocoded = await geocodeAddresses(inputAddresses, provider);

    const unresolved = geocoded.filter((entry) => !entry.location);
    const resolvedStops = geocoded.filter((entry) => entry.location);

    if (!resolvedStops.length) {
      const missingGoogleKey =
        provider === "google" && !String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
      return res.status(422).json({
        error: missingGoogleKey
          ? "No valid addresses could be geocoded. GOOGLE_MAPS_API_KEY is missing."
          : "No valid addresses could be geocoded. Please retry in a moment or refine address text.",
        unresolved: unresolved.map((item) => item.rawAddress),
      });
    }

    let normalizedStartPoint = null;
    let unresolvedStart = null;
    if (
      startLocation &&
      Number.isFinite(Number(startLocation.lat)) &&
      Number.isFinite(Number(startLocation.lng))
    ) {
      normalizedStartPoint = {
        rawAddress: "Current Location",
        standardizedAddress: "Current Location",
        location: {
          lat: Number(startLocation.lat),
          lng: Number(startLocation.lng),
        },
      };
    } else if (typeof startAddress === "string" && startAddress.trim()) {
      const [geocodedStart] = await geocodeAddresses([startAddress.trim()], provider);
      if (!geocodedStart?.location) {
        unresolvedStart = startAddress.trim();
      } else {
        normalizedStartPoint = geocodedStart;
      }
    }

    const routePlan = await optimizeRoute(resolvedStops, {
      transportMode,
      provider,
      startPoint: normalizedStartPoint,
    });

    return res.json({
      meta: {
        stopsRequested: inputAddresses.length,
        stopsResolved: resolvedStops.length,
        stopsSkipped: unresolved.length,
        unresolved: unresolved.map((item) => item.rawAddress),
        unresolvedStart,
        strategy: routePlan.strategy,
        provider: routePlan.provider,
      },
      route: routePlan,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Unexpected server error.",
    });
  }
});

if (process.env.VERCEL !== "1") {
  app.listen(port, () => {
    console.log(`Best-Route server running on http://localhost:${port}`);
  });
}

module.exports = app;
