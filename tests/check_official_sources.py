"""Compare regulator publications for review. Never update app rules automatically."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


class Publication(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.ignored = None

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "head"}:
            self.ignored = self.ignored or tag
        if self.ignored is None and tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.parts.append(href)

    def handle_endtag(self, tag):
        if tag == self.ignored:
            self.ignored = None

    def handle_data(self, data):
        if self.ignored is None and data.strip():
            self.parts.append(" ".join(data.split()))


def fetch(url):
    request = Request(url, headers={"User-Agent": "MarineCast official source review (github.com/jloveallfishing/marine-iq)"})
    with urlopen(request, timeout=35) as response:
        return response.read(), response.headers.get_content_type()


def fingerprint(url):
    body, media_type = fetch(url)
    if media_type == "text/html":
        parser = Publication()
        parser.feed(body.decode("utf-8", errors="replace"))
        body = "\n".join(parser.parts).encode()
    return hashlib.sha256(body).hexdigest()


def compare_boundaries():
    local = json.loads((ROOT / "mpa-boundaries.geojson").read_text())
    layer = local["source"]["url"]
    query = urlencode({"where": "1=1", "outFields": "OBJECTID", "outSR": 4326, "f": "geojson"})
    body, _ = fetch(layer + "/query?" + query)
    remote = json.loads(body)

    def geometry_by_id(collection):
        return {feature["properties"]["OBJECTID"]: feature["geometry"] for feature in collection["features"]}

    if remote.get("exceededTransferLimit"):
        raise RuntimeError("CDFW boundary export truncated")
    expected = geometry_by_id(local)
    published = geometry_by_id(remote)
    if expected != published:
        difference = sum(expected.get(key) != published.get(key) for key in expected.keys() | published.keys())
        raise RuntimeError(f"{difference} CDFW boundary records differ from the bundle. Review the official export.")
    print(f"Verified {len(expected)} CDFW geometries against the published service.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rules = json.loads((ROOT / "fishing-rules.json").read_text())
    ids = ["inseason", "freshwater", "bay", "north", "mendocino", "sf", "central", "south",
           "groundfish", "federalGroundfish", "halibut", "whale", "sturgeon"]
    signatures = {}
    errors = []
    urls = [rules["sources"][key][1] for key in ids] + [
        "https://wildlife.ca.gov/Conservation/Marine/MPAs/San-Francisco-Bay",
        "https://wildlife.ca.gov/Conservation/Marine/MPAs/Point-Reyes",
        "https://channelislands.noaa.gov/manage/regulations.html",
    ]
    for url in urls:
        try:
            signatures[url] = fingerprint(url)
        except Exception as error:
            errors.append(f"Could not verify {url}: {error}")
    try:
        compare_boundaries()
    except Exception as error:
        errors.append(f"Boundary verification: {error}")
    previous = json.loads(args.previous.read_text()) if args.previous and args.previous.exists() else {}
    changed = [url for url, digest in signatures.items() if previous and previous.get(url) != digest]
    if signatures and not errors:
        args.output.write_text(json.dumps(signatures, indent=2, sort_keys=True) + "\n")
    messages = errors + [f"Publication changed. Review: {url}" for url in changed]
    if messages:
        raise SystemExit("\n".join(messages))
    print(f"Checked {len(signatures)} official regulatory publications.")


if __name__ == "__main__":
    main()
