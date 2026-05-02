const map = L.map("map").setView([5.6037, -0.187], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const optimizeBtn = document.getElementById("optimizeBtn");
const sidebarEl = document.getElementById("sidebar");
const openSidebarBtn = document.getElementById("openSidebarBtn");
const closeSidebarBtn = document.getElementById("closeSidebarBtn");
const useGpsBtn = document.getElementById("useGpsBtn");
const providerEl = document.getElementById("provider");
const transportModeEl = document.getElementById("transportMode");
const startAddressEl = document.getElementById("startAddress");
const returnToStartEl = document.getElementById("returnToStart");
const pastedTextEl = document.getElementById("pastedText");
const addressSuggestionsEl = document.getElementById("addressSuggestions");
const startAddressSuggestionsEl = document.getElementById("startAddressSuggestions");
const csvFileEl = document.getElementById("csvFile");
const gpsStatusEl = document.getElementById("gpsStatus");
const followStatusEl = document.getElementById("followStatus");
const nextStopHintEl = document.getElementById("nextStopHint");
const statusEl = document.getElementById("status");
const unresolvedWrapEl = document.getElementById("unresolvedWrap");
const unresolvedListEl = document.getElementById("unresolvedList");
const stopSearchEl = document.getElementById("stopSearch");
const undoDoneBtn = document.getElementById("undoDoneBtn");
const stopsListEl = document.getElementById("stopsList");
const completedStopsListEl = document.getElementById("completedStopsList");
const totalsEl = document.getElementById("totals");

let markers = [];
let routeLayer = null;
let selectedGpsStart = null;
let liveLocationMarker = null;
let liveWatchId = null;
let currentRouteStops = [];
let completedRouteStops = [];
let currentRouteStartPoint = null;
let currentRouteEndPoint = null;
let latestLiveLocation = null;
let lastUndoSnapshot = null;
let lastRerouteLocation = null;
let lastRerouteAt = 0;
let liveRerouteInFlight = false;
let stopUidCounter = 1;
const mobileMediaQuery = window.matchMedia("(max-width: 900px)");
const LIVE_REROUTE_MIN_MOVEMENT_M = 45;
const LIVE_REROUTE_MIN_INTERVAL_MS = 5000;
const STOP_REACHED_RADIUS_M = 45;
const ROUTE_PROGRESS_STORAGE_KEY = "best-route-progress-v1";
let lastMapInteractionAt = 0;

let googlePlacesAutocompleteEnabled = false;
let manualAutocompleteSessionToken = null;
let startAutocompleteSessionToken = null;
let manualSuggestRange = null;
let manualSuggestTimer = null;
let startSuggestTimer = null;
let manualSuggestBlurTimer = null;
let startSuggestBlurTimer = null;

map.on("zoomstart", () => {
  lastMapInteractionAt = Date.now();
});
map.on("dragstart", () => {
  lastMapInteractionAt = Date.now();
});

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b20020" : "#394451";
}

function assignStopIds(stops) {
  return (stops || []).map((stop) => ({
    ...stop,
    id: stop.id || `stop-${stopUidCounter++}`,
  }));
}

function getCurrentSearchTerm() {
  return String(stopSearchEl.value || "").trim().toLowerCase();
}

function renderCompletedStops() {
  completedStopsListEl.innerHTML = "";
  for (const stop of completedRouteStops) {
    const li = document.createElement("li");
    li.className = "completed-stop-label";
    li.textContent = stop.rawAddress || stop.standardizedAddress;
    completedStopsListEl.appendChild(li);
  }
}

