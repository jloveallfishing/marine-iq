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
NWS makes its API data open and free to use. The zoomable map displays discrete
samples so missing readings remain visible as gaps. Gust readings are independent
of sustained wind readings. NOAA [CO-OPS](https://tidesandcurrents.noaa.gov/api/)
supplies station-based tide and current predictions. Official NWS advisories stay
freely accessible. The existing basemap uses OpenStreetMap with attribution and
is subject to its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
