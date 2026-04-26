# Best Route - Delivery Routing System

Web-based route optimizer for delivery teams, supporting 1 to 100+ stops.

## Features implemented

- Address intake:
  - Manual copy/paste (one address per line)
  - CSV upload
  - Optional start point (GPS or manual start address)
- Address geocoding:
  - OpenStreetMap Nominatim (default)
  - Google Geocoding API (optional)
- Optimization strategy:
  - `1` stop: geocode and display as single-stop route summary
  - `< 20` stops + Google provider: Google Directions optimized waypoints
  - `20+` stops (or OSM mode): nearest-neighbor TSP heuristic + OSRM routing
- Output:
  - Interactive map (Leaflet)
  - Ordered stop list
  - Estimated distance and duration

## Tech stack

- Backend: Node.js + Express
- Frontend: HTML/CSS/JavaScript + Leaflet
- Routing/Maps providers:
  - OSM: Nominatim + OSRM
  - Google: Geocoding + Directions

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create env file:

   ```bash
   copy .env.example .env
   ```

3. (Optional) Set provider keys/config in `.env`:

   ```env
   GOOGLE_MAPS_API_KEY=your_key_here
   DEFAULT_COUNTRY=Ghana
   DEFAULT_COUNTRY_CODE=gh
   ```

`DEFAULT_COUNTRY` and `DEFAULT_COUNTRY_CODE` are used to keep search results Ghana-focused (including business names and postal-code-only inputs like `00233`).

4. Run:

   ```bash
   npm run dev
   ```

5. Open:
   [http://localhost:4000](http://localhost:4000)

## API

### POST `/api/optimize-route`

Body:

```json
{
  "provider": "osm",
  "transportMode": "driving",
  "pastedText": "Accra Mall, Ghana\nKotoka International Airport, Ghana",
  "csvText": "",
  "startAddress": "East Legon, Accra",
  "startLocation": null
}
```

## Notes and next phase

- Current `20+` stop strategy uses a fast nearest-neighbor TSP heuristic.
- For higher quality multi-vehicle planning (VRP, time windows, capacities), integrate OR-Tools / GraphHopper.
- Phase 2 modules to add:
  - Driver stop-complete tracking
  - Supervisor live GPS tracking
  - SMS/email notifications
  - Efficiency reporting dashboard
