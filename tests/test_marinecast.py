import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
import threading
import unittest
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DAY = "2026-07-15"
STATION = {"id": "TEST", "name": "Test station", "lat": 37.928, "lng": -122.4}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class MarineCastTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.leaflet = {}
        for name, content_type in (("leaflet.js", "text/javascript"), ("leaflet.css", "text/css")):
            with urlopen("https://unpkg.com/leaflet@1.9.4/dist/" + name, timeout=20) as response:
                cls.leaflet[name] = (response.read(), content_type)
        handler = functools.partial(Handler, directory=str(ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/"
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server.shutdown)
        engine = getattr(cls.playwright, os.environ.get("MARINECAST_BROWSER", "chromium"))
        cls.browser = engine.launch(executable_path=os.environ.get("MARINECAST_BROWSER_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(
            **self.playwright.devices["iPhone 13"], reduced_motion="reduce"
        )
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.requests = []
        self.event_only = False
        self.current_bearing = 90
        self.page.route("https://**/*", self.mock_provider)

    def mock_provider(self, route):
        url = urlparse(route.request.url)
        params = parse_qs(url.query)
        host, path = url.hostname, url.path
        self.requests.append((host, path, params))
        if host == "unpkg.com":
            asset = self.leaflet.get(Path(path).name)
            if asset:
                return route.fulfill(body=asset[0], content_type=asset[1], headers={"Access-Control-Allow-Origin": "*"})
            return route.abort()
        if host == "tile.openstreetmap.org":
            return route.abort()
        if host == "api.weather.gov" and path.startswith("/points/"):
            fixture = "test" if re.fullmatch(r"/points/-?\d+\.\d{4},-?\d+\.\d{4}", path) else "trip"
            return route.fulfill(json={"properties": {
                "forecastGridData": "https://api.weather.gov/gridpoints/" + fixture
            }})
        if host == "api.weather.gov" and path.startswith("/gridpoints/"):
            def field(unit, first, second):
                return {"uom": unit, "values": [
                    {"validTime": DAY + "T07:00:00Z/PT1H", "value": first},
                    {"validTime": DAY + "T08:00:00Z/PT1H", "value": second},
                ]}
            return route.fulfill(json={"properties": {
                "windSpeed": field("wmoUnit:km_h-1", 20, None),
                "windDirection": field("wmoUnit:degree_(angle)", 90, None),
                "windGust": field("wmoUnit:km_h-1", None, 40),
            }})
        if host == "api.tidesandcurrents.noaa.gov" and params.get("type") == ["currentpredictions"]:
            return route.fulfill(json={"stations": [STATION]})
        if host == "api.tidesandcurrents.noaa.gov" and params.get("product") == ["currents_predictions"]:
            if self.event_only:
                return route.fulfill(json={"current_predictions": {"cp": [
                    {"Time": DAY + " 07:54", "Velocity_Major": 2, "meanFloodDir": 90, "Type": "flood"},
                    {"Time": DAY + " 12:05", "Velocity_Major": 0, "Type": "slack"},
                ]}})
            return route.fulfill(json={"current_predictions": {"cp": [
                {"Time": DAY + " 07:00:00", "Velocity_Major": 2, "meanFloodDir": self.current_bearing},
                {"Time": DAY + " 08:00:00", "Velocity_Major": -1, "meanEbbDir": 270},
            ]}})
        if host == "api.weather.gov" and path == "/alerts/active":
            return route.fulfill(json={"features": []})
        return route.fulfill(status=503, json={})

    def open_map(self):
        self.page.goto(self.url)
        self.assertTrue(self.page.evaluate("Boolean(window.L)"))
        self.page.locator("#day").fill(DAY)
        self.page.evaluate("location.hash = 'locations'")
        expect(self.page.locator("#page-map")).to_be_visible()
        expect(self.page.locator("#marineStatus")).to_contain_text("loaded points")

    def set_hour(self, hour):
        self.page.locator("#marineTime").evaluate(
            "(input, hour) => { input.value = hour * 60; input.dispatchEvent(new Event('input')); }",
            hour,
        )

    canvas_has_color = """() => {
        const canvas = document.querySelector('.marine-flow');
        return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value, i) => i % 4 === 3 && value > 0);
    }"""

    def test_wind_layers_and_playback(self):
        self.open_map()
        pins = self.page.locator(".marine-pin")
        expect(pins.first).to_contain_text("12 mph")
        self.assertGreater(pins.count(), 8)
        expect(self.page.locator(".marine-moving").first).to_have_css("animation-name", "none")
        self.page.locator("#marineLayer").select_option("Wind heatmap")
        expect(self.page.locator("#marineStatus")).to_contain_text("interpolated between complete cells")
        expect(self.page.locator("#marineLegend")).to_contain_text("Wind speed (MPH)")
        expect(self.page.locator("#marineLegend")).to_contain_text("40+")
        self.assertTrue(self.page.evaluate(self.canvas_has_color))
        expect(self.page.locator("#marineMotion")).to_be_disabled()
        expect(pins.first).to_contain_text("12 mph")
        self.page.locator("#marineLayer").select_option("Gusts")
        expect(pins).to_have_count(0)
        player = self.page.locator("#marinePlay")
        player.click()
        expect(pins.first).to_contain_text("25 mph")
        player.click()
        self.page.locator("#marineLayer").select_option("Wind")
        expect(pins).to_have_count(0)
        self.assertGreaterEqual(self.page.locator("#marineLayer").bounding_box()["height"], 44)

    def test_interpolation_leaves_missing_cells_empty(self):
        self.page.goto(self.url)
        observed = self.page.evaluate("""() => {
            const grid = {latitudes: [1, 0], longitudes: [0, 1, 2]};
            const sample = MarineMotion.field(grid, [
                [{speed: 0, vector: [0, 0]}, {speed: 10, vector: [10, 0]}, null],
                [{speed: 10, vector: [0, 10]}, {speed: 20, vector: [10, 10]}, {speed: 30, vector: null}]
            ], ([lat, lon]) => ({x: lon, y: 1 - lat}));
            return [sample(.5, .5), sample(.5, .5, true), sample(1.5, .5), sample(-1, .5)];
        }""")
        self.assertEqual(observed, [10, [5, 5], None, None])

    def test_pan_and_zoom_load_new_points(self):
        self.open_map()
        points = lambda: {path for host, path, _ in self.requests
                          if host == "api.weather.gov" and path.startswith("/points/")}
        initial = points()
        self.assertGreaterEqual(len(initial), 20)
        grids = [path for _, path, _ in self.requests if path == "/gridpoints/test"]
        self.assertEqual(len(grids), 1)
        self.page.evaluate("map.panTo([34, -119], {animate: false})")
        self.page.wait_for_function("document.querySelector('#marineStatus').textContent.includes('loaded points')")
        after_pan = points()
        self.assertTrue(any(path.startswith("/points/34.") for path in after_pan - initial))
        self.page.evaluate("map.setZoom(11, {animate: false})")
        self.page.wait_for_function("document.querySelector('#marineStatus').textContent.includes('loaded points')")
        self.assertGreater(len(points()), len(after_pan))
        self.assertLessEqual(len(points() - after_pan), 24)

    def test_animation_can_pause_and_respects_reduced_motion(self):
        self.open_map()
        motion = self.page.locator("#marineMotion")
        expect(motion).to_be_disabled()
        self.assertFalse(self.page.evaluate(self.canvas_has_color))
        self.page.emulate_media(reduced_motion="no-preference")
        self.page.locator("#map").scroll_into_view_if_needed()
        expect(motion).to_be_enabled()
        self.page.wait_for_function(self.canvas_has_color)
        motion.uncheck()
        self.page.wait_for_function("() => !(" + self.canvas_has_color + ")()")
        motion.check()
        self.page.wait_for_function(self.canvas_has_color)
        self.page.evaluate("location.hash = 'tripsetup'")
        expect(self.page.locator("#page-map")).to_be_hidden()
        self.page.wait_for_function("() => !(" + self.canvas_has_color + ")()")

    def test_directional_current_animation_requires_a_bearing(self):
        self.open_map()
        self.page.locator("#marineLayer").select_option("Currents")
        expect(self.page.locator(".marine-pin").first).to_contain_text("2.30 mph")
        self.page.emulate_media(reduced_motion="no-preference")
        self.page.locator("#map").scroll_into_view_if_needed()
        self.page.wait_for_function(self.canvas_has_color)
        self.current_bearing = None
        self.page.locator("#marineRefresh").click()
        expect(self.page.locator(".marine-pin").first).to_contain_text("2.30 mph")
        expect(self.page.locator(".marine-arrow")).to_have_count(0)
        self.assertFalse(self.page.evaluate(self.canvas_has_color))

    def test_currents_in_pacific_time(self):
        self.open_map()
        self.page.locator("#marineLayer").select_option("Currents")
        expect(self.page.locator(".marine-pin").first).to_contain_text("2.30 mph")
        self.set_hour(1)
        expect(self.page.locator(".marine-pin").first).to_contain_text("1.15 mph")
        self.set_hour(2)
        expect(self.page.locator(".marine-pin")).to_have_count(0)
        self.assertTrue(any(params.get("time_zone") == ["gmt"]
                            for _, _, params in self.requests))

    def test_event_only_station_shows_timestamp(self):
        self.event_only = True
        self.open_map()
        self.page.locator("#marineLayer").select_option("Currents")
        pin = self.page.locator(".marine-pin").first
        expect(pin).to_contain_text("Event · 2.30 mph")
        self.set_hour(1)
        expect(self.page.locator("#marineStatus")).to_contain_text("0 of 1 loaded points")
        pin.click()
        expect(self.page.locator(".leaflet-popup-content")).to_contain_text("12:54 AM PT")

    def test_saved_data_and_branding(self):
        saved = {
            "marinecastFishingLog": json.dumps([
                {"date": DAY, "location": "My saved spot", "species": "Halibut", "count": 2}
            ]),
            "marinecastCustomSpots": json.dumps([["My saved spot", 34, -119, ""]]),
            "marinecastLastSpot": json.dumps(["My saved spot", 34, -119, ""]),
            "marinecastAppearance": "light",
        }
        self.page.add_init_script(
            "Object.entries(" + json.dumps(saved) + ").forEach(([key,value]) => localStorage.setItem(key,value));"
        )
        self.page.goto(self.url)
        expect(self.page.locator("body")).to_have_class("light")
        logo = self.page.locator("header.brand img")
        expect(logo).to_be_visible()
        self.assertIn("brand-light.jpg", logo.evaluate("(img) => img.currentSrc"))
        self.assertIn("My saved spot", self.page.locator("#spot").inner_text())
        self.assertIn("Halibut", self.page.locator("#logentries").text_content())
        for key, value in saved.items():
            self.assertEqual(self.page.evaluate("(key) => localStorage.getItem(key)", key), value)


if __name__ == "__main__":
    unittest.main()
