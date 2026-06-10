const map = L.map("map", { zoomControl: false }).setView([5.6037, -0.187], 11);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const layoutEl = document.getElementById("layout");
const togglePanelBtn = document.getElementById("togglePanelBtn");
const optimizeBtn = document.getElementById("optimizeBtn");
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
const clearAllBtn = document.getElementById("clearAllBtn");
const shareLinkBtn = document.getElementById("shareLinkBtn");
const shareHintEl = document.getElementById("shareHint");
const mobileShareBtn = document.getElementById("mobileShareBtn");

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
const PANEL_COLLAPSED_STORAGE_KEY = "best-route-panel-collapsed";
const SHARE_HASH_PREFIX = "r=";
let lastRouteMeta = null;
let lastRouteEstimated = null;
let lastRouteGeometry = null;
let lastRoutePolyline = null;
let shareHintTimer = null;
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

function decodeSharePayload(encoded) {
  try {
    let base64 = String(encoded || "").replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return null;
  }
}

function getShareRefFromUrl() {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  if (!hash.startsWith(SHARE_HASH_PREFIX)) return null;
  return hash.slice(SHARE_HASH_PREFIX.length);
}

function isServerShareId(ref) {
  return /^[A-Za-z0-9_-]{6,32}$/.test(String(ref || ""));
}

