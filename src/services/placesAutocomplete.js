const axios = require("axios");

const PLACES_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const defaultCountryCode = (process.env.DEFAULT_COUNTRY_CODE || "").trim().toLowerCase();

/**
 * Calls Places API (New) Place Autocomplete. Requires GOOGLE_MAPS_API_KEY and
 * "Places API (New)" enabled on the Google Cloud project.
 */
async function fetchPlaceAutocompleteSuggestions(input, sessionToken) {
  const apiKey = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("GOOGLE_MAPS_API_KEY is not configured.");
    err.code = "NO_KEY";
    throw err;
  }

  const trimmed = String(input || "").trim();
  if (trimmed.length < 2) {
    return [];
  }

  const body = {
    input: trimmed,
    languageCode: "en",
  };

  if (defaultCountryCode && defaultCountryCode.length === 2) {
    body.includedRegionCodes = [defaultCountryCode];
  }

  if (sessionToken && String(sessionToken).trim()) {
    body.sessionToken = String(sessionToken).trim();
  }

  const response = await axios.post(PLACES_AUTOCOMPLETE_URL, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    timeout: 12000,
    validateStatus: () => true,
  });

  const data = response.data || {};
  if (response.status >= 400) {
    const msg =
      data?.error?.message ||
      data?.error?.status ||
      `Places Autocomplete failed (HTTP ${response.status}).`;
    const err = new Error(msg);
    err.code = "PLACES_ERROR";
    err.status = response.status;
    throw err;
  }

  if (data?.error) {
    const err = new Error(data.error.message || "Places Autocomplete error.");
    err.code = "PLACES_ERROR";
    err.status = data.error.status;
    throw err;
  }

  const suggestions = [];
  for (const entry of data?.suggestions || []) {
    const p = entry.placePrediction;
    if (!p) continue;
    const description = p.text?.text || "";
    if (!description) continue;
    suggestions.push({
      description,
      placeId: p.placeId || null,
    });
  }

  return suggestions.slice(0, 10);
}

module.exports = {
  fetchPlaceAutocompleteSuggestions,
};