function saveRouteProgress() {
  try {
    const payload = {
      currentRouteStops,
      completedRouteStops,
      currentRouteStartPoint,
      currentRouteEndPoint,
      totalsText: totalsEl.textContent || "",
      statusText: statusEl.textContent || "",
    };
    localStorage.setItem(ROUTE_PROGRESS_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    // Ignore storage failures silently (private mode/quota issues).
  }
}

function clearRouteProgress() {
  try {
    localStorage.removeItem(ROUTE_PROGRESS_STORAGE_KEY);
  } catch (error) {
    // Ignore storage failures silently.
  }
}

function restoreRouteProgress() {
  try {
    const raw = localStorage.getItem(ROUTE_PROGRESS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.currentRouteStops)) return;

    currentRouteStops = assignStopIds(parsed.currentRouteStops).map((stop, index) => ({
      ...stop,
      sequence: index + 1,
    }));
    completedRouteStops = assignStopIds(
      Array.isArray(parsed.completedRouteStops) ? parsed.completedRouteStops : [],
    );
    currentRouteStartPoint = parsed.currentRouteStartPoint || null;
    currentRouteEndPoint = parsed.currentRouteEndPoint || null;
    totalsEl.textContent = parsed.totalsText || "";
    if (parsed.statusText) setStatus(parsed.statusText);

    renderStopList(currentRouteStops);
    renderCompletedStops();
    drawRoute({
      orderedStops: currentRouteStops,
      startPoint: currentRouteStartPoint,
      endPoint: currentRouteEndPoint,
      geometry: null,
      directionsOverviewPolyline: null,
    });
  } catch (error) {
    // Ignore invalid saved payload.
  }
}

function clearMap() {
  markers.forEach((marker) => marker.remove());
  markers = [];

  if (routeLayer) {
    routeLayer.remove();
    routeLayer = null;
  }

  if (liveLocationMarker) {
    liveLocationMarker.remove();
    liveLocationMarker = null;
  }
}

function isMobileView() {
  return mobileMediaQuery.matches;
}

function syncMobileNavButtons() {
  if (!isMobileView()) {
    openSidebarBtn.style.display = "none";
    closeSidebarBtn.style.display = "none";
    return;
  }

  const isOpen = sidebarEl.classList.contains("mobile-open");
  openSidebarBtn.style.display = isOpen ? "none" : "inline-block";
  closeSidebarBtn.style.display = isOpen ? "inline-block" : "none";
}

function openSidebar() {
  if (!isMobileView()) return;
  sidebarEl.classList.add("mobile-open");
  document.body.classList.add("sidebar-open");
  syncMobileNavButtons();
  window.setTimeout(() => map.invalidateSize(), 260);
}

function closeSidebar() {
  if (!isMobileView()) return;
  sidebarEl.classList.remove("mobile-open");
  document.body.classList.remove("sidebar-open");
  syncMobileNavButtons();
  window.setTimeout(() => map.invalidateSize(), 260);
}

function renderUnresolved(unresolved = []) {
  unresolvedListEl.innerHTML = "";

  if (!unresolved.length) {
    unresolvedWrapEl.classList.add("hidden");
    return;
  }

  for (const address of unresolved) {
    const li = document.createElement("li");
    li.textContent = address;
    unresolvedListEl.appendChild(li);
  }

  unresolvedWrapEl.classList.remove("hidden");
}

openSidebarBtn.addEventListener("click", openSidebar);
closeSidebarBtn.addEventListener("click", closeSidebar);
mobileMediaQuery.addEventListener("change", () => {
  if (!isMobileView()) {
    sidebarEl.classList.remove("mobile-open");
    document.body.classList.remove("sidebar-open");
    map.invalidateSize();
  }
  syncMobileNavButtons();
});
syncMobileNavButtons();

function newSessionToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `st-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function refreshClientConfig() {
  try {
    const response = await fetch("/api/config");
    const data = await response.json();
    googlePlacesAutocompleteEnabled = Boolean(data.googlePlacesAutocomplete);
  } catch (error) {
    googlePlacesAutocompleteEnabled = false;
  }
}

function isGoogleAutocompleteAvailable() {
  return googlePlacesAutocompleteEnabled && providerEl.value === "google";
}

function hideSuggestionPanel(panel) {
  if (!panel) return;
  panel.classList.add("hidden");
  panel.innerHTML = "";
}

function showSuggestions(panel, items, onPick) {
  panel.innerHTML = "";
  panel.classList.remove("hidden");
  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "address-suggestion-item";
    if (index === 0) btn.classList.add("is-active");
    btn.textContent = item.description;
    btn.setAttribute("role", "option");
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      onPick(item.description);
    });
    panel.appendChild(btn);
  });
}

function getLineRangeAtCursor(textarea) {
  const text = textarea.value;
  const pos = textarea.selectionStart;
  const before = text.slice(0, pos);
  const lineStart = before.lastIndexOf("\n") + 1;
  const after = text.slice(pos);
  const nextNl = after.indexOf("\n");
  const lineEnd = nextNl === -1 ? text.length : pos + nextNl;
  return { lineStart, lineEnd, line: text.slice(lineStart, lineEnd) };
}

function replaceTextRange(textarea, start, end, replacement) {
  const text = textarea.value;
  const next = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  textarea.value = next;
  const caret = start + replacement.length;
  textarea.focus();
  textarea.setSelectionRange(caret, caret);
}

function moveActiveSuggestion(panel, delta) {
  const buttons = [...panel.querySelectorAll(".address-suggestion-item")];
  if (!buttons.length) return;
  let index = buttons.findIndex((btn) => btn.classList.contains("is-active"));
  if (index < 0) index = 0;
  buttons[index].classList.remove("is-active");
  index = Math.max(0, Math.min(buttons.length - 1, index + delta));
  buttons[index].classList.add("is-active");
  buttons[index].scrollIntoView({ block: "nearest" });
}

function activateSelectedSuggestion(panel) {
  const active =
    panel.querySelector(".address-suggestion-item.is-active") ||
    panel.querySelector(".address-suggestion-item");
  if (!active) return;
  active.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

async function flushManualAddressSuggest() {
  if (!isGoogleAutocompleteAvailable()) {
    hideSuggestionPanel(addressSuggestionsEl);
    return;
  }

  const { lineStart, lineEnd, line } = getLineRangeAtCursor(pastedTextEl);
  const query = line.trim();
  if (query.length < 2) {
    hideSuggestionPanel(addressSuggestionsEl);
    return;
  }

  if (!manualAutocompleteSessionToken) {
    manualAutocompleteSessionToken = newSessionToken();
  }

  try {
    const response = await fetch("/api/places-autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: query,
        sessionToken: manualAutocompleteSessionToken,
      }),
    });
    const data = await response.json();
    if (!response.ok) return;

    const list = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (!list.length) {
      hideSuggestionPanel(addressSuggestionsEl);
      return;
    }

    manualSuggestRange = { lineStart, lineEnd };
    showSuggestions(addressSuggestionsEl, list, (description) => {
      if (!manualSuggestRange) return;
      replaceTextRange(
        pastedTextEl,
        manualSuggestRange.lineStart,
        manualSuggestRange.lineEnd,
        description,
      );
      manualSuggestRange = null;
      manualAutocompleteSessionToken = newSessionToken();
      hideSuggestionPanel(addressSuggestionsEl);
    });
  } catch (error) {
    hideSuggestionPanel(addressSuggestionsEl);
  }
}

async function flushStartAddressSuggest() {
  if (!isGoogleAutocompleteAvailable()) {
    hideSuggestionPanel(startAddressSuggestionsEl);
    return;
  }

  const query = startAddressEl.value.trim();
  if (query.length < 2) {
    hideSuggestionPanel(startAddressSuggestionsEl);
    return;
  }

  if (!startAutocompleteSessionToken) {
    startAutocompleteSessionToken = newSessionToken();
  }

  try {
    const response = await fetch("/api/places-autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: query,
        sessionToken: startAutocompleteSessionToken,
      }),
    });
    const data = await response.json();
    if (!response.ok) return;

    const list = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (!list.length) {
      hideSuggestionPanel(startAddressSuggestionsEl);
      return;
    }

    showSuggestions(startAddressSuggestionsEl, list, (description) => {
      startAddressEl.value = description;
      startAutocompleteSessionToken = newSessionToken();
      hideSuggestionPanel(startAddressSuggestionsEl);
    });
  } catch (error) {
    hideSuggestionPanel(startAddressSuggestionsEl);
  }
}

pastedTextEl.addEventListener("input", () => {
  clearTimeout(manualSuggestTimer);
  manualSuggestTimer = setTimeout(flushManualAddressSuggest, 300);
});

pastedTextEl.addEventListener("keydown", (event) => {
  if (addressSuggestionsEl.classList.contains("hidden")) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActiveSuggestion(addressSuggestionsEl, 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActiveSuggestion(addressSuggestionsEl, -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    activateSelectedSuggestion(addressSuggestionsEl);
  } else if (event.key === "Escape") {
    hideSuggestionPanel(addressSuggestionsEl);
  }
});

pastedTextEl.addEventListener("blur", () => {
  manualSuggestBlurTimer = window.setTimeout(() => {
    hideSuggestionPanel(addressSuggestionsEl);
  }, 180);
});

pastedTextEl.addEventListener("focus", () => {
  window.clearTimeout(manualSuggestBlurTimer);
});

startAddressEl.addEventListener("keydown", (event) => {
  if (startAddressSuggestionsEl.classList.contains("hidden")) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActiveSuggestion(startAddressSuggestionsEl, 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActiveSuggestion(startAddressSuggestionsEl, -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    activateSelectedSuggestion(startAddressSuggestionsEl);
  } else if (event.key === "Escape") {
    hideSuggestionPanel(startAddressSuggestionsEl);
  }
});

startAddressEl.addEventListener("blur", () => {
  startSuggestBlurTimer = window.setTimeout(() => {
    hideSuggestionPanel(startAddressSuggestionsEl);
  }, 180);
});

startAddressEl.addEventListener("focus", () => {
  window.clearTimeout(startSuggestBlurTimer);
});

providerEl.addEventListener("change", () => {
  clearTimeout(manualSuggestTimer);
  clearTimeout(startSuggestTimer);
  hideSuggestionPanel(addressSuggestionsEl);
  hideSuggestionPanel(startAddressSuggestionsEl);
  manualAutocompleteSessionToken = null;
  startAutocompleteSessionToken = null;
  manualSuggestRange = null;
});

function readCsvFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function decodePolyline(encoded) {
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coordinates.push([lat / 1e5, lng / 1e5]);
  }

  return coordinates;
}

function createNumberedIcon(sequence) {
  return L.divIcon({
    className: "numbered-stop-wrapper",
    html: `<div class="numbered-stop-icon">${sequence}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function createStartIcon() {
  return L.divIcon({
    className: "start-stop-wrapper",
    html: '<div class="start-stop-icon">S</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function createEndIcon() {
  return L.divIcon({
    className: "end-stop-wrapper",
    html: '<div class="start-stop-icon">E</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function createLiveIcon() {
  return L.divIcon({
    className: "live-stop-wrapper",
    html: '<div class="start-stop-icon">ME</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function setGpsStatus(message, isError = false) {
  gpsStatusEl.textContent = message;
  gpsStatusEl.style.color = isError ? "#b20020" : "#394451";
}

function setFollowStatus(message, isError = false) {
  followStatusEl.textContent = message;
  followStatusEl.style.color = isError ? "#b20020" : "#394451";
}

function findNearestStop(currentLocation, stops) {
  if (!stops.length) return null;

  let bestStop = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const dx = stop.location.lat - currentLocation.lat;
    const dy = stop.location.lng - currentLocation.lng;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestStop = stop;
    }
  }

  return bestStop;
}

function distanceMeters(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusM = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(h));
}

function maybeMarkArrivedStop(currentLocation) {
  if (!currentRouteStops.length) return;
  const nearestStop = findNearestStop(currentLocation, currentRouteStops);
  if (!nearestStop?.location) return;

  const meters = distanceMeters(currentLocation, nearestStop.location);
  if (meters > STOP_REACHED_RADIUS_M) return;

  completedRouteStops = [...completedRouteStops, nearestStop];
  currentRouteStops = currentRouteStops
    .filter((stop) => stop.sequence !== nearestStop.sequence)
    .map((stop, index) => ({
      ...stop,
      sequence: index + 1,
    }));
  renderStopList(currentRouteStops);
  renderCompletedStops();
  saveRouteProgress();
}

async function maybeLiveReroute(currentLocation) {
  if (!currentRouteStops.length || liveRerouteInFlight) return;

  const now = Date.now();
  const movedMeters = lastRerouteLocation
    ? distanceMeters(lastRerouteLocation, currentLocation)
    : Number.POSITIVE_INFINITY;
  const enoughTimePassed = now - lastRerouteAt >= LIVE_REROUTE_MIN_INTERVAL_MS;
  const enoughMovement = movedMeters >= LIVE_REROUTE_MIN_MOVEMENT_M;
  if (!enoughTimePassed || !enoughMovement) return;

  lastRerouteAt = now;
  lastRerouteLocation = currentLocation;
  await rerouteRemainingStops(currentLocation, false);
}

async function rerouteRemainingStops(currentLocation = null, showUserStatus = true) {
  if (!currentRouteStops.length || liveRerouteInFlight) return false;

  liveRerouteInFlight = true;
  try {
    const returnToStart = Boolean(returnToStartEl.checked);
    const payload = {
      provider: providerEl.value,
      transportMode: transportModeEl.value,
      pastedText: currentRouteStops
        .map((stop) => stop.rawAddress || stop.standardizedAddress)
        .join("\n"),
      csvText: "",
      startAddress: "",
      startLocation: currentLocation,
      endAddress:
        currentRouteEndPoint?.rawAddress && !returnToStart
          ? currentRouteEndPoint.rawAddress
          : "",
      returnToStart,
    };

    const response = await fetch("/api/optimize-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) return false;

    currentRouteStops = assignStopIds(data.route.orderedStops || []);
    currentRouteStartPoint = data.route.startPoint || null;
    currentRouteEndPoint = data.route.endPoint || null;
    renderStopList(currentRouteStops);
    renderCompletedStops();
    drawRoute(data.route);
    totalsEl.textContent = `Distance: ${data.route.estimated.totalDistanceKm} km | Duration: ${data.route.estimated.totalDurationMin} mins`;
    if (showUserStatus) {
      setStatus("Stop completed. Route updated to next stops.");
    } else {
      setFollowStatus("Live follow rerouted from current location.");
    }
    saveRouteProgress();
    return true;
  } catch (error) {
    if (!showUserStatus) {
      setFollowStatus("Live reroute paused (network/API issue).", true);
    } else {
      setStatus("Could not reroute right now. Please try again.", true);
    }
    return false;
  } finally {
    liveRerouteInFlight = false;
  }
}

function stopLiveFollow() {
  if (liveWatchId !== null) {
    navigator.geolocation.clearWatch(liveWatchId);
    liveWatchId = null;
  }
  setFollowStatus("");
  nextStopHintEl.textContent = "";
  lastRerouteLocation = null;
  lastRerouteAt = 0;
  if (liveLocationMarker) {
    liveLocationMarker.remove();
    liveLocationMarker = null;
  }
}

function startLiveFollow() {
  if (!navigator.geolocation) {
    setFollowStatus("Live follow is not supported in this browser.", true);
    return;
  }
  if (liveWatchId !== null) return;

  setFollowStatus("Following your movement...");
  liveWatchId = navigator.geolocation.watchPosition(
    async (position) => {
      const current = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      latestLiveLocation = current;

      maybeMarkArrivedStop(current);

      if (!liveLocationMarker) {
        liveLocationMarker = L.marker([current.lat, current.lng], {
          icon: createLiveIcon(),
        }).addTo(map);
        map.panTo([current.lat, current.lng], { animate: true });
      } else {
        liveLocationMarker.setLatLng([current.lat, current.lng]);
        if (Date.now() - lastMapInteractionAt > 10000) {
          map.panTo([current.lat, current.lng], { animate: true });
        }
      }

      const nearestStop = findNearestStop(current, currentRouteStops);
      if (nearestStop) {
        nextStopHintEl.textContent = `Nearest next stop: #${nearestStop.sequence} - ${nearestStop.rawAddress || nearestStop.standardizedAddress}`;
      } else {
        nextStopHintEl.textContent = "Optimize a route to see your next stop.";
      }

      await maybeLiveReroute(current);
    },
    (error) => {
      if (error.code === 3) {
        setFollowStatus("GPS signal slow. Still trying...");
        return;
      }
      setFollowStatus(`Live follow error (${error.message}).`, true);
    },
    {
      enableHighAccuracy: false,
      timeout: 20000,
      maximumAge: 15000,
    },
  );
}

useGpsBtn.addEventListener("click", async () => {
  if (!navigator.geolocation) {
    setGpsStatus("GPS is not supported in this browser.", true);
    return;
  }

  useGpsBtn.disabled = true;
  setGpsStatus("Getting your location...");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      selectedGpsStart = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      startAddressEl.value = "";
      setGpsStatus("GPS location selected.");
      useGpsBtn.disabled = false;
      startLiveFollow();
    },
    (error) => {
      selectedGpsStart = null;
      setGpsStatus(`Unable to get GPS location (${error.message}).`, true);
      useGpsBtn.disabled = false;
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    },
  );
});

startAddressEl.addEventListener("input", () => {
  if (startAddressEl.value.trim()) {
    selectedGpsStart = null;
    setGpsStatus("");
    stopLiveFollow();
  }
  clearTimeout(startSuggestTimer);
  startSuggestTimer = setTimeout(flushStartAddressSuggest, 300);
});

function drawRoute(routeData) {
  clearMap();

  const stops = routeData.orderedStops || [];
  const startPoint = routeData.startPoint || null;
  const endPoint = routeData.endPoint || null;
  if (!stops.length && !startPoint && !endPoint) return;

  if (startPoint?.location) {
    const startMarker = L.marker([startPoint.location.lat, startPoint.location.lng], {
      icon: createStartIcon(),
    }).addTo(map);
    startMarker.bindPopup(`<strong>Start Point</strong><br>${startPoint.standardizedAddress || startPoint.rawAddress || "Selected start location"}`);
    markers.push(startMarker);
  }

  if (endPoint?.location) {
    const endMarker = L.marker([endPoint.location.lat, endPoint.location.lng], {
      icon: createEndIcon(),
    }).addTo(map);
    endMarker.bindPopup(
      `<strong>End Point</strong><br>${endPoint.standardizedAddress || endPoint.rawAddress || "Selected end location"}`,
    );
    markers.push(endMarker);
  }

  stops.forEach((stop) => {
    const marker = L.marker([stop.location.lat, stop.location.lng], {
      icon: createNumberedIcon(stop.sequence),
    }).addTo(map);
    const displayName = stop.rawAddress || stop.standardizedAddress;
    const resolvedName =
      stop.standardizedAddress && stop.standardizedAddress !== displayName
        ? `<br><small>${stop.standardizedAddress}</small>`
        : "";
    marker.bindPopup(`<strong>Stop ${stop.sequence}</strong><br>${displayName}${resolvedName}`);
    markers.push(marker);
  });

  let lineCoords = null;
  if (routeData.geometry?.coordinates) {
    lineCoords = routeData.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  } else if (routeData.directionsOverviewPolyline) {
    lineCoords = decodePolyline(routeData.directionsOverviewPolyline);
  }

  if (lineCoords?.length) {
    routeLayer = L.polyline(lineCoords, { color: "#0a63ff", weight: 4 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });
  } else if (markers.length) {
    const group = L.featureGroup(markers);
    map.fitBounds(group.getBounds(), { padding: [20, 20] });
  }
}

function renderStopList(stops) {
  stopsListEl.innerHTML = "";
  const searchTerm = getCurrentSearchTerm();
  const visibleStops = (stops || []).filter((stop) => {
    if (!searchTerm) return true;
    const text = `${stop.rawAddress || ""} ${stop.standardizedAddress || ""}`.toLowerCase();
    return text.includes(searchTerm);
  });

  for (const stop of visibleStops) {
    const li = document.createElement("li");
    li.className = "stop-item";

    const label = document.createElement("span");
    label.className = "stop-label";
    label.textContent = `${stop.sequence}. ${stop.rawAddress || stop.standardizedAddress}`;

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "stop-done-btn";
    doneBtn.textContent = "Done";
    doneBtn.dataset.stopId = String(stop.id);

    li.appendChild(label);
    li.appendChild(doneBtn);
    stopsListEl.appendChild(li);
  }
}

stopSearchEl.addEventListener("input", () => {
  renderStopList(currentRouteStops);
});

undoDoneBtn.addEventListener("click", async () => {
  if (!lastUndoSnapshot) {
    setStatus("Nothing to undo yet.");
    return;
  }

  currentRouteStops = assignStopIds(lastUndoSnapshot.currentRouteStops).map((stop, index) => ({
    ...stop,
    sequence: index + 1,
  }));
  completedRouteStops = assignStopIds(lastUndoSnapshot.completedRouteStops);
  lastUndoSnapshot = null;
  renderStopList(currentRouteStops);
  renderCompletedStops();

  const rerouteFrom =
    latestLiveLocation ||
    (liveLocationMarker ? liveLocationMarker.getLatLng() : null) ||
    currentRouteStartPoint?.location ||
    null;
  const currentLocation = rerouteFrom
    ? { lat: Number(rerouteFrom.lat), lng: Number(rerouteFrom.lng) }
    : null;
  await rerouteRemainingStops(currentLocation, true);
  setStatus("Last done action undone.");
});

stopsListEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("stop-done-btn")) return;

  const stopId = String(target.dataset.stopId || "");
  if (!stopId) return;

  lastUndoSnapshot = {
    currentRouteStops: currentRouteStops.map((stop) => ({ ...stop })),
    completedRouteStops: completedRouteStops.map((stop) => ({ ...stop })),
  };

  const doneStop = currentRouteStops.find((stop) => String(stop.id) === stopId);
  if (!doneStop) return;

  completedRouteStops = [...completedRouteStops, doneStop];
  const remaining = currentRouteStops
    .filter((stop) => String(stop.id) !== stopId)
    .map((stop, index) => ({
      ...stop,
      sequence: index + 1,
    }));
  currentRouteStops = remaining;
  renderStopList(currentRouteStops);
  renderCompletedStops();

  if (!currentRouteStops.length) {
    setStatus("All stops completed. Great job.");
    nextStopHintEl.textContent = "All stops done.";
    clearMap();
    totalsEl.textContent = "";
    saveRouteProgress();
    return;
  }

  const rerouteFrom =
    latestLiveLocation ||
    (liveLocationMarker ? liveLocationMarker.getLatLng() : null) ||
    currentRouteStartPoint?.location ||
    null;
  const currentLocation = rerouteFrom
    ? { lat: Number(rerouteFrom.lat), lng: Number(rerouteFrom.lng) }
    : null;

  const success = await rerouteRemainingStops(currentLocation, true);
  if (!success) {
    currentRouteStops = lastUndoSnapshot.currentRouteStops.map((stop, index) => ({
      ...stop,
      sequence: index + 1,
    }));
    completedRouteStops = lastUndoSnapshot.completedRouteStops.map((stop) => ({ ...stop }));
    renderStopList(currentRouteStops);
    renderCompletedStops();
    setStatus("Could not mark stop done right now. Try again.", true);
  }
});

