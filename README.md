# marine-iq
JLoveallFishing Marine Weather and Fishing Trip Planner

## Development and release

MarineCast is a static app. Serve the repository over HTTP for local development.
The browser tests use an iPhone 13 viewport and simulated provider responses. Run
the suite on Chromium and WebKit to match the pull request checks.

```sh
python -m pip install -r tests/requirements.txt
python -m playwright install chromium webkit
MARINECAST_BROWSER=chromium python -m unittest discover -s tests -v
MARINECAST_BROWSER=webkit python -m unittest discover -s tests -v
```

### Production deployment

Keep the existing production origin and path so installed apps and locally saved
data remain available. Pull requests run both browser checks. On `main`, the
workflow also compares the live app shell with the checked-out release. Set the
repository Actions variable `MARINECAST_URL` if production uses a custom URL.
The verification job falls back to the standard project Pages URL.

For an existing Pages deployment from `main`, keep that source and leave
`MARINECAST_PAGES_MODE` unset. GitHub Pages publishes as before and the workflow
verifies the result. To let the workflow publish after both browser checks pass,
select **GitHub Actions** in **Settings → Pages** and set the repository Actions
variable `MARINECAST_PAGES_MODE` to `actions`. Require both browser status checks
before merging if repository branch rules are available.

### Automatic app updates

On a secure origin, the app checks at startup, on foreground and reconnect
events, and periodically while visible. The service worker activates only
after caching a shell with the matching release version. Open forms are left
intact. In Settings, **Check for Updates** reports the active version, and
**Reload to update** loads the verified shell while retaining the existing
address and saved data. Normal navigation prefers the active shell if the
same production URL returns older app HTML. Offline launches use the cached
shell.

An installed app can keep an older page while it remains open. An update
can also wait for its assets, or an intermediary can still return older
HTML during a rollout. These are verified browser behaviors and possible
explanations for the reported iPhone symptom. A physical iPhone run is
needed to identify the cause on that device.

To verify on an iPhone after publishing, open the existing home-screen icon
while online and confirm the old version is installed before the rollout. Let
the app check for updates, then relaunch it from the same icon. Confirm the
new version on Home and check a previously saved spot and fishing-log entry.
For the offline check, disconnect after the update and relaunch once more.
The automated test covers worker activation and offline navigation in browser
engines. It does not exercise the iOS home-screen lifecycle.

### Rollback

Revert the release PR in a new PR and merge it after both browser checks pass.
For a merge commit, use `git revert -m 1 <merge-commit>`. For a squash commit,
use `git revert <commit>`. Verify the resulting deployment in Actions before
closing the rollback. The reverted shell and service worker ship together.
For Version 2.2, which introduces the workflow, revert the app files and their
feature-specific tests while keeping the workflow and deployment verifier.
If reverting the entire workflow introduction in Actions publishing mode,
restore the previous Pages publishing source first. Keep
the same production URL to preserve storage and installed app identity.

### Map data

