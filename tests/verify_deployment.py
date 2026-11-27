"""Compare the production app shell with the checked-out release."""

import os
from pathlib import Path
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ASSETS = (
    ("index.html", ""),
    ("sw.js", "sw.js"),
    ("manifest.webmanifest", "manifest.webmanifest"),
    ("icon-192.png", "icon-192.png"),
    ("icon-512.png", "icon-512.png"),
    ("brand.jpg", "brand.jpg?v=6"),
    ("brand-light.jpg", "brand-light.jpg?v=11"),
)


def main():
    base = os.environ["MARINECAST_URL"].rstrip("/") + "/"
    expected = [(route, (ROOT / file).read_bytes()) for file, route in ASSETS]
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
            print(f"Verified {len(expected)} published assets at {base}")
            return
        if time.monotonic() >= deadline:
            raise SystemExit("\n".join(failures))
        print("Waiting for deployment. " + "; ".join(failures), flush=True)
        time.sleep(15)


if __name__ == "__main__":
    main()
