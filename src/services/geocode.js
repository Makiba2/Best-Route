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

function extractLatLngFromText(value) {
  const match = String(value || "")
    .trim()
    .match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);

  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseGoogleMapsLink(input) {
  const raw = String(input || "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(raw);
  } catch (error) {
    return null;
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (!host.includes("google.") && !host.includes("goo.gl")) return null;

  const queryCandidates = [
    parsedUrl.searchParams.get("q"),
    parsedUrl.searchParams.get("query"),
    parsedUrl.searchParams.get("destination"),
    decodeURIComponent(parsedUrl.pathname || "").split("/").find((part) => part.startsWith("@")),
  ].filter(Boolean);

  for (const candidate of queryCandidates) {
    const fromAtPath = candidate.startsWith("@") ? candidate.slice(1) : candidate;
    const latLng = extractLatLngFromText(fromAtPath);
    if (latLng) {
      return {
        ...latLng,
        standardizedAddress: `Google Maps pin (${latLng.lat}, ${latLng.lng})`,
      };
    }
  }

  return {
    searchText:
      parsedUrl.searchParams.get("q") ||
      parsedUrl.searchParams.get("query") ||
      parsedUrl.searchParams.get("destination") ||
      null,
  };
}

async function expandGoogleMapsShortUrl(input) {
  const raw = String(input || "").trim();
  if (!/^https?:\/\//i.test(raw)) return raw;

  let parsedUrl;
  try {
    parsedUrl = new URL(raw);
  } catch (error) {
    return raw;
  }

  if (!parsedUrl.hostname.toLowerCase().includes("maps.app.goo.gl")) {
    return raw;
  }

  try {
    const response = await axios.get(raw, {
      maxRedirects: 10,
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    return response.request?.res?.responseUrl || raw;
  } catch (error) {
    return raw;
  }
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
  const fromGoogleLink = parseGoogleMapsLink(raw);
  if (fromGoogleLink?.searchText) {
    return buildGeocodeQueries(fromGoogleLink.searchText);
  }

  const queries = [raw];

  // If users paste CSV-like lines with extra columns, try the first segment too.
  const firstSegment = raw.split(",")[0]?.trim();
  if (firstSegment && firstSegment !== raw && firstSegment.length >= 4) {
    queries.push(firstSegment);
  }

  const plusCodeMatch = raw.match(/\b[A-Z0-9]{4,8}\+[A-Z0-9]{2,3}\b/i);
  if (plusCodeMatch?.[0]) {
    queries.push(plusCodeMatch[0].toUpperCase());
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

  if (defaultCountry && plusCodeMatch?.[0]) {
    queries.push(`${plusCodeMatch[0].toUpperCase()}, Accra, ${defaultCountry}`);
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
    const strictResponse = await googleClient.geocode({
      params: {
        address: query,
        key: apiKey,
        ...(defaultCountryCode ? { region: defaultCountryCode } : {}),
        ...(defaultCountryCode ? { components: `country:${defaultCountryCode}` } : {}),
      },
    });

    const strictMatch = strictResponse.data.results?.[0];
    if (strictMatch) {
      return {
        lat: strictMatch.geometry.location.lat,
        lng: strictMatch.geometry.location.lng,
        standardizedAddress: strictMatch.formatted_address,
      };
    }

    // Relax country constraints if strict pass returns nothing.
    const relaxedResponse = await googleClient.geocode({
      params: {
        address: query,
        key: apiKey,
      },
    });

    const relaxedMatch = relaxedResponse.data.results?.[0];
    if (!relaxedMatch) continue;

    return {
      lat: relaxedMatch.geometry.location.lat,
      lng: relaxedMatch.geometry.location.lng,
      standardizedAddress: relaxedMatch.formatted_address,
    };
  }

  return null;
}

async function geocodeAddresses(addresses, provider = "osm") {
  const normalizedProvider = provider === "google" ? "google" : "osm";
  const results = [];

  for (const address of addresses) {
    let location = null;

    const expandedAddress = await expandGoogleMapsShortUrl(address);
    const googleLink = parseGoogleMapsLink(expandedAddress);
    if (googleLink?.lat !== undefined && googleLink?.lng !== undefined) {
      results.push({
        rawAddress: address,
        standardizedAddress: googleLink.standardizedAddress,
        location: { lat: googleLink.lat, lng: googleLink.lng },
      });
      continue;
    }

    try {
      if (normalizedProvider === "google") {
        // Prefer Google when selected, but fall back to OSM if Google misses/rejects.
        location = await geocodeWithGoogle(expandedAddress);
        if (!location) {
          location = await geocodeWithOsm(expandedAddress);
        }
      } else {
        location = await geocodeWithOsm(expandedAddress);
      }
    } catch (error) {
      if (normalizedProvider === "google") {
        try {
          location = await geocodeWithOsm(expandedAddress);
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
