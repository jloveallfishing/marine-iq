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
Popups show the original valid time and the fetch time for stale readings.
The point labels show source samples. Wide views show a limited region around the center, and areas
outside NWS coverage stay blank. Gust readings are independent of sustained wind
readings and appear as discrete samples. NOAA [CO-OPS](https://tidesandcurrents.noaa.gov/api/)
supplies station-based tide and current predictions. Official NWS advisories stay
freely accessible. The existing basemap uses OpenStreetMap with attribution and
is subject to its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

Wind, heatmap, and gust labels are spaced by zoom level. Open popups and fresh
samples have priority. Wind particles, wind speed labels, and heatmap shading
can be switched independently, and their settings are saved on the device.
Heatmap shading has a separate opacity control and separate canvas so particle
animation can run without repainting the heatmap. The map date uses the trip
planner's Pacific date. NOAA current animation remains station-local.

Wind interpolation uses four-corner cells when all four values are available.
At coastal gaps, three valid surrounding corners support a triangle. It stays
blank outside that triangle and wherever too few samples exist. The vector
layer also requires supplied bearings except at calm samples. Close zoom uses a
minimum geographic sample spacing with a direct center sample.


### Map performance benchmark

Run `python tests/benchmark_map.py` for an iPhone 13 viewport with 180 ms of
simulated latency per NWS request. To compare against another checkout, set
`MARINECAST_BENCH_ROOT` to its path. The script reports time to the first marker
inside the map viewport and the number of provider requests for each movement.
The fixture maps all NWS sample points to a shared grid response to exercise
deduplication. It also samples viewport basemap coverage after a deliberate
replacement-tile failure and counts heat raster writes during a cached pan.
Actual timing depends on the device, network, and grid coverage.

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

### Coverage and data investigation for 2.7

Version 2.6 resolved coordinates through individually requested NWS point and
grid endpoints. Even when forecast grid URLs repeated, the chart-ready time
series was parsed for each display coordinate. The renderer seeded particles
across the screen, including outside supported cells, and dropped a whole
cell when any corner was missing. Leaflet could retain the old zoom briefly,
but a failed replacement tile had no explicit geographically aligned fallback.

Version 2.7 prioritizes the center cell, shares the parsed wind series by NWS
grid response and Pacific date, and starts particles where samples support
flow. Heatmap rasters are reused on cached pans. Visible-area tile requests
use the browser's normal HTTP cache. During loading or failure, a tile can
display an aligned crop of an already-decoded parent or a mosaic of already
decoded children. These previews use a bounded, in-memory set of 56 decoded
images. They never fetch parent or child tiles speculatively. An area without
matching imagery remains blank. [OpenStreetMap raster policy](https://operations.osmfoundation.org/policies/tiles/)

| Candidate | Findings |
| --- | --- |
| [NOAA GFS](https://registry.opendata.aws/noaa-gfs-bdp-pds/) | Commercially reusable global GRIB2 with broad offshore coverage. Its 0.25° grid is useful at wide zooms, with limited local coastal detail. |
| [NOAA HRRR](https://registry.opendata.aws/noaa-hrrr-pds/) | Commercially reusable 3 km short-range guidance. Compare only inside the HRRR domain and match forecast valid times before combining it with other products. |
| [NOAA NDFD](https://registry.opendata.aws/noaa-ndfd/) | Commercially reusable regional grids. The [NDFD XML service](https://digital.weather.gov/xml/rest.php) can request up to 100 positions with selected wind elements in one request. It is the quickest batching prototype if browser CORS and live response timing can be verified. Regional GRIB2 gives a shared-cache path with decoding and packaging work. |
| [OpenFreeMap](https://openfreemap.org/#is-commercial-usage-allowed) | Its public vector service permits commercial use and requires attribution. A MapLibre prototype would need to compare startup bytes, tile continuity, and iPhone WebGL load. The provider offers no uptime guarantee. [Terms](https://openfreemap.org/tos/) |

Direct NDFD XML, the public data bucket probe, and the OpenFreeMap style probe
were blocked by the test environment. Provider documentation was available.
The release keeps NWS JSON, NOAA station predictions, and the current raster
basemap. There is no new data service, forecast ingest, or paid dependency.

### Marine Protected Areas

The free **MPA** tab shows California coastal and San Francisco Bay boundaries
from the California Department of Fish and Wildlife, Marine Region GIS Lab.
The weather map has a separate **MPA boundaries** toggle. Search matches
protected-area names and saved fishing places locally, with explicit online
California place searches when there is no local match. GPS searches do not
change the selected fishing spot or write location history.

The 2.8 snapshot contains all 155 records returned by the published ds582
FeatureServer, including eight records in the San Francisco Bay study region.
The service reports a geometry edit date of January 9, 2024. The snapshot
was retrieved November 28, 2026. The importer checked the feature count and
unique IDs against the service, requested WGS84 GeoJSON, and verified that the
service edit timestamp stayed unchanged during export. The export selects
identifying attributes and adds source metadata. Coordinates, ring structure,
and geometry precision are retained. [CDFW FeatureServer](https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds582_fpu/FeatureServer/0)

California Open Data lists Creative Commons Attribution and public reuse
rights for the dataset. The bundled snapshot is attributed to CDFW in the
app and its metadata. The catalog's publication metadata can change
independently of the boundary service's edit date. [Dataset and license](https://publish.data.ca.gov/dataset/california-marine-protected-areas-ds582)

Color categories communicate the agency's area designations and verified
special conditions. Popups include the available regulation reference and
official links. The eight Bay records and Point Reyes SMCA have site-specific
summaries checked against CDFW pages. Other records show the verified
designation, when available, and link to official rules for permitted
activities. Gray records include complementary federal areas whose rules
are outside these summaries. Check current rules, including seasonal
closures, gear limits, and exceptions, before fishing.
[CDFW MPA regulations](https://wildlife.ca.gov/Conservation/Marine/MPAs)

The boundary snapshot is loaded only when opening the MPA map or enabling
the weather overlay. Validated data are cached locally on first use for
offline reopening. MarineCast bundles the existing Leaflet 1.9.4 renderer
under its BSD-2-Clause license. Offline mode can draw boundaries without
basemap tiles. Online search and live official rules need a connection.

GPS distances are local planar estimates to the nearest published polygon
edge, including holes. The map draws the reported accuracy radius. Boundary
classification adds an approximately 33 ft margin to that radius. Foreground warnings
are opt-in and continue across MarineCast tabs while the app is visible. Proximity uses about 500 ft plus uncertainty, and possible entry
requires a reliable outside fix followed by two reliable inside fixes.
Fixes older than 30 seconds or less accurate than about 328 ft suppress
alerts. This system cannot detect every crossing or substitute for current
rules, published coordinates, navigation charts, or a dedicated safety device.
