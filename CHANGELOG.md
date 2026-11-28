# Changelog

## 2.7.0

- Show aligned previews from already-loaded basemap tiles while replacements load or fail. Keep normal browser HTTP caching and visible-area requests.
- Prioritize central wind samples, parse each forecast grid response once per date, and preserve available coverage with support-limited coastal triangles.
- Seed wind particles in supported cells, keep heatmap shading on its own cached canvas, and retain overlapping coverage during movement.
- Add independent, remembered wind particle, wind label, and heatmap controls. Preserve separate current animation and collision-free labels.
- Document NOAA GFS, HRRR, and NDFD batching options and the OpenFreeMap commercial basemap candidate. No new provider is active.

## 2.6.0

- Defer basemap tile requests until the map opens and retain nearby loaded tiles through movement and zoom transitions.
- Reuse in-flight provider calls and size forecast coverage against the viewport, with a minimum sample spacing at close zooms.
- Smooth and clip heatmap shading to supported cells, and improve wind trails and directional current streaks while retaining motion controls and label spacing.
- Give each forecast graph one selected Pacific time, aligned color-matched values, and independent midnight-to-midnight controls. Plot the next midnight when a source supplies a reading.
- Add Check for Updates and an opt-in reload, keep the permanent URL, and verify version consistency before activating the offline shell.
- Document regional forecast sources and browser update verification. Existing fishing data, preferences, branding, and free advisories carry forward.

## 2.5.0

- Space wind and gust markers by zoom level to prevent overlapping speed labels.
- Improve wind trail contrast and length within the existing animation budget.
- Add a Pacific date picker on the map and a saved heatmap opacity control.
- Add an automated foreground service worker upgrade test and document iPhone verification.
- Expand research into commercially reusable satellite imagery without enabling a new provider.

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