optimizeBtn.addEventListener("click", async () => {
  try {
    setStatus("Optimizing route...");
    optimizeBtn.disabled = true;
    renderUnresolved([]);

    const csvText = await readCsvFile(csvFileEl.files?.[0]);
    const startAddress = startAddressEl.value.trim();
    const startLocation = selectedGpsStart && !startAddress ? selectedGpsStart : null;
    const returnToStart = Boolean(returnToStartEl.checked);

    const payload = {
      provider: providerEl.value,
      transportMode: transportModeEl.value,
      pastedText: pastedTextEl.value,
      csvText,
      startAddress,
      startLocation,
      endAddress: "",
      returnToStart,
    };

    const response = await fetch("/api/optimize-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      const unresolved = [
        ...(Array.isArray(data.unresolved) ? data.unresolved : []),
        ...(data.unresolvedStart ? [data.unresolvedStart] : []),
        ...(data.unresolvedEnd ? [data.unresolvedEnd] : []),
      ];
      renderUnresolved(unresolved);
      setStatus(data.error || "Failed to optimize route.", true);
      totalsEl.textContent = "";
      stopsListEl.innerHTML = "";
      completedStopsListEl.innerHTML = "";
      currentRouteStops = [];
      completedRouteStops = [];
      lastUndoSnapshot = null;
      nextStopHintEl.textContent = "";
      clearMap();
      clearRouteProgress();
      return;
    }

    const skippedStops = Array.isArray(data.meta?.unresolved) ? data.meta.unresolved : [];
    const skippedStart = data.meta?.unresolvedStart ? [data.meta.unresolvedStart] : [];
    const skippedEnd = data.meta?.unresolvedEnd ? [data.meta.unresolvedEnd] : [];
    renderUnresolved([...skippedStops, ...skippedStart, ...skippedEnd]);

    currentRouteStops = assignStopIds(data.route.orderedStops || []);
    completedRouteStops = [];
    lastUndoSnapshot = null;
    currentRouteStartPoint = data.route.startPoint || null;
    currentRouteEndPoint = data.route.endPoint || null;
    renderStopList(currentRouteStops);
    renderCompletedStops();
    drawRoute(data.route);
    totalsEl.textContent = `Distance: ${data.route.estimated.totalDistanceKm} km | Duration: ${data.route.estimated.totalDurationMin} mins`;
    if (skippedStops.length || skippedStart.length || skippedEnd.length) {
      setStatus(
        `Route ready. Skipped ${skippedStops.length + skippedStart.length + skippedEnd.length} location(s) not found.`,
      );
    } else {
      setStatus(`Success. Strategy: ${data.meta.strategy}`);
    }
    saveRouteProgress();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    optimizeBtn.disabled = false;
    closeSidebar();
  }
});

(async function initApp() {
  await refreshClientConfig();
  restoreRouteProgress();
})();
