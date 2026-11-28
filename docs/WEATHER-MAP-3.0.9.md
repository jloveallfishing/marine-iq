# MarineCast 3.0.9 weather data and release verification

## What changed

MarineCast 3.0.8 already used continuous Canvas shading and animated vector trails. Its forecast discovery was tied to the viewport sample lattice, so changing plans could drop cells still valid for the selected time. Version 3.0.9 retains fresh native cell polygons from the bounded session cache, regardless of which viewport discovered them. At close zoom a sample within a fresh published cell can reuse that cell's time series without a new coordinate lookup. Newly exposed areas still use the debounced, rate-limited NWS request queue. The canvas spatial index limits polygon tests during shade and particle sampling. Forecast date and hour must match. The map draws directional flow only where directional data supports it.

Tapping the wind map shows the wind speed, direction and gust for the selected published cell and hour. Smooth colors between supported samples are interpolated forecast guidance. They can differ from the cell's tabulated reading. Unavailable fields remain unavailable, and stale values cannot appear in the tap readout. The map still offers dashed stale forecast markers with fetch times.

OpenStreetMap raster tiles remain subject to the provider's policy. Recent same-zoom tiles can render from the bounded in-memory cache without requesting the same image again. Parent and child previews continue to cover available areas during zoom. Cold areas still depend on the network. No bulk tile fetch, offline tile download or longer cache override was added. [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/)

## NOAA weather sources

| Product | Resolution and schedule | Fit and delivery |
| --- | --- | --- |
| NWS Weather Forecast Office grids, used in 3.0.9 | Approximately 2.5 km, with forecast validity supplied in each field. NWS publishes hourly forecast guidance for up to seven days. Individual cells, times and fields may be absent. | Public JSON API. A point lookup resolves the grid URL, and replies supply the polygon and time series. Useful for the Bay, Delta and coast. Channels narrower than a cell remain unresolved. [NWS API](https://www.weather.gov/documentation/services-web-api) |
| NDFD | Typically 2.5 km with hourly refresh and hourly near-term validity, depending on the product. The XML documentation describes 1-hour temporal resolution over the first 36 hours. | Best candidate for a California regional extract. Download and decode GRIB2 in a scheduled job to avoid per-cell discovery. XML can batch up to 100 coordinates but still requires safe spatial masking and has usage limits. [Metadata](https://www.weather.gov/gis/NDFD_metadata.html) · [Service guidelines](https://graphical.weather.gov/xml/mdl/XML/Design/WebServicesUseGuidelines.php) |
| HRRR | 3 km CONUS guidance. Runs hourly, usually to 18 hours, with 48-hour runs at 00, 06, 12 and 18 UTC. | Useful for a separately labeled short-range comparison. Regional download and decoding must handle directional conventions, validity, missing fields and product changes. [NOAA HRRR distribution](https://registry.opendata.aws/noaa-hrrr-pds/) |
| GFS | 0.25° global output, four cycles daily. NCEP lists hourly output through forecast hour 120 and three-hourly output through hour 384. | Ocean and longer-range context. Too coarse for Bay and Delta fine-scale wind. Use a separate model label and timestamps if added. [NCEP GFS schedule](https://www.nco.ncep.noaa.gov/pmb/products/gfs/nomads/) |

NWS permits reuse of its open weather data for lawful purposes, including commercial reuse. Preserve NOAA/NWS attribution, avoid implied endorsement and identify MarineCast's visualization separately from official material. Check exact product terms for any future third-party delivery service. Current API use adds $0 in operating costs. A scheduled trial of a cropped regional extract could use an existing computer or eligible public Actions minutes for $0 incremental cost, subject to capacity and hosting terms. A managed distribution example is Cloudflare Workers Paid at $5/month, plus any separate decoding and storage costs. Actual production estimates require a pilot measuring update frequency, payload size and traffic. This release provisions no infrastructure. [NWS reuse terms](https://www.weather.gov/disclaimer) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

Live NWS checks returned published polygons and non-null entries in wind speed, direction and gust series at Richmond (MTR/87,112), Brannan Island (STO/30,49) and near Pacifica (MTR/80,98). All three grid responses allowed cross-origin requests. These samples establish reachability and data shape. Values can still be absent for particular forecast hours.

Tides and tidal currents continue to use CO-OPS predictions anchored to named stations. Bearings are drawn only when supplied. NOAA's San Francisco Bay Operational Forecast System is a candidate for broader, clearly labeled modeled current coverage. A future integration would need to preserve the native wet-cell mask, distinguish nowcast and forecast times and verify coverage for each waterway. No station-to-station interpolation was added. [CO-OPS API](https://api.tidesandcurrents.noaa.gov/api/prod/) · [San Francisco Bay OFS](https://www.tidesandcurrents.noaa.gov/ofs/sfbofs/sfbofs_info.html)

## Updates and verification

GitHub Pages can publish the marker, HTML, worker and asset responses at different times. The update check now probes the marker in parallel with worker updating and can try the release-qualified worker when the first worker installation becomes redundant. A controlling 3.0.9 worker keeps normal navigation on its validated shell during a release mismatch. The update banner signals a ready shell and its reload returns to the permanent URL. Fishing logs, favorites and preferences remain in local storage.

The post-merge workflow verifies served bytes, then separately launches the deployed app in an emulated iPhone browser and verifies the active worker version. The test covers the permanent URL and the previous worker registration path. A real installed iPhone session and live 3.0.9 verification remain pending an approved merge.

## Performance measurements

Playwright Chromium at an iPhone 13 viewport, with a fixed 180 ms delay per mocked NWS request. This is a single comparison per version. First visible refers to a visible reading marker, and request cycle includes the viewport debounce and queued requests. These figures do not measure physical-device battery use.

| Scenario | 3.0.8 | 3.0.9 |
| --- | --- | --- |
| Close zoom straddling a cached published polygon | 398 ms first reading, 1,115 ms request cycle, 13 NWS requests | 213 ms first reading, 746 ms request cycle, 7 NWS requests |
| Short cached pan | 1 ms first reading, 0 requests | 3 ms first reading, 0 requests |
| Return pan | 1 ms first reading, 0 requests | 1 ms first reading, 0 requests |
| New area with no published polygons in the fixture | 396 ms first reading, 929 ms request cycle, 12 requests | 392 ms first reading, 942 ms request cycle, 12 requests |
| Close zoom with no published polygons in the fixture | 386 ms first reading, 2,586 ms request cycle, 37 requests | 403 ms first reading, 2,653 ms request cycle, 37 requests |
| Basemap coverage after failed zoom with cached previews | 100% | 100% |
| Heatmap raster rebuilds on cached pan | 0 | 0 |