The wind overlays use [NWS grid forecasts](https://www.weather.gov/documentation/services-web-api).
NWS makes its API data open and free to use. The map retains valid overlays while panning and zooming, then checks for
missing coverage after movement settles. It samples a bounded perimeter around
the visible map. Forecasts are cached in memory by grid point or station and
Pacific date, with cached readings for each available time. Wind, wind heatmap,
and gust layers share the NWS data. Provider rate-limit responses trigger a
cooldown. Cached wind readings become stale after 10 minutes and are dropped
after an hour. Cached station predictions become stale after 30 minutes and are
dropped after 24 hours. A failed refresh also flags retained readings as stale.
Popups show the original valid time and the fetch time for stale readings. The wind flow and speed
shading interpolate only within cells where all four surrounding samples have the
required values for the selected Pacific forecast time. The point labels show
source samples. Wide views show a limited region around the center, and areas
outside NWS coverage stay blank. Gust readings are independent of sustained wind
readings and appear as discrete samples. NOAA [CO-OPS](https://tidesandcurrents.noaa.gov/api/)
supplies station-based tide and current predictions. Official NWS advisories stay
freely accessible. The existing basemap uses OpenStreetMap with attribution and
is subject to its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

Wind, heatmap, and gust labels are spaced by zoom level. The map gives open
popups and fresh samples priority when labels compete for room. The original
forecast samples still drive the overlays. The date picker uses the same
Pacific date as the trip planner. Adjust **Heatmap opacity** to reveal more
basemap detail. It changes shading only and saves the setting on this device.

The **Animate flow** control pauses wind and current motion. The map respects
reduced-motion settings and suspends animation when offscreen or in a background
tab. NOAA current streaks indicate only the supplied direction near the station.
The nearest-event markers show their prediction time in the station popup.

### Map performance benchmark

Run `python tests/benchmark_map.py` for an iPhone 13 viewport with 180 ms of
simulated latency per NWS request. To compare against another checkout, set
`MARINECAST_BENCH_ROOT` to its path. The script reports time to the first marker
inside the map viewport and the number of provider requests for each movement.
The fixture maps all NWS sample points to a shared grid response to exercise
deduplication. Actual timing depends on the device, network, and grid coverage.

### Model and satellite source investigation

| Source | Potential use | Integration requirements |
| --- | --- | --- |
| [NOAA GFS via NODD](https://registry.opendata.aws/noaa-gfs-bdp-pds/) | Global model comparison, including offshore coverage. The public 0.25° product includes 10 m wind components. | Fetch indexed GRIB2 ranges or subset upstream, then decode and publish compact, cacheable comparison data. Show model run and valid time. |
| [NOAA HRRR via NODD](https://registry.opendata.aws/noaa-hrrr-pds/) | Higher-resolution, short-range comparison over the U.S. and nearby waters covered by the model domain. | Process on the same valid times, levels and units as GFS. Preserve domain gaps and distinguish each model from the NWS forecast. |
| [NOAA NOMADS](https://nomads.ncep.noaa.gov/info.php?page=gribfilter) | Regional and variable subsets for testing or a low-frequency shared ingest. | NOAA asks automated loops to wait at least 10 seconds between requests. Avoid a separate ingest for each browser or map gesture. |
| [Copernicus Sentinel-2](https://dataspace.copernicus.eu/data-collections/copernicus-sentinel-missions/sentinel-2) | Commercially reusable optical data for a detailed coastal imagery layer. | Verify service quotas and dataset attribution, or generate cached regional tiles from open Sentinel scenes. Imagery can be cloud-obscured or outdated. [Data Space terms](https://dataspace.copernicus.eu/terms-and-conditions) |
| [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/access-basics/) | Public Web Mercator imagery for regional context. NASA-produced public imagery such as a VIIRS true-color product is a candidate. | Verify the selected product's metadata, attribution, cloud cover, dates and native zoom. Regional imagery is too coarse for dock-level mapping. [NASA data licensing](https://science.data.nasa.gov/about/license) |

NOAA’s public model data can be reused commercially. Hosting, processing and
redistribution costs depend on the implementation and traffic. No model ingest,
imagery tiles, credentials, or new hosted services are active in this release.

#### Satellite imagery findings for 2.5

- **Copernicus Sentinel-2** is the stronger coastal-detail candidate. The open
  data can be reused commercially. Sentinel Hub service access has separate
  quotas. A limited regional mosaic from dated scenes would avoid sending
  every map gesture to a processing API. Check cloud cover, shoreline detail,
  and attribution on the chosen product. [Sentinel data terms](https://dataspace.copernicus.eu/terms-and-conditions) ·
  [Sentinel Hub quotas and access](https://dataspace.copernicus.eu/ecosystem/services/sentinel-hub)
- **USGS Landsat** provides a public-domain fallback. Source scenes are free
  through USGS access tools. Commercial cloud access can incur infrastructure
  charges even though the data are free. [USGS public-domain guidance](https://www.usgs.gov/faqs/are-landsat-data-cloud-still-considered-be-within-public-domain) ·
  [USGS data access](https://www.usgs.gov/landsat-missions/landsat-data-access)
- **NASA GIBS** offers Leaflet-compatible Web Mercator tiles for regional
  context. Select a commercially reusable NASA product, credit GIBS, and limit
  display to the layer's native resolution. [GIBS attribution](https://nasa-gibs.github.io/gibs-api-docs/) ·
  [Web Mercator tile documentation](https://nasa-gibs.github.io/gibs-api-docs/map-library-usage/)

The cloud test environment could read the provider documentation but blocked
direct catalog and tile-service endpoint requests. Version 2.5 adds no
imagery service, credentials, or ongoing cost.

### Regional data findings for 2.6

- The [NWS grid API](https://www.weather.gov/documentation/services-web-api)
  remains the production source. It permits commercial reuse and serves
  browser-friendly point and grid JSON, with coverage gaps offshore and a
  provider rate limit.
- [NOAA NBM](https://registry.opendata.aws/noaa-nbm/) offers blended guidance
  suitable for a shared regional wind field. [NOAA HRRR](https://registry.opendata.aws/noaa-hrrr-pds/)
  is a short-range, higher-resolution comparison source in its domain. Both
  publish publicly reusable data. A shared GRIB2 subset and cache would avoid
  downloading model files per phone or map gesture. Processing, hosting and
  transfer costs would depend on usage.
- [NOAA SFBOFS](https://tidesandcurrents.noaa.gov/ofs/sfbofs/sfbofs.html) is a
  candidate for San Francisco Bay current fields. It publishes short-term
  modeled guidance through [NOAA data services](https://tidesandcurrents.noaa.gov/ofs/ofs_faq.html).
  A prototype would need to handle the native mesh and land mask and label
  model runs and valid times separately from CO-OPS station predictions.

The [OpenStreetMap raster policy](https://operations.osmfoundation.org/policies/tiles/)
allows normal visible-area requests and HTTP caching. MarineCast defers tiles
until the map opens and retains already-loaded tiles around the viewport in
Leaflet. It uses browser HTTP caching and sends the web referrer and attribution.
Tile prefetch and offline tile downloads are disabled. No new provider or paid
service is enabled.
