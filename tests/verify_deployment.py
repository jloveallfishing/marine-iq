"""Compare the production app shell with the checked-out release."""

import os
import json
from pathlib import Path
import time
from urllib.parse import urlencode, urljoin
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ASSETS = (
    ("index.html", ""),
    ("index.html", "index.html?v=311"),
    ("sw.js", "sw.js"),
    ("release.json", "release.json"),
    ("marine-motion.js", "marine-motion.js?v=309"),
    ("marine-tiles.js", "marine-tiles.js?v=309"),
    ("marine-mpa.js", "marine-mpa.js?v=300"),
    ("marine-rules.js", "marine-rules.js?v=311"),
    ("fishing-rules.json", "fishing-rules.json?v=311"),
    *((path.relative_to(ROOT).as_posix(), path.relative_to(ROOT).as_posix())
      for path in sorted((ROOT / "assets/rules").glob("*.jpg"))),
    ("mpa-boundaries.geojson", "mpa-boundaries.geojson?v=28"),
    ("vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.js"),
    ("vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.css"),
    ("vendor/leaflet/LICENSE", "vendor/leaflet/LICENSE"),
    ("vendor/leaflet/images/marker-icon.png", "vendor/leaflet/images/marker-icon.png"),
    ("vendor/leaflet/images/marker-icon-2x.png", "vendor/leaflet/images/marker-icon-2x.png"),
    ("vendor/leaflet/images/marker-shadow.png", "vendor/leaflet/images/marker-shadow.png"),
    ("vendor/leaflet/images/layers.png", "vendor/leaflet/images/layers.png"),
    ("vendor/leaflet/images/layers-2x.png", "vendor/leaflet/images/layers-2x.png"),
    ("manifest.webmanifest", "manifest.webmanifest"),
    ("icon-192.png", "icon-192.png"),
    ("icon-512.png", "icon-512.png"),
    ("brand.jpg", "brand.jpg?v=6"),
    ("brand-light.jpg", "brand-light.jpg?v=11"),
)


def verify_browser(base, release):
    from playwright.sync_api import expect, sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("MARINECAST_BROWSER_PATH"))
        page = browser.new_page(**playwright.devices["iPhone 13"])
        origin = urljoin(base, "/")
        page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
        page.goto(base + "#rules", wait_until="domcontentloaded")
        page.wait_for_function("Boolean(navigator.serviceWorker.controller)", timeout=20000)
        version = page.evaluate("""() => new Promise(resolve => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 5000);
            channel.port1.onmessage = ({data}) => {
                clearTimeout(timer); channel.port1.close(); resolve(data);
            };
            navigator.serviceWorker.controller.postMessage('marinecast-version', [channel.port2]);
        })""")
        if version != release:
            raise SystemExit(f"Service worker is {version}; expected {release}")
        expect(page.locator("#rules-cards .rule-card").first).to_be_visible()
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", release)
        query = urlencode({"marinecast-release": release, "marinecast-refresh": time.time_ns()})
        page.goto(base + "?" + query + "#rules", wait_until="domcontentloaded")
        expect(page).to_have_url(base + "#rules")
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", release)
        browser.close()


def main():
    base = os.environ["MARINECAST_URL"].rstrip("/") + "/"
    release = json.loads((ROOT / "fishing-rules.json").read_text())["release"]
    if json.loads((ROOT / "release.json").read_text())["version"] != release:
        raise SystemExit("Release marker and rules snapshot differ")
    launch = json.loads((ROOT / "manifest.webmanifest").read_text())["start_url"]
    if urljoin(base, launch) != base:
        raise SystemExit("Installed launch URL changed")
    release_query = urlencode({"marinecast-release": release, "marinecast-refresh": time.time_ns()})
    expected = [(route, (ROOT / file).read_bytes()) for file, route in ASSETS]
    expected.extend([
        ("?" + release_query, (ROOT / "index.html").read_bytes()),
        ("sw.js?" + urlencode({"release": release}), (ROOT / "sw.js").read_bytes()),
        ("release.json?check=" + str(time.time_ns()), (ROOT / "release.json").read_bytes()),
    ])
    # Existing installed clients may be registered at the previous worker URL.
    major, minor, patch = map(int, release.split("."))
    if patch:
        previous = f"{major}.{minor}.{patch - 1}"
        expected.append(("sw.js?" + urlencode({"release": previous}), (ROOT / "sw.js").read_bytes()))
    deadline = time.monotonic() + 540
    while True:
        failures = []
        for route, content in expected:
            try:
                request = Request(base + route, headers={"Cache-Control": "no-cache"})
                with urlopen(request, timeout=10) as response:
                    if response.read() != content:
                        failures.append(f"{route or '/'} differs from this commit")
            except (URLError, OSError) as error:
                failures.append(f"{route or '/'} returned {error}")
        if not failures:
            print(f"Verified {len(expected)} published routes at {base}", flush=True)
            if os.environ.get("MARINECAST_VERIFY_BROWSER") == "1":
                verify_browser(base, release)
                print(f"Verified clean and worker-controlled launches of {release}", flush=True)
            return
        if time.monotonic() >= deadline:
            raise SystemExit("\n".join(failures))
        print("Waiting for deployment. " + "; ".join(failures), flush=True)
        time.sleep(15)


if __name__ == "__main__":
    main()
