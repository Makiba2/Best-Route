const axios = require("axios");
const { Client } = require("@googlemaps/google-maps-services-js");

const googleClient = new Client({});

function euclideanDistance(a, b) {
  const dx = a.lat - b.lat;
  const dy = a.lng - b.lng;
  return Math.sqrt(dx * dx + dy * dy);
}

function nearestNeighborOrder(stops) {
  const pending = stops.map((_, index) => index);
  const ordered = [];

  let current = pending.shift();
  ordered.push(current);

  while (pending.length) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < pending.length; i += 1) {
      const candidate = pending[i];
      const distance = euclideanDistance(
        stops[current].location,
        stops[candidate].location,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    current = pending.splice(bestIndex, 1)[0];
    ordered.push(current);
  }

  return ordered;
}

function nearestNeighborOrderFromStart(stops, startLocation) {
  if (!startLocation) return nearestNeighborOrder(stops);

  const pending = stops.map((_, index) => index);
  const ordered = [];

  let currentReference = { location: startLocation };

  while (pending.length) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < pending.length; i += 1) {
      const candidate = pending[i];
      const distance = euclideanDistance(
        currentReference.location,
        stops[candidate].location,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    const nextStopIndex = pending.splice(bestIndex, 1)[0];
    ordered.push(nextStopIndex);
    currentReference = stops[nextStopIndex];
  }

  return ordered;
}

function getRouteDistanceByOrder(stops, orderIndexes, startLocation = null) {
  if (!orderIndexes.length) return 0;

  let totalDistance = 0;
  if (startLocation) {
    totalDistance += euclideanDistance(startLocation, stops[orderIndexes[0]].location);
  }

  for (let i = 0; i < orderIndexes.length - 1; i += 1) {
    const current = stops[orderIndexes[i]].location;
    const next = stops[orderIndexes[i + 1]].location;
    totalDistance += euclideanDistance(current, next);
  }

  return totalDistance;
}

function improveOrderWithTwoOpt(stops, initialOrder, startLocation = null) {
  if (initialOrder.length < 4) return initialOrder;

  const order = [...initialOrder];
  let improved = true;
  let bestDistance = getRouteDistanceByOrder(stops, order, startLocation);
  let passes = 0;
  const maxPasses = 6;

  while (improved && passes < maxPasses) {
    improved = false;
    passes += 1;

    for (let i = 0; i < order.length - 2; i += 1) {
      for (let k = i + 1; k < order.length - 1; k += 1) {
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, k + 1).reverse(),
          ...order.slice(k + 1),
        ];

        const candidateDistance = getRouteDistanceByOrder(
          stops,
          candidate,
          startLocation,
        );
        if (candidateDistance + 1e-9 < bestDistance) {
          order.splice(0, order.length, ...candidate);
          bestDistance = candidateDistance;
          improved = true;
        }
      }
    }
  }

  return order;
}

async function fetchOsrmRoute(coordinates, transportMode = "driving") {
  const mode = transportMode === "walking" ? "walking" : "driving";
  const coordsPath = coordinates.map((c) => `${c.lng},${c.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/${mode}/${coordsPath}`;

  const response = await axios.get(url, {
    params: {
      overview: "full",
      geometries: "geojson",
      steps: false,
    },
  });

  const route = response.data?.routes?.[0];
  if (!route) {
    throw new Error("Unable to retrieve route from OSRM.");
  }

  return {
    distanceKm: Number((route.distance / 1000).toFixed(2)),
    durationMin: Number((route.duration / 60).toFixed(1)),
    geometry: route.geometry,
  };
}

async function fetchGoogleDirections(stops, transportMode = "driving") {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is required for Google routing.");
  }

  if (stops.length < 2) {
    throw new Error("At least 2 stops required for route directions.");
  }

  const origin = `${stops[0].location.lat},${stops[0].location.lng}`;
  const destination = `${stops[stops.length - 1].location.lat},${stops[stops.length - 1].location.lng}`;
  const waypointStops = stops.slice(1, -1).map((stop) => ({
    location: `${stop.location.lat},${stop.location.lng}`,
    stopover: true,
  }));

  const response = await googleClient.directions({
    params: {
      origin,
      destination,
      mode: transportMode === "walking" ? "walking" : "driving",
      optimize: true,
      departure_time: "now",
      waypoints: waypointStops,
      key: apiKey,
    },
  });

  const route = response.data.routes?.[0];
  if (!route) {
    throw new Error("Unable to retrieve route from Google Directions.");
  }

  const waypointOrder = route.waypoint_order || [];
  const middleStops = stops.slice(1, -1);
  const reorderedMiddleStops = waypointOrder.map((index) => middleStops[index]);
  const orderedStops = [stops[0], ...reorderedMiddleStops, stops[stops.length - 1]].map((stop, idx) => ({
    ...stop,
    sequence: idx + 1,
  }));

  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;
  for (const leg of route.legs || []) {
    totalDistanceMeters += leg.distance?.value || 0;
    totalDurationSeconds += leg.duration?.value || 0;
  }

  return {
    orderedStops,
    estimated: {
      totalDistanceKm: Number((totalDistanceMeters / 1000).toFixed(2)),
      totalDurationMin: Number((totalDurationSeconds / 60).toFixed(1)),
    },
    geometry: null,
    directionsOverviewPolyline: route.overview_polyline?.points || null,
  };
}

