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
NWS makes its API data open and free to use. The map updates its sample area after panning or zooming. The wind flow and speed
shading interpolate only within cells where all four surrounding samples have the
required values for the selected Pacific forecast time. The point labels show
source samples. Wide views show a limited region around the center, and areas
outside NWS coverage stay blank. Gust readings are independent of sustained wind
readings and appear as discrete samples. NOAA [CO-OPS](https://tidesandcurrents.noaa.gov/api/)
supplies station-based tide and current predictions. Official NWS advisories stay
freely accessible. The existing basemap uses OpenStreetMap with attribution and
is subject to its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

The **Animate flow** control pauses wind and current motion. The map respects
reduced-motion settings and suspends animation when offscreen or in a background
tab. NOAA current streaks indicate only the supplied direction near the station.
The nearest-event markers show their prediction time in the station popup.

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
