const axios = require("axios");
const { Client } = require("@googlemaps/google-maps-services-js");

const googleClient = new Client({});
const defaultCountry = (process.env.DEFAULT_COUNTRY || "").trim();
const defaultCountryCode = (process.env.DEFAULT_COUNTRY_CODE || "").trim().toLowerCase();
const OSM_MIN_INTERVAL_MS = 1100;
let lastOsmRequestAt = 0;

function isLikelyPostalCode(input) {
  const value = String(input || "").trim();
  // Accept common postal formats like 12345, SW1A 1AA, 00233.
  return /^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/.test(value) && !/\d+\s+\w+\s+\w+/i.test(value);
}

function normalizeAddressInput(address) {
  const raw = String(address || "").trim();
  if (!raw) return "";

  return raw
    .replace(/^\s*\d+[\).\-\s]+/, "") // remove leading list numbers like "1. "
    .replace(/\s+/g, " ")
    .trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleOsmRequests() {
  const now = Date.now();
  const elapsed = now - lastOsmRequestAt;
  if (elapsed < OSM_MIN_INTERVAL_MS) {
    await wait(OSM_MIN_INTERVAL_MS - elapsed);
  }
  lastOsmRequestAt = Date.now();
}

function buildGeocodeQueries(address) {
  const raw = normalizeAddressInput(address);
  const queries = [raw];

  // If users paste CSV-like lines with extra columns, try the first segment too.
  const firstSegment = raw.split(",")[0]?.trim();
  if (firstSegment && firstSegment !== raw && firstSegment.length >= 4) {
    queries.push(firstSegment);
  }

  if (defaultCountry && !new RegExp(`\\b${defaultCountry}\\b`, "i").test(raw)) {
    queries.push(`${raw}, ${defaultCountry}`);
  }

  if (
    defaultCountry &&
    firstSegment &&
    !new RegExp(`\\b${defaultCountry}\\b`, "i").test(firstSegment)
  ) {
    queries.push(`${firstSegment}, ${defaultCountry}`);
  }

  if (defaultCountry && isLikelyPostalCode(raw)) {
    queries.push(`${raw}, ${defaultCountry}`);
  }

  return [...new Set(queries)].filter(Boolean);
}

async function geocodeWithOsm(address) {
  const queries = buildGeocodeQueries(address);

  for (const query of queries) {
    await throttleOsmRequests();

    let response;
    try {
      response = await axios.get("https://nominatim.openstreetmap.org/search", {
        params: {
          q: query,
          format: "jsonv2",
          limit: 1,
          ...(defaultCountryCode ? { countrycodes: defaultCountryCode } : {}),
        },
        headers: {
          "User-Agent": "best-route-delivery-system/1.0",
        },
      });
    } catch (error) {
      if (error.response?.status === 429) {
        // Back off once and retry same query.
        await wait(1800);
        await throttleOsmRequests();
        response = await axios.get("https://nominatim.openstreetmap.org/search", {
          params: {
            q: query,
            format: "jsonv2",
            limit: 1,
            ...(defaultCountryCode ? { countrycodes: defaultCountryCode } : {}),
          },
          headers: {
            "User-Agent": "best-route-delivery-system/1.0",
          },
        });
      } else {
        throw error;
      }
    }

    const first = response.data?.[0];
    if (!first) continue;

    return {
      lat: Number(first.lat),
      lng: Number(first.lon),
      standardizedAddress: first.display_name,
    };
  }

  return null;
}

async function geocodeWithGoogle(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is required for Google provider.");
  }

  const queries = buildGeocodeQueries(address);

  for (const query of queries) {
    const response = await googleClient.geocode({
      params: {
        address: query,
        key: apiKey,
        ...(defaultCountryCode ? { region: defaultCountryCode } : {}),
        ...(defaultCountryCode ? { components: `country:${defaultCountryCode}` } : {}),
      },
    });

    const first = response.data.results?.[0];
    if (!first) continue;

    return {
      lat: first.geometry.location.lat,
      lng: first.geometry.location.lng,
      standardizedAddress: first.formatted_address,
    };
  }

  return null;
}

async function geocodeAddresses(addresses, provider = "osm") {
  const normalizedProvider = provider === "google" ? "google" : "osm";
  const results = [];

  for (const address of addresses) {
    let location = null;
    try {
      if (normalizedProvider === "google") {
        // Prefer Google when selected, but fall back to OSM if Google misses/rejects.
        location = await geocodeWithGoogle(address);
        if (!location) {
          location = await geocodeWithOsm(address);
        }
      } else {
        location = await geocodeWithOsm(address);
      }
    } catch (error) {
      if (normalizedProvider === "google") {
        try {
          location = await geocodeWithOsm(address);
        } catch (fallbackError) {
          location = null;
        }
      } else {
        location = null;
      }
    }

    results.push({
      rawAddress: address,
      standardizedAddress: location?.standardizedAddress || null,
      location: location ? { lat: location.lat, lng: location.lng } : null,
    });
  }

  return results;
}

module.exports = {
  geocodeAddresses,
};