async function optimizeRoute(stops, { transportMode, provider, startPoint = null }) {
  const strategy = stops.length < 20 ? "directions-optimized" : "tsp-nearest-neighbor-2opt";
  const hasStartPoint = Boolean(startPoint?.location);
  const startLocation = hasStartPoint ? startPoint.location : null;

  if (stops.length === 1) {
    const coordinates = hasStartPoint ? [startLocation, stops[0].location] : [stops[0].location];
    const routeStats =
      coordinates.length > 1 ? await fetchOsrmRoute(coordinates, transportMode) : null;

    return {
      provider,
      strategy: hasStartPoint ? "single-stop-from-start" : "single-stop",
      startPoint: hasStartPoint ? startPoint : null,
      orderedStops: [
        {
          sequence: 1,
          rawAddress: stops[0].rawAddress,
          standardizedAddress: stops[0].standardizedAddress,
          location: stops[0].location,
        },
      ],
      estimated: {
        totalDistanceKm: routeStats ? routeStats.distanceKm : 0,
        totalDurationMin: routeStats ? routeStats.durationMin : 0,
      },
      geometry: routeStats ? routeStats.geometry : null,
      directionsOverviewPolyline: null,
    };
  }

  if (provider === "google" && stops.length < 20 && !hasStartPoint) {
    const googleRoute = await fetchGoogleDirections(
      stops.map((stop, i) => ({
        sequence: i + 1,
        rawAddress: stop.rawAddress,
        standardizedAddress: stop.standardizedAddress,
        location: stop.location,
      })),
      transportMode,
    );

    return {
      provider,
      strategy,
      startPoint: null,
      orderedStops: googleRoute.orderedStops,
      estimated: googleRoute.estimated,
      geometry: googleRoute.geometry,
      directionsOverviewPolyline: googleRoute.directionsOverviewPolyline,
    };
  }

  // Production note:
  // For large fleets, replace this with OR-Tools / GraphHopper VRP constraints.
  const nearestOrder = nearestNeighborOrderFromStart(stops, startLocation);
  const orderIndexes = improveOrderWithTwoOpt(stops, nearestOrder, startLocation);
  const orderedStops = orderIndexes.map((idx, i) => ({
    sequence: i + 1,
    rawAddress: stops[idx].rawAddress,
    standardizedAddress: stops[idx].standardizedAddress,
    location: stops[idx].location,
  }));

  const coordinates = [
    ...(hasStartPoint ? [startLocation] : []),
    ...orderedStops.map((stop) => stop.location),
  ];
  const routeStats = await fetchOsrmRoute(coordinates, transportMode);

  return {
    provider,
    strategy: hasStartPoint ? `${strategy}-from-start` : strategy,
    startPoint: hasStartPoint ? startPoint : null,
    orderedStops,
    estimated: {
      totalDistanceKm: routeStats.distanceKm,
      totalDurationMin: routeStats.durationMin,
    },
    geometry: routeStats.geometry,
    directionsOverviewPolyline: null,
  };
}

module.exports = {
  optimizeRoute,
};