function buildShareUrlFromId(id) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${SHARE_HASH_PREFIX}${id}`;
  return url.toString();
}

async function createShareUrl() {
  const payload = buildSharePayload();
  if (!payload) return null;

  const response = await fetch("/api/share-route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not save shared route.");
  }

  if (!data.id) {
    throw new Error("Could not create share link.");
  }

  return buildShareUrlFromId(data.id);
}

function buildSharePayload() {
  const payload = {
    v: 1,
    provider: providerEl.value,
    transportMode: transportModeEl.value,
    returnToStart: Boolean(returnToStartEl.checked),
    startAddress: startAddressEl.value.trim(),
  };

  if (selectedGpsStart && !payload.startAddress) {
    payload.startLat = selectedGpsStart.lat;
    payload.startLng = selectedGpsStart.lng;
  }

  if (currentRouteStops.length) {
    payload.kind = "route";
    payload.stops = currentRouteStops.map((stop) => ({
      sequence: stop.sequence,
      rawAddress: stop.rawAddress,
      standardizedAddress: stop.standardizedAddress,
      location: stop.location,
    }));
    payload.startPoint = currentRouteStartPoint;
    payload.endPoint = currentRouteEndPoint;
    payload.estimated = lastRouteEstimated;
    payload.meta = lastRouteMeta;
    payload.geometry = lastRouteGeometry;
    payload.directionsOverviewPolyline = lastRoutePolyline;
    return payload;
  }

  const stopsText = pastedTextEl.value.trim();
  if (!stopsText) return null;

  payload.kind = "input";
  payload.stopsText = pastedTextEl.value;
  return payload;
}

async function updateShareUrlInBrowser() {
  try {
    const shareUrl = await createShareUrl();
    if (!shareUrl) return;
    history.replaceState(null, "", shareUrl);
  } catch (error) {
    // Ignore background share-url updates (optimize still succeeded).
  }
}

function clearShareUrlInBrowser() {
  try {
    const url = new URL(window.location.href);
    url.hash = "";
    history.replaceState(null, "", `${url.pathname}${url.search}`);
  } catch (error) {
    // Ignore history failures.
  }
}

function canShareRoute() {
  return Boolean(currentRouteStops.length || pastedTextEl.value.trim());
}

function canUseNativeShare() {
  return typeof navigator.share === "function";
}

function getShareStopCount() {
  if (currentRouteStops.length) return currentRouteStops.length;
  return pastedTextEl.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function syncShareButtonLabels() {
  const useNative = canUseNativeShare() && isMobileView();
  const label = useNative ? "Share route" : "Copy share link";
  if (shareLinkBtn) shareLinkBtn.textContent = label;
  if (mobileShareBtn) mobileShareBtn.textContent = label;
}

function updateShareButtonState() {
  const canShare = canShareRoute();
  if (shareLinkBtn) shareLinkBtn.disabled = !canShare;
  if (mobileShareBtn) {
    mobileShareBtn.disabled = !canShare;
    mobileShareBtn.classList.toggle("hidden", !canShare || !isMobileView());
  }
  syncShareButtonLabels();
}

function focusMapAfterShareLoad() {
  if (!isMobileView()) return;
  setPanelCollapsed(true);
  scheduleMapResize();
}

function hideShareHint() {
  if (!shareHintEl) return;
  shareHintEl.classList.add("hidden");
}

function showShareHint(message) {
  if (!shareHintEl) return;
  shareHintEl.textContent = message;
  shareHintEl.classList.remove("hidden");
  clearTimeout(shareHintTimer);
  shareHintTimer = window.setTimeout(hideShareHint, 5000);
}

async function shareRouteLink() {
  const stopCount = getShareStopCount();
  const shareTitle = "Delivery route";
  const shareText =
    stopCount > 0
      ? `Delivery route with ${stopCount} stop${stopCount === 1 ? "" : "s"}`
      : "Delivery route";

  let shareUrl;
  try {
    setStatus("Creating share link...");
    if (shareLinkBtn) shareLinkBtn.disabled = true;
    if (mobileShareBtn) mobileShareBtn.disabled = true;
    shareUrl = await createShareUrl();
  } catch (error) {
    setStatus(error.message || "Could not create share link.", true);
    updateShareButtonState();
    return;
  } finally {
    updateShareButtonState();
  }

  if (!shareUrl) {
    setStatus("Add at least one address before sharing.", true);
    return;
  }

  try {
    history.replaceState(null, "", shareUrl);
  } catch (error) {
    // Ignore history failures.
  }

  if (canUseNativeShare() && isMobileView()) {
    try {
      await navigator.share({ title: shareTitle, text: shareText, url: shareUrl });
      showShareHint("Shared. Recipients can open the link to view the same route.");
      setStatus("Route shared.");
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  try {
    await navigator.clipboard.writeText(shareUrl);
    showShareHint("Link copied. Send it to your driver — opening it restores this route.");
    setStatus("Share link copied to clipboard.");
  } catch (error) {
    window.prompt("Copy this share link:", shareUrl);
    setStatus("Copy the link from the dialog box.");
  }
}

function applySharedSettings(payload) {
  if (payload.provider === "google" || payload.provider === "osm") {
    providerEl.value = payload.provider;
  }
  if (payload.transportMode === "driving" || payload.transportMode === "walking") {
    transportModeEl.value = payload.transportMode;
  }
  returnToStartEl.checked = Boolean(payload.returnToStart);

  if (typeof payload.startAddress === "string" && payload.startAddress.trim()) {
    startAddressEl.value = payload.startAddress.trim();
    selectedGpsStart = null;
    setGpsStatus("");
  } else if (
    Number.isFinite(Number(payload.startLat)) &&
    Number.isFinite(Number(payload.startLng))
  ) {
    selectedGpsStart = {
      lat: Number(payload.startLat),
      lng: Number(payload.startLng),
    };
    startAddressEl.value = "";
    setGpsStatus("Shared start location loaded.");
  }
}

function applySharedRoute(payload) {
  applySharedSettings(payload);

  const stopsText = (payload.stops || [])
    .map((stop) => stop.rawAddress || stop.standardizedAddress)
    .filter(Boolean)
    .join("\n");
  pastedTextEl.value = stopsText;
  csvFileEl.value = "";

  currentRouteStops = assignStopIds(payload.stops || []).map((stop, index) => ({
    ...stop,
    sequence: index + 1,
  }));
  completedRouteStops = [];
  lastUndoSnapshot = null;
  currentRouteStartPoint = payload.startPoint || null;
  currentRouteEndPoint = payload.endPoint || null;
  lastRouteMeta = payload.meta || null;
  lastRouteEstimated = payload.estimated || null;
  lastRouteGeometry = payload.geometry || null;
  lastRoutePolyline = payload.directionsOverviewPolyline || null;

  renderStopList(currentRouteStops);
  renderCompletedStops();
  renderUnresolved([]);

  const routeData = {
    orderedStops: currentRouteStops,
    startPoint: currentRouteStartPoint,
    endPoint: currentRouteEndPoint,
    geometry: lastRouteGeometry,
    directionsOverviewPolyline: lastRoutePolyline,
  };

  drawRoute(routeData);

  if (lastRouteEstimated) {
    totalsEl.textContent = `Distance: ${lastRouteEstimated.totalDistanceKm} km | Duration: ${lastRouteEstimated.totalDurationMin} mins`;
  } else {
    totalsEl.textContent = "";
  }

  if (lastRouteMeta?.strategy) {
    setStatus(`Shared route loaded. Strategy: ${lastRouteMeta.strategy}`);
  } else {
    setStatus("Shared route loaded.");
  }

  saveRouteProgress();
  updateShareButtonState();
  focusMapAfterShareLoad();
}

function applySharedInput(payload) {
  applySharedSettings(payload);
  pastedTextEl.value = typeof payload.stopsText === "string" ? payload.stopsText : "";
  csvFileEl.value = "";
  updateShareButtonState();
}

async function applySharePayload(payload) {
  if (payload.kind === "route" && Array.isArray(payload.stops) && payload.stops.length) {
    applySharedRoute(payload);
    focusMapAfterShareLoad();
    return true;
  }

  if (payload.kind === "input" && typeof payload.stopsText === "string" && payload.stopsText.trim()) {
    applySharedInput(payload);
    setStatus("Shared route setup loaded. Optimizing...");
    await runOptimize();
    focusMapAfterShareLoad();
    return true;
  }

  return false;
}

async function loadFromShareUrl() {
  const ref = getShareRefFromUrl();
  if (!ref) return false;

  const inlinePayload = decodeSharePayload(ref);
  if (inlinePayload?.v === 1) {
    return applySharePayload(inlinePayload);
  }

  if (!isServerShareId(ref)) return false;

  setStatus("Loading shared route...");
  try {
    const response = await fetch(`/api/share-route/${encodeURIComponent(ref)}`);
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error || "Shared route not found or expired.", true);
      return false;
    }
    return applySharePayload(data.payload);
  } catch (error) {
    setStatus("Could not load shared route.", true);
    return false;
  }
}

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

function clearEverything() {
  pastedTextEl.value = "";
  csvFileEl.value = "";
  startAddressEl.value = "";
  returnToStartEl.checked = false;
  stopSearchEl.value = "";

  selectedGpsStart = null;
  stopLiveFollow();
  setGpsStatus("");
  setFollowStatus("");
  nextStopHintEl.textContent = "";

  currentRouteStops = [];
  completedRouteStops = [];
  lastUndoSnapshot = null;
  currentRouteStartPoint = null;
  currentRouteEndPoint = null;

  renderStopList(currentRouteStops);
  renderCompletedStops();
  renderUnresolved([]);
  totalsEl.textContent = "";
  setStatus("All cleared.");

  clearMap();
  clearRouteProgress();
  clearShareUrlInBrowser();
  hideShareHint();
  updateShareButtonState();

  hideSuggestionPanel(addressSuggestionsEl);
  hideSuggestionPanel(startAddressSuggestionsEl);
  manualAutocompleteSessionToken = null;
  startAutocompleteSessionToken = null;
  manualSuggestRange = null;
  clearTimeout(manualSuggestTimer);
  clearTimeout(startSuggestTimer);

  useGpsBtn.disabled = false;

  map.setView([5.6037, -0.187], 11);
}

clearAllBtn.addEventListener("click", () => {
  clearEverything();
});

function isMobileView() {
  return mobileMediaQuery.matches;
}

/** On mobile, only pan — never auto-zoom so the menu panel stays easy to use */
function focusMapOnRoute(bounds) {
  if (!bounds?.isValid?.()) return;

  if (isMobileView()) {
    map.panTo(bounds.getCenter(), { animate: false });
    return;
  }

  map.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
}

function scheduleMapResize() {
  window.setTimeout(() => map.invalidateSize(), 80);
  window.setTimeout(() => map.invalidateSize(), 320);
}

function isPanelCollapsed() {
  return layoutEl?.classList.contains("panel-collapsed") ?? false;
}

function syncPanelToggleButton() {
  if (!togglePanelBtn) return;
  const collapsed = isPanelCollapsed();
  togglePanelBtn.textContent = collapsed ? "Menu" : "Hide menu";
  togglePanelBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function setPanelCollapsed(collapsed, persist = true) {
  if (!layoutEl || !isMobileView()) return;
  layoutEl.classList.toggle("panel-collapsed", collapsed);
  syncPanelToggleButton();
  if (persist) {
    try {
      sessionStorage.setItem(PANEL_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
    } catch (error) {
      // ignore
    }
  }
  scheduleMapResize();
}

function restorePanelCollapsedState() {
  if (!isMobileView()) {
    layoutEl?.classList.remove("panel-collapsed");
    syncPanelToggleButton();
    return;
  }
  try {
    const stored = sessionStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY);
    setPanelCollapsed(stored === "1", false);
  } catch (error) {
    syncPanelToggleButton();
  }
}

togglePanelBtn?.addEventListener("click", () => {
  setPanelCollapsed(!isPanelCollapsed());
});

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

mobileMediaQuery.addEventListener("change", () => {
  restorePanelCollapsedState();
  updateShareButtonState();
  scheduleMapResize();
});
window.addEventListener("resize", scheduleMapResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", scheduleMapResize);
}

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
  updateShareButtonState();
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

  let routeBounds = null;
  if (lineCoords?.length) {
    routeLayer = L.polyline(lineCoords, { color: "#0a63ff", weight: 4 }).addTo(map);
    routeBounds = routeLayer.getBounds();
  } else if (markers.length) {
    routeBounds = L.featureGroup(markers).getBounds();
  }

  focusMapOnRoute(routeBounds);
  scheduleMapResize();
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

shareLinkBtn?.addEventListener("click", () => {
  shareRouteLink();
});

mobileShareBtn?.addEventListener("click", () => {
  shareRouteLink();
});

async function runOptimize() {
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
      lastRouteMeta = null;
      lastRouteEstimated = null;
      lastRouteGeometry = null;
      lastRoutePolyline = null;
      nextStopHintEl.textContent = "";
      clearMap();
      clearRouteProgress();
      updateShareButtonState();
      return false;
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
    lastRouteMeta = data.meta || null;
    lastRouteEstimated = data.route.estimated || null;
    lastRouteGeometry = data.route.geometry || null;
    lastRoutePolyline = data.route.directionsOverviewPolyline || null;
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
    await updateShareUrlInBrowser();
    updateShareButtonState();
    if (isMobileView() && currentRouteStops.length) {
      setPanelCollapsed(true);
    }
    return true;
  } catch (error) {
    setStatus(error.message, true);
    return false;
  } finally {
    optimizeBtn.disabled = false;
    scheduleMapResize();
  }
}

optimizeBtn.addEventListener("click", () => {
  runOptimize();
});

(async function initApp() {
  await refreshClientConfig();
  restorePanelCollapsedState();
  const loadedFromShare = await loadFromShareUrl();
  if (!loadedFromShare) {
    restoreRouteProgress();
  }
  updateShareButtonState();
  scheduleMapResize();
})();
