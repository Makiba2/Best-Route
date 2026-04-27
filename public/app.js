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
const followGpsBtn = document.getElementById("followGpsBtn");
const providerEl = document.getElementById("provider");
const transportModeEl = document.getElementById("transportMode");
const startAddressEl = document.getElementById("startAddress");
const endAddressEl = document.getElementById("endAddress");
const returnToStartEl = document.getElementById("returnToStart");
const pastedTextEl = document.getElementById("pastedText");
const csvFileEl = document.getElementById("csvFile");
const gpsStatusEl = document.getElementById("gpsStatus");
const followStatusEl = document.getElementById("followStatus");
const nextStopHintEl = document.getElementById("nextStopHint");
const statusEl = document.getElementById("status");
const unresolvedWrapEl = document.getElementById("unresolvedWrap");
const unresolvedListEl = document.getElementById("unresolvedList");
const stopsListEl = document.getElementById("stopsList");
const totalsEl = document.getElementById("totals");

let markers = [];
let routeLayer = null;
let selectedGpsStart = null;
let liveLocationMarker = null;
let liveWatchId = null;
let currentRouteStops = [];
let currentRouteStartPoint = null;
let currentRouteEndPoint = null;
let latestLiveLocation = null;
let lastRerouteLocation = null;
let lastRerouteAt = 0;
let liveRerouteInFlight = false;
const mobileMediaQuery = window.matchMedia("(max-width: 900px)");
const LIVE_REROUTE_MIN_MOVEMENT_M = 45;
const LIVE_REROUTE_MIN_INTERVAL_MS = 5000;
const STOP_REACHED_RADIUS_M = 45;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b20020" : "#394451";
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

  currentRouteStops = currentRouteStops
    .filter((stop) => stop.sequence !== nearestStop.sequence)
    .map((stop, index) => ({
      ...stop,
      sequence: index + 1,
    }));
  renderStopList(currentRouteStops);
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
    const endAddress = endAddressEl.value.trim();
    const returnToStart = Boolean(returnToStartEl.checked);
    const payload = {
      provider: providerEl.value,
      transportMode: transportModeEl.value,
      pastedText: currentRouteStops
        .map((stop) => stop.standardizedAddress || stop.rawAddress)
        .join("\n"),
      csvText: "",
      startAddress: "",
      startLocation: currentLocation,
      endAddress:
        currentRouteEndPoint?.rawAddress && !returnToStart
          ? currentRouteEndPoint.rawAddress
          : endAddress,
      returnToStart,
    };

    const response = await fetch("/api/optimize-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) return false;

    currentRouteStops = data.route.orderedStops || [];
    currentRouteStartPoint = data.route.startPoint || null;
    currentRouteEndPoint = data.route.endPoint || null;
    renderStopList(currentRouteStops);
    drawRoute(data.route);
    totalsEl.textContent = `Distance: ${data.route.estimated.totalDistanceKm} km | Duration: ${data.route.estimated.totalDurationMin} mins`;
    if (showUserStatus) {
      setStatus("Stop completed. Route updated to next stops.");
    } else {
      setFollowStatus("Live follow rerouted from current location.");
    }
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
  }
});

followGpsBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setFollowStatus("Live follow is not supported in this browser.", true);
    return;
  }

  if (liveWatchId !== null) {
    navigator.geolocation.clearWatch(liveWatchId);
    liveWatchId = null;
    followGpsBtn.textContent = "Start Live Follow";
    setFollowStatus("Live follow stopped.");
    nextStopHintEl.textContent = "";
    lastRerouteLocation = null;
    lastRerouteAt = 0;
    if (liveLocationMarker) {
      liveLocationMarker.remove();
      liveLocationMarker = null;
    }
    return;
  }

  followGpsBtn.textContent = "Stop Live Follow";
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
      } else {
        liveLocationMarker.setLatLng([current.lat, current.lng]);
      }

      map.setView([current.lat, current.lng], Math.max(map.getZoom(), 14));

      const nearestStop = findNearestStop(current, currentRouteStops);
      if (nearestStop) {
        nextStopHintEl.textContent = `Nearest next stop: #${nearestStop.sequence} - ${nearestStop.standardizedAddress || nearestStop.rawAddress}`;
      } else {
        nextStopHintEl.textContent = "Optimize a route to see your next stop.";
      }

      await maybeLiveReroute(current);
    },
    (error) => {
      setFollowStatus(`Live follow error (${error.message}).`, true);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    },
  );
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
    marker.bindPopup(`<strong>Stop ${stop.sequence}</strong><br>${stop.standardizedAddress}`);
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
  for (const stop of stops) {
    const li = document.createElement("li");
    li.className = "stop-item";

    const label = document.createElement("span");
    label.className = "stop-label";
    label.textContent = `${stop.sequence}. ${stop.standardizedAddress || stop.rawAddress}`;

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "stop-done-btn";
    doneBtn.textContent = "Done";
    doneBtn.dataset.sequence = String(stop.sequence);

    li.appendChild(label);
    li.appendChild(doneBtn);
    stopsListEl.appendChild(li);
  }
}

stopsListEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("stop-done-btn")) return;

  const sequence = Number(target.dataset.sequence);
  if (!Number.isFinite(sequence)) return;

  const remaining = currentRouteStops
    .filter((stop) => stop.sequence !== sequence)
    .map((stop, index) => ({
      ...stop,
      sequence: index + 1,
    }));
  currentRouteStops = remaining;
  renderStopList(currentRouteStops);

  if (!currentRouteStops.length) {
    setStatus("All stops completed. Great job.");
    nextStopHintEl.textContent = "All stops done.";
    clearMap();
    totalsEl.textContent = "";
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

  await rerouteRemainingStops(currentLocation, true);
});

optimizeBtn.addEventListener("click", async () => {
  try {
    setStatus("Optimizing route...");
    optimizeBtn.disabled = true;
    renderUnresolved([]);

    const csvText = await readCsvFile(csvFileEl.files?.[0]);
    const startAddress = startAddressEl.value.trim();
    const startLocation = selectedGpsStart && !startAddress ? selectedGpsStart : null;
    const endAddress = endAddressEl.value.trim();
    const returnToStart = Boolean(returnToStartEl.checked);

    const payload = {
      provider: providerEl.value,
      transportMode: transportModeEl.value,
      pastedText: pastedTextEl.value,
      csvText,
      startAddress,
      startLocation,
      endAddress,
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
      currentRouteStops = [];
      nextStopHintEl.textContent = "";
      clearMap();
      return;
    }

    const skippedStops = Array.isArray(data.meta?.unresolved) ? data.meta.unresolved : [];
    const skippedStart = data.meta?.unresolvedStart ? [data.meta.unresolvedStart] : [];
    const skippedEnd = data.meta?.unresolvedEnd ? [data.meta.unresolvedEnd] : [];
    renderUnresolved([...skippedStops, ...skippedStart, ...skippedEnd]);

    currentRouteStops = data.route.orderedStops || [];
    currentRouteStartPoint = data.route.startPoint || null;
    currentRouteEndPoint = data.route.endPoint || null;
    renderStopList(data.route.orderedStops);
    drawRoute(data.route);
    totalsEl.textContent = `Distance: ${data.route.estimated.totalDistanceKm} km | Duration: ${data.route.estimated.totalDurationMin} mins`;
    if (skippedStops.length || skippedStart.length || skippedEnd.length) {
      setStatus(
        `Route ready. Skipped ${skippedStops.length + skippedStart.length + skippedEnd.length} location(s) not found.`,
      );
    } else {
      setStatus(`Success. Strategy: ${data.meta.strategy}`);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    optimizeBtn.disabled = false;
    closeSidebar();
  }
});
