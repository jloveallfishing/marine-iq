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
        sources = snapshot["sources"]
        regions = snapshot["regions"]
        species = snapshot["species"]
        entries = snapshot["entries"]
        self.assertCountEqual(entries, [item["id"] for item in species])
        self.assertEqual(len(species), len(entries))
        self.assertTrue({
            "ca-halibut", "pacific-halibut", "striped-bass", "white-sturgeon", "chinook",
            "rockfish", "lingcod", "cabezon", "leopard-shark", "dungeness-crab"
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
                self.assertTrue(entries[item["id"]])
                if "image" in item:
                    img = item["image"]
                    self.assertTrue(img["credit"].startswith("Photo: "))
                    for key in ("url", "source", "reuse"):
                        self.assertIn(urlsplit(img[key]).hostname, {"www.fisheries.noaa.gov", "www.fws.gov"})
                        self.assertEqual(urlsplit(img[key]).scheme, "https")
                for entry in entries[item["id"]]:
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
