import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import socket
from pathlib import Path
import threading
import unittest
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DAY = "2026-07-15"
STATION = {"id": "TEST", "name": "Test station", "lat": 37.928, "lng": -122.4}
SLOW_PROVIDER = r"""
    const originalFetch = window.fetch;
    window.fetch = async (url, ...options) => {
        if (window.slowMapProvider !== false &&
            /api.weather.gov\/(points|gridpoints)\//.test(String(url))) {
            await new Promise(resolve => setTimeout(resolve, 180));
        }
        return originalFetch(url, ...options);
    };
"""


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/offline-check":
            # Simulate a failed origin connection in the worker itself.
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        if getattr(self.server, "legacy_shell", False) and self.path in ("/", "/index.html?v=24", "/sw.js"):
            worker = self.path == "/sw.js"
            file = ROOT / ("sw.js" if worker else "index.html")
            content = file.read_bytes().replace(b"marine-iq-v25", b"marine-iq-v24").replace(b"index.html?v=25", b"index.html?v=24") if worker else (
                file.read_bytes().replace(b"Version 2.5", b"Version 2.4")
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript" if worker else "text/html")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        super().do_GET()

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
            **self.playwright.devices["iPhone 13"], reduced_motion="reduce", service_workers="block"
        )
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.requests = []
        self.event_only = False
        self.current_bearing = 90
        self.map_response_status = 200
        self.rate_limit_points = False
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
            if self.rate_limit_points:
                return route.fulfill(status=429, headers={
                    "Retry-After": "120", "Access-Control-Expose-Headers": "Retry-After"
                }, json={})
            fixture = "test" if re.fullmatch(r"/points/-?\d+\.\d{4},-?\d+\.\d{4}", path) else "trip"
            return route.fulfill(json={"properties": {
                "forecastGridData": "https://api.weather.gov/gridpoints/" + fixture
            }})
        if host == "api.weather.gov" and path.startswith("/gridpoints/"):
            if path == "/gridpoints/test" and self.map_response_status != 200:
                return route.fulfill(status=self.map_response_status, json={})
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
        if host == "api.tidesandcurrents.noaa.gov" and params.get("type") in (["currentpredictions"], ["tidepredictions"]):
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
        if host == "api.tidesandcurrents.noaa.gov" and params.get("product") == ["predictions"]:
            return route.fulfill(json={"predictions": [{"t": DAY + " 07:00", "v": "1.4"}]})
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
        expect(self.page.locator("#marineRefresh")).to_be_enabled()

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
        with self.page.expect_request(re.compile(r"/points/34\.")):
            self.page.evaluate("map.panTo([34, -119], {animate: false})")
        expect(self.page.locator("#marineRefresh")).to_be_enabled()
        after_pan = points()
        self.assertTrue(any(path.startswith("/points/34.") for path in after_pan - initial))
        self.page.evaluate("map.setZoom(11, {animate: false})")
        self.page.wait_for_timeout(220)
        expect(self.page.locator("#marineRefresh")).to_be_enabled()
        self.assertGreater(len(points()), len(after_pan))
        self.assertLessEqual(len(points() - after_pan), 40)

    def test_slow_cached_pan_zoom_and_layer_switch(self):
        self.page.add_init_script(SLOW_PROVIDER)
        self.open_map()
        self.page.locator("#marineLayer").select_option("Wind heatmap")
        self.assertTrue(self.page.evaluate(self.canvas_has_color))
        before = len(self.requests)
        retained = self.page.evaluate("""() => {
            for (const dx of [32, -32, 32, -32]) {
                map.panBy([dx, 0], {animate: false});
                if (!document.querySelector('.marine-pin')) return false;
            }
            return true;
        }""")
        self.assertTrue(retained)
        self.assertTrue(self.page.evaluate(self.canvas_has_color))
        self.page.wait_for_timeout(260)
        self.assertFalse(any(path.startswith(("/points/", "/gridpoints/"))
                             for _, path, _ in self.requests[before:]))
        self.page.locator("#marineLayer").select_option("Gusts")
        self.set_hour(1)
        expect(self.page.locator(".marine-pin").first).to_contain_text("25 mph")
        self.assertFalse(any(path.startswith(("/points/", "/gridpoints/"))
                             for _, path, _ in self.requests[before:]))
        self.page.locator("#marineLayer").select_option("Wind")
        self.set_hour(0)
        self.page.emulate_media(reduced_motion="no-preference")
        self.page.locator("#map").scroll_into_view_if_needed()
        self.page.wait_for_function(self.canvas_has_color)
        self.page.evaluate("map.setZoom(10, {animate: false})")
        self.assertTrue(self.page.evaluate(self.canvas_has_color))
        expect(self.page.locator(".marine-pin").first).to_be_attached()

    def test_slow_new_area_loads_progressively_and_deduplicates(self):
        self.page.add_init_script(SLOW_PROVIDER)
        self.open_map()
        offset = len(self.requests)
        with self.page.expect_request(re.compile(r"/points/36\.")):
            self.page.evaluate("""() => {
                map.panTo([36.7, -122.2], {animate: false});
                map.panTo([36.6, -122.1], {animate: false});
                map.panTo([36.5, -122.1], {animate: false});
            }""")
        self.page.wait_for_function("""() => {
            const status = document.querySelector('#marineStatus').textContent;
            return status.includes('loaded points') && status.includes('Loading additional coverage');
        }""")
        self.assertTrue(self.page.locator("#marineRefresh").is_disabled())
        expect(self.page.locator("#marineRefresh")).to_be_enabled(timeout=10000)
        requests = [path for _, path, _ in self.requests[offset:] if path.startswith("/points/")]
        self.assertGreater(len(requests), 3)
        self.assertEqual(len(requests), len(set(requests)))
        self.assertTrue(all(float(path.split("/")[-1].split(",")[0]) < 37.5
                            for path in requests))

    def test_rate_limit_suspends_new_provider_requests(self):
        self.open_map()
        self.rate_limit_points = True
        offset = len(self.requests)
        with self.page.expect_request(re.compile(r"/points/34\.")):
            self.page.evaluate("map.panTo([34, -119], {animate: false})")
        expect(self.page.locator("#marineRefresh")).to_be_enabled()
        expect(self.page.locator("#marineStatus")).to_contain_text("could not be refreshed")
        first = [path for _, path, _ in self.requests[offset:] if path.startswith("/points/")]
        self.assertGreaterEqual(len(first), 1)
        self.assertLessEqual(len(first), 3)
        self.page.evaluate("map.panTo([33, -118], {animate: false})")
        self.page.wait_for_timeout(350)
        requests = [path for _, path, _ in self.requests[offset:] if path.startswith("/points/")]
        self.assertEqual(requests, first)

    def test_stale_holdover_and_unavailable_new_hour(self):
        self.page.add_init_script(SLOW_PROVIDER)
        self.open_map()
        self.map_response_status = 503
        self.page.evaluate("window.originalNow = Date.now; Date.now = () => originalNow() + 11 * 60000")
        self.page.locator("#marineRefresh").click()
        expect(self.page.locator(".marine-pin").first).to_contain_text("12 mph")
        expect(self.page.locator("#marineStatus")).to_contain_text("stale cached")
        expect(self.page.locator("#marineRefresh")).to_be_enabled(timeout=15000)
        expect(self.page.locator("#marineStatus")).to_contain_text("could not be refreshed")
        expect(self.page.locator(".marine-pin-stale").first).to_be_attached()
        self.set_hour(1)
        expect(self.page.locator(".marine-pin")).to_have_count(0)
        expect(self.page.locator("#marineStatus")).to_contain_text("unavailable")

    def test_station_layers_reuse_cache_during_repeated_pans(self):
        self.open_map()
        for layer, label, product in (("Tides", "1.4 ft", "predictions"),
                                      ("Currents", "2.30 mph", "currents_predictions")):
            self.page.locator("#marineLayer").select_option(layer)
            expect(self.page.locator(".marine-pin").first).to_contain_text(label)
            expect(self.page.locator("#marineRefresh")).to_be_enabled()
            offset = len(self.requests)
            self.page.evaluate("map.panBy([25, 0], {animate: false}); map.panBy([-25, 0], {animate: false})")
            expect(self.page.locator(".marine-pin").first).to_contain_text(label)
            self.page.wait_for_timeout(260)
            self.assertFalse(any(params.get("product") == [product] for _, _, params in self.requests[offset:]))

    def test_wind_labels_do_not_overlap_at_multiple_zooms(self):
        self.open_map()
        measure = """() => {
            const bounds = document.querySelector('#map').getBoundingClientRect();
            const boxes = [...document.querySelectorAll('.marine-wind-pin b')]
                .filter(label => getComputedStyle(label).visibility === 'visible')
                .map(label => label.getBoundingClientRect())
                .filter(box => box.right > bounds.left && box.left < bounds.right &&
                               box.bottom > bounds.top && box.top < bounds.bottom);
            const overlaps = boxes.some((a, i) => boxes.slice(i + 1).some(b =>
                a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom));
            return {count: boxes.length, overlaps,
                    shown: [...document.querySelectorAll('.marine-wind-pin b')].filter(
                        label => getComputedStyle(label).visibility === 'visible').length};
        }"""
        normal = self.page.evaluate(measure)
        self.assertGreater(normal["count"], 2)
        self.assertFalse(normal["overlaps"])
        self.page.evaluate("map.setZoom(8, {animate: false})")
        wide = self.page.evaluate(measure)
        self.assertGreater(wide["count"], 0)
        self.assertLess(wide["shown"], normal["shown"])
        self.assertFalse(wide["overlaps"])
        self.page.evaluate("map.setZoom(10, {animate: false})")
        self.page.wait_for_timeout(300)
        expect(self.page.locator("#marineRefresh")).to_be_enabled()
        self.assertFalse(self.page.evaluate(measure)["overlaps"])

    def test_heatmap_opacity_is_local_and_persists(self):
        self.open_map()
        self.page.locator("#marineLayer").select_option("Wind heatmap")
        self.assertTrue(self.page.evaluate(self.canvas_has_color))
        offset = len(self.requests)
        self.page.locator("#marineOpacity").evaluate("""input => {
            input.value = 0;
            input.dispatchEvent(new Event('input'));
            input.dispatchEvent(new Event('change'));
        }""")
        expect(self.page.locator("#marineOpacityValue")).to_have_text("0%")
        expect(self.page.locator(".marine-flow")).to_have_css("opacity", "0")
        self.page.locator("#marineLayer").select_option("Wind")
        expect(self.page.locator(".marine-flow")).to_have_css("opacity", "1")
        self.assertFalse(any(path.startswith(("/points/", "/gridpoints/"))
                             for _, path, _ in self.requests[offset:]))
        self.page.reload()
        self.page.locator("#marineLayer").select_option("Wind heatmap")
        expect(self.page.locator("#marineOpacity")).to_have_value("0")

    def test_map_date_shares_trip_date_and_invalidates_old_readings(self):
        self.open_map()
        picker = self.page.get_by_role("combobox", name="Date (PT)", exact=True)
        expect(picker).to_have_value(DAY)
        valid_day = self.page.locator("#day").get_attribute("min")
        picker.select_option(valid_day)
        expect(self.page.locator("#day")).to_have_value(valid_day)
        expect(self.page.locator(".marine-pin")).to_have_count(0)
        expect(self.page.locator("#marineStatus")).to_contain_text("unavailable")
        self.page.evaluate("""day => {
            const input = document.querySelector('#day');
            input.value = day;
            input.dispatchEvent(new Event('change', {bubbles:true}));
        }""", DAY)
        expect(picker).to_have_value(DAY)
        expect(self.page.locator(".marine-pin").first).to_contain_text("12 mph")

    def test_foreground_service_worker_upgrade_preserves_open_page_and_storage(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        self.server.legacy_shell = True
        self.addCleanup(setattr, self.server, "legacy_shell", False)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url)
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        self.assertIn("Version 2.4", page.locator("#page-home > p").first.text_content())
        page.evaluate("""() => {
            window.openPageFixture = true;
            window.upgradeActivated = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => { window.upgradeActivated = true; });
            localStorage.setItem('marinecastAppearance', 'light');
        }""")
        self.server.legacy_shell = False
        page.evaluate("""() => {
            const now = Date.now.bind(Date);
            Date.now = () => now() + 6 * 60000;
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        self.assertTrue(page.evaluate("""async () => {
            for (let i = 0; i < 120; i++) {
                const response = await caches.match('./index.html?v=25', {cacheName: 'marine-iq-v25'});
                if (window.upgradeActivated && response && (await response.text()).includes('Version 2.5')) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return false;
        }"""))
        self.assertTrue(page.evaluate("window.openPageFixture"))
        self.assertIn("Version 2.4", page.locator("#page-home > p").first.text_content())
        self.assertTrue(page.goto(self.url + "offline-check").ok)
        self.assertIn("Version 2.5", page.locator("#page-home > p").first.text_content())
        expect(page.locator("body")).to_have_class("light")

    def test_service_worker_caches_versioned_shell(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url)
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        self.assertTrue(page.evaluate("""async () => {
            const cache = await caches.open('marine-iq-v25');
            return Boolean(await cache.match('./marine-motion.js?v=25'));
        }"""))
        page.evaluate("localStorage.setItem('marinecastAppearance', 'light')")
        response = page.goto(self.url + "offline-check")
        self.assertTrue(response.ok)
        self.assertTrue(page.evaluate("Boolean(window.MarineMotion)"))
        expect(page.locator("body")).to_have_class("light")

    def test_animation_can_pause_and_respects_reduced_motion(self):
        self.open_map()
        motion = self.page.locator("#marineMotion")
        expect(motion).to_be_disabled()
        self.assertFalse(self.page.evaluate(self.canvas_has_color))
        self.page.emulate_media(reduced_motion="no-preference")
        self.page.locator("#map").scroll_into_view_if_needed()
        expect(motion).to_be_enabled()
        self.page.wait_for_function(self.canvas_has_color)
        motion.click()
        expect(motion).to_have_attribute("aria-checked", "false")
        expect(self.page.locator(".marine-flow")).to_have_css("visibility", "hidden")
        motion.click()
        expect(motion).to_have_attribute("aria-checked", "true")
        self.page.wait_for_function(self.canvas_has_color)
        self.page.evaluate("location.hash = 'tripsetup'")
        expect(self.page.locator("#page-map")).to_be_hidden()
        expect(self.page.locator(".marine-flow")).to_have_css("visibility", "hidden")

    def test_directional_current_animation_requires_a_bearing(self):
        self.open_map()
        self.page.locator("#marineLayer").select_option("Currents")
        expect(self.page.locator(".marine-pin").first).to_contain_text("2.30 mph")
        self.page.emulate_media(reduced_motion="no-preference")
        self.page.locator("#map").scroll_into_view_if_needed()
        self.page.wait_for_function(self.canvas_has_color)
        self.current_bearing = None
        self.page.locator("#marineRefresh").click()
        expect(self.page.locator("#marineRefresh")).to_be_enabled()
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
        expect(self.page.locator("#marineStatus")).to_contain_text("0 loaded points")
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
