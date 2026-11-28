"""Validate the checked-in snapshot structure before it is shipped."""
import json
from datetime import date
from pathlib import Path
import unittest
from urllib.parse import urlsplit


class FishingRulesTests(unittest.TestCase):
    def test_snapshot_provenance_and_dates(self):
        snapshot = json.loads((Path(__file__).resolve().parents[1] / "fishing-rules.json").read_text())
        self.assertIn(
            'name="marinecast-version" content="' + snapshot["release"] + '"',
            (Path(__file__).resolve().parents[1] / "index.html").read_text(),
        )
        release = json.loads((Path(__file__).resolve().parents[1] / "release.json").read_text())
        self.assertEqual(snapshot["release"], release["version"])
        date.fromisoformat(snapshot["verified"])
        groundfish = snapshot["groundfish"]
        self.assertLessEqual(date.fromisoformat(groundfish["verified"]), date.fromisoformat(groundfish["reviewBy"]))
        self.assertTrue(set(groundfish["areas"]) <= set(groundfish["regions"]))
        self.assertEqual({fish["name"] for fish in groundfish["prohibited"]},
                         {"Quillback rockfish", "Yelloweye rockfish", "Cowcod", "Bronzespotted rockfish"})
        sources = snapshot["sources"]
        regions = snapshot["regions"]
        species = snapshot["species"]
        entries = snapshot["entries"]
        self.assertCountEqual(entries, [item["id"] for item in species if item["id"] not in {"cabezon", "greenling"}])
        self.assertEqual({row["favorite"] for row in groundfish["limits"] if "favorite" in row}, {"cabezon", "greenling"})
        self.assertTrue({
            "ca-halibut", "pacific-halibut", "striped-bass", "white-sturgeon", "chinook",
            "rockfish", "lingcod", "coho", "leopard-shark", "dungeness-crab"
        } <= entries.keys())
        for label, url in sources.values():
            self.assertTrue(label)
            self.assertEqual(urlsplit(url).scheme, "https")
        for region in regions.values():
            self.assertIn(region["source"], sources)
        for item in species:
            with self.subTest(species=item["id"]):
                self.assertTrue(item["sources"])
                self.assertTrue(set(item["sources"]) <= sources.keys())
                if item["id"] not in {"cabezon", "greenling"}:
                    self.assertTrue(entries[item["id"]])
                if "image" in item:
                    img = item["image"]
                    self.assertTrue(img["credit"].startswith("Photo: "))
                    for key in ("url", "source", "reuse"):
                        self.assertIn(urlsplit(img[key]).hostname, {"www.fisheries.noaa.gov", "www.fws.gov", "thumb.wikimedia.org",
                                                                         "upload.wikimedia.org", "commons.wikimedia.org"})
                        self.assertEqual(urlsplit(img[key]).scheme, "https")
                for entry in entries.get(item["id"], []):
                    self.assertIn(entry["kind"], {"reference", "schedule", "emergency"})
                    if entry["kind"] == "emergency":
                        self.assertTrue(entry["sources"])
                    self.assertTrue(entry["regions"])
                    self.assertTrue(set(entry["regions"]) <= regions.keys())
                    self.assertTrue(set(entry["sources"]) <= sources.keys())
                    start, end, verified, review = (
                        date.fromisoformat(entry[key]) for key in ("from", "through", "verified", "reviewBy")
                    )
                    self.assertLessEqual(start, end)
                    self.assertLessEqual(verified, review)
                    if entry["kind"] != "reference":
                        self.assertLessEqual((review - verified).days, 14)
                    if "effective" in entry:
                        self.assertLessEqual(date.fromisoformat(entry["effective"]), start)
                    self.assertTrue(entry["rules"])
                    self.assertTrue(set(entry["rules"]) <= {
                        "minimum", "maximum", "bag", "possession", "season", "depth", "methods", "permits", "special"
                    })


    def test_salmon_reaches_have_expiring_sources(self):
        snapshot = json.loads((Path(__file__).resolve().parents[1] / "fishing-rules.json").read_text())
        salmon = snapshot["salmon"]
        self.assertEqual(set(salmon["oceanAreas"]), {"bay", "north", "mendocino", "sf", "central", "south"})
        self.assertEqual(snapshot["entries"]["coho"][0]["status"], "retention")
        for reach in salmon["rivers"].values():
            self.assertTrue(reach["label"])
            for entry in reach["entries"]:
                self.assertEqual(entry["regions"], ["river"])
                self.assertNotEqual(entry["status"], "open")
                self.assertTrue(entry["sources"])
                self.assertTrue(set(entry["sources"]) <= snapshot["sources"].keys())
                self.assertLessEqual(date.fromisoformat(entry["from"]), date.fromisoformat(entry["through"]))
                self.assertLessEqual((date.fromisoformat(entry["reviewBy"]) -
                                      date.fromisoformat(entry["verified"])).days, 14)

    def test_photo_inventory_has_sources_and_safe_enlargement_urls(self):
        snapshot = json.loads((Path(__file__).resolve().parents[1] / "fishing-rules.json").read_text())
        groundfish = snapshot["groundfish"]
        rows = [item for item in snapshot["species"] if item["id"] not in groundfish["species"]]
        rows += groundfish["limits"] + groundfish["prohibited"]
        allowed_hosts = {"www.fws.gov", "www.fisheries.noaa.gov",
                         "thumb.wikimedia.org", "upload.wikimedia.org", "commons.wikimedia.org"}
        missing = []
        for row in rows:
            assets = list(row.get("images", [row.get("image")]))
            if "riverImage" in row:
                assets.append(row["riverImage"])
            for asset in assets:
                with self.subTest(fish=row["name"], asset=asset):
                    self.assertIsNotNone(asset)
                    if "url" not in asset:
                        missing.append(asset["label"])
                        continue
                    self.assertTrue(asset["alt"])
                    self.assertTrue(asset["credit"].startswith("Photo: "))
                    for key in ("url", "source", "full", "reuse"):
                        if key in asset:
                            url = urlsplit(asset[key])
                            self.assertEqual(url.scheme, "https")
                            self.assertIn(url.hostname, allowed_hosts)
                    if "license" in asset:
                        label, url = asset["license"]
                        self.assertTrue(label)
                        self.assertEqual(urlsplit(url).hostname, "creativecommons.org")
        self.assertEqual(missing, ["Sunset rockfish"])
