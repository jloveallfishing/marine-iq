# Changelog

## 2.4.0

- Keep valid wind, tide, and current overlays in place during map movement and refreshes. Update new coverage progressively and keep the particle layer anchored to the map as it moves.
- Cache dated forecasts by grid point or station, with time selection from the cached series. Prefetch a bounded perimeter, deduplicate requests, and back off when a provider rate-limits requests.
- Label stale cached predictions with their fetch time and show unavailable states when the requested time has no reading.
- Replace the animation checkbox with a compact switch, lower canvas rendering limits, and check automatically for versioned app-shell updates.

## 2.3.0

- Added continuous wind particles and a smooth MPH wind heatmap using bounded interpolation of NWS forecast samples. Missing inputs leave gaps. Gust sample symbols and the forecast timeline remain available.
- Added directional flow near NOAA current stations that return a usable bearing. Station predictions and event times stay distinct from the interpolated wind layers.
- Updated coverage after map pans and zooms. Added request cancellation, bounded concurrency, shared forecast caching, and animation limits for mobile browsers.
- Added an animation toggle and automatic pause when the map is offscreen, a tab is backgrounded, or reduced motion is requested.
- Documented commercial reuse options and operating considerations for GFS, HRRR, and satellite imagery. No new providers are active in the app.
- Updated the deployment verifier and offline cache for the map renderer.

## 2.2.0

- Added separate sustained wind heatmap and gust overlays with MPH legends. Forecast samples use NWS grid data around the selected location. The map leaves unavailable samples blank.
- Expanded the NOAA tidal and current station search to 100 miles and up to 12 separated stations. Event-only current stations display the nearest flood, ebb, or slack prediction and its actual Pacific time.
- Added automated tests, a GitHub Pages workflow with live verification, and a rollback procedure.
- Updated map control sizing and the offline cache version.

## 2.1

- Existing MarineCast release with fishing logs, trip planning, advisories, offline app shell, and animated wind and station prediction maps.
