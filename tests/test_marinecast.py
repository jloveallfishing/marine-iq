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
        if self.path == "/offline-check" or getattr(self.server, "offline_app", False):
            # Simulate a failed origin connection in the worker itself.
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        legacy = getattr(self.server, "legacy_shell", False)
        stale_navigation = getattr(self.server, "stale_navigation", False)
        route = urlparse(self.path).path
        legacy_assets = {"/": "index.html", "/index.html": "index.html", "/sw.js": "sw.js",
                         "/marine-rules.js": "marine-rules.js", "/fishing-rules.json": "fishing-rules.json",
                         "/release.json": "release.json"}
        mixed = getattr(self.server, "mixed_rules_release", False)
        stale_worker = getattr(self.server, "stale_worker", False)
        stale_marker = getattr(self.server, "stale_marker", False) and route == "/release.json"
        if stale_marker or (stale_worker and self.path == "/sw.js") or (legacy and route in legacy_assets) or (stale_navigation and route == "/") or (
            mixed and self.path == "/fishing-rules.json?v=310"
        ):
            file = ROOT / legacy_assets[route]
            content = (file.read_bytes().replace(b"3.0.10", b"3.0.9")
                       .replace(b"marine-iq-v310", b"marine-iq-v309").replace(b"v=310", b"v=309"))
            content_type = {".js": "text/javascript", ".json": "application/json", ".html": "text/html"}
            self.send_response(200)
            self.send_header("Content-Type", content_type[file.suffix])
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
        vendor = Path(__file__).resolve().parents[1] / "vendor" / "leaflet"
        cls.leaflet = {name: ((vendor / name).read_bytes(), content_type)
                       for name, content_type in (("leaflet.js", "text/javascript"), ("leaflet.css", "text/css"))}
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
        self.show_tiles = False
        self.failed_tile_zoom = None
        self.page.route("https://**/*", self.mock_provider)

    def mock_provider(self, route):
        url = urlparse(route.request.url)
        params = parse_qs(url.query)
        host, path = url.hostname, url.path
        self.requests.append((host, path, params))
        if route.request.resource_type == "image" and host in {
            "www.fws.gov", "www.fisheries.noaa.gov", "thumb.wikimedia.org", "upload.wikimedia.org"
        }:
            return route.fulfill(body=(ROOT / "icon-192.png").read_bytes(), content_type="image/png")
        if host == "unpkg.com":
            asset = self.leaflet.get(Path(path).name)
            if asset:
                return route.fulfill(body=asset[0], content_type=asset[1], headers={"Access-Control-Allow-Origin": "*"})
            return route.abort()
        if host == "tile.openstreetmap.org":
            if self.show_tiles and not path.startswith(f"/{self.failed_tile_zoom}/"):
                return route.fulfill(body=(ROOT / "icon-192.png").read_bytes(), content_type="image/png",
                                     headers={"Cache-Control": "public, max-age=604800"})
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
                    {"validTime": "2026-07-16T07:00:00Z/PT1H", "value": first},
                ]}
            payload = {"properties": {
                "windSpeed": field("wmoUnit:km_h-1", 20, None),
                "windDirection": field("wmoUnit:degree_(angle)", 90, None),
                "windGust": field("wmoUnit:km_h-1", None, 40),
            }}
            if path == "/gridpoints/test" and getattr(self, "published_geometry", False):
                payload["geometry"] = {"type": "Polygon", "coordinates": [[
                    [-122.42, 37.908], [-122.38, 37.908], [-122.38, 37.948],
                    [-122.42, 37.948], [-122.42, 37.908]
                ]]}
            return route.fulfill(json=payload)
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
        const canvas = document.querySelector('.marine-flow:not(.marine-heat)');
        return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value, i) => i % 4 === 3 && value > 0);
    }"""

    heat_has_color = canvas_has_color.replace('.marine-flow:not(.marine-heat)', '.marine-heat')

    def test_wind_layers_and_playback(self):
        self.open_map()
        pins = self.page.locator(".marine-pin")
        expect(pins.first).to_contain_text("12 mph")
        self.assertGreater(pins.count(), 8)
        expect(self.page.locator(".marine-moving").first).to_have_css("animation-name", "none")
        self.page.locator("#marineLayer").select_option("Wind heatmap")
        expect(self.page.locator("#marineStatus")).to_contain_text("interpolated only between available samples")
        expect(self.page.locator("#marineLegend")).to_contain_text("Wind speed (MPH)")
        expect(self.page.locator("#marineLegend")).to_contain_text("40+")
        self.assertTrue(self.page.evaluate(self.heat_has_color))
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
            return [sample(.5, .5), sample(.5, .5, true), sample(1.25, .75), sample(1.75, .25), sample(-1, .5)];
        }""")
        self.assertEqual(observed, [10, [5, 5], 20, None, None])

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
        self.assertTrue(self.page.evaluate(self.heat_has_color))
        before = len(self.requests)
        retained = self.page.evaluate("""() => {
            for (const dx of [32, -32, 32, -32]) {
                map.panBy([dx, 0], {animate: false});
                if (!document.querySelector('.marine-pin')) return false;
            }
            return true;
        }""")
        self.assertTrue(retained)
        self.assertTrue(self.page.evaluate(self.heat_has_color))
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
        self.assertTrue(self.page.evaluate(self.heat_has_color))
        offset = len(self.requests)
        self.page.locator("#marineOpacity").evaluate("""input => {
            input.value = 0;
            input.dispatchEvent(new Event('input'));
            input.dispatchEvent(new Event('change'));
        }""")
        expect(self.page.locator("#marineOpacityValue")).to_have_text("0%")
        expect(self.page.locator(".marine-heat")).to_have_css("opacity", "0")
        self.page.locator("#marineLayer").select_option("Wind")
        expect(self.page.locator(".marine-flow:not(.marine-heat)")).to_have_css("opacity", "1")
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
        self.addCleanup(setattr, self.server, "stale_navigation", False)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url)
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        self.assertIn("Version 3.0.9", page.locator("#page-home > p").first.text_content())
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
                const response = await caches.match('./index.html?v=310', {cacheName: 'marine-iq-v310'});
                if (window.upgradeActivated && response && (await response.text()).includes('Version 3.0.10')) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return false;
        }"""))
        expect(page.locator("#updateNotice")).to_be_visible()
        expect(page.locator("#updateNotice")).to_contain_text("3.0.10 is ready")
        self.assertTrue(page.evaluate("window.openPageFixture"))
        self.assertIn("Version 3.0.9", page.locator("#page-home > p").first.text_content())
        self.assertTrue(page.goto(self.url + "offline-check").ok)
        self.assertIn("Version 3.0.10", page.locator("#page-home > p").first.text_content())
        expect(page.locator("body")).to_have_class("light")
        self.server.stale_navigation = True
        page.goto(self.url)
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", "3.0.10")

    def test_manual_update_applies_active_shell_at_permanent_url(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        self.server.legacy_shell = True
        self.addCleanup(setattr, self.server, "legacy_shell", False)
        self.addCleanup(setattr, self.server, "stale_navigation", False)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url + "#settings")
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        saved = {"marinecastFishingLog": "[]", "marineIQfavorites": "[1]",
                 "marinecastCustomSpots": '[["Test Harbor",37.9,-122.4,""]]', "marinecastAppearance": "light"}
        page.evaluate("saved => Object.entries(saved).forEach(([k,v]) => localStorage.setItem(k,v))", saved)
        self.server.legacy_shell = False
        self.server.stale_navigation = True
        page.get_by_role("button", name="Check for Updates").click()
        expect(page.locator("#updateStatus")).to_contain_text("3.0.10 is ready", timeout=16000)
        page.locator("#applyNoticeUpdate").click()
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", "3.0.10")
        expect(page).to_have_url(self.url + "#settings")
        for key, value in saved.items():
            self.assertEqual(page.evaluate("key => localStorage.getItem(key)", key), value)
        page.get_by_role("button", name="Check for Updates").click()
        expect(page.locator("#updateStatus")).to_contain_text("up to date", timeout=16000)

    def test_rules_and_more_navigation_preserve_existing_pages(self):
        page = self.page
        page.goto(self.url)
        nav = page.get_by_role("navigation", name="Main navigation")
        self.assertEqual(nav.get_by_role("link").all_text_contents(),
                         ["⌂Home", "⌖Map", "≋Forecast", "◈MPAs", "§Rules", "⋯More"])
        nav.get_by_role("link", name="More").click()
        menu = page.get_by_role("navigation", name="More pages")
        for title, section in [
            ("Seven-day forecast", "#week"), ("Fishing log", "#log"),
            ("Fishing statistics", "#logstats"), ("Favorites", "[data-more-view=favorites] section"), ("Settings", "#backups")
        ]:
            menu.get_by_role("link", name=title).click()
            expect(page.locator(section)).to_be_visible()
            expect(nav.get_by_role("link", name="More")).to_have_attribute("aria-current", "page")
        page.goto(self.url + "#log")
        expect(page.get_by_role("button", name="Save fishing log entry")).to_be_visible()
        nav.get_by_role("link", name="MPAs").click()
        expect(page.locator("#page-mpa")).to_be_visible()
        expect(page.locator("#page-rules")).to_be_hidden()

    def test_rules_use_trip_date_and_keep_unknown_and_stale_values_hidden(self):
        page = self.page
        page.add_init_script("""
            window.rulesNow = Date.parse("2026-11-28T20:00:00Z");
            Date.now = () => window.rulesNow;
        """)
        page.goto(self.url)
        page.locator("#day").fill("2026-11-28")
        page.get_by_role("link", name="Rules", exact=True).click()
        expect(page.locator("#rules-context")).to_contain_text("San Francisco Bay")
        expect(page.locator("#rules-trip")).to_contain_text("11/28/2026")
        search = page.get_by_role("searchbox", name="Search fish and shellfish")
        search.fill("dungeness")
        card = page.locator(".rule-card")
        expect(card).to_have_count(1)
        card.locator(":scope > summary").click()
        expect(card).to_contain_text("prohibited in San Francisco and San Pablo bays")
        region = page.get_by_label("Regulatory region")
        region.select_option("north")
        expect(card).to_contain_text("Emergency health delay")
        expect(card).to_contain_text("Last verified 11/28/2026")
        search.fill("pacific halibut")
        expect(card.locator(":scope > summary")).to_contain_text("Pacific halibut")
        card.locator(":scope > summary").click()
        expect(card).to_contain_text("closed north of Point Arena")
        card.get_by_text("Additional Regulations", exact=True).click()
        expect(card.get_by_role("link", name="Photo: Jlikes2Fish")).to_have_attribute(
            "href", "https://commons.wikimedia.org/wiki/File:Pacific_Halibut.JPG"
        )
        region.select_option("sf")
        expect(card).to_contain_text("subject to earlier quota closure")
        expect(card).not_to_contain_text("closed north of Point Arena")
        region.select_option("inland")
        expect(card.locator(".rule-status")).to_have_text("Unverified")
        card.get_by_text("Additional Regulations", exact=True).click()
        expect(card.get_by_role("link", name="CDFW Inland", exact=False)).to_be_visible()
        expect(card).not_to_contain_text("Emergency health delay")
        page.reload()
        expect(region).to_have_value("inland")
        search.fill("striper")
        expect(card.locator(":scope > summary")).to_contain_text("Striped bass")
        region.select_option("bay")
        page.evaluate("""() => {
            const date = document.getElementById('day');
            date.value = '2027-01-08';
            date.dispatchEvent(new Event('change', {bubbles:true}));
        }""")
        card.locator(":scope > summary").click()
        expect(card).to_contain_text("Published reference")
        expect(card).to_contain_text("18 inches total length")
        expect(card.locator(":scope > summary")).not_to_contain_text("18 inches total length")
        page.evaluate("window.rulesNow = Date.parse('2026-12-08T18:00:00Z')")
        page.evaluate("""() => {
            const date = document.getElementById('day');
            date.value = '2026-11-28';
            date.dispatchEvent(new Event('change', {bubbles:true}));
        }""")
        expect(card.locator(":scope > summary")).to_contain_text("18 inches total length")
        search.fill("dungeness")
        region.select_option("north")
        card.locator(":scope > summary").click()
        expect(card).not_to_contain_text("Emergency health delay")
        expect(card).to_contain_text("Check current official notices")

    def test_delta_rules_date_and_favorite_species(self):
        page = self.page
        page.add_init_script("Date.now = () => Date.parse('2026-11-28T20:00:00Z')")
        page.goto(self.url + "#rules")
        region = page.get_by_label("Regulatory region")
        region.select_option("delta")
        page.get_by_role("button", name="Today", exact=True).click()
        expect(page.locator("#rules-date")).to_have_value("2026-11-28")
        search = page.get_by_role("searchbox", name="Search fish and shellfish")
        search.fill("striper")
        card = page.locator(".rule-card")
        expect(card.locator(":scope > summary")).to_contain_text("18 inches total length")
        expect(card.locator(":scope > summary")).to_contain_text("2 fish")
        favorite = page.get_by_role("button", name="Favorite Striped bass")
        favorite.click()
        expect(favorite).to_have_attribute("aria-pressed", "true")
        page.reload()
        expect(region).to_have_value("delta")
        page.get_by_label("Favorite species only").check()
        expect(page.locator(".rule-card")).to_have_count(1)
        expect(favorite).to_have_attribute("aria-pressed", "true")
        favorite.click()
        expect(page.locator(".rule-card")).to_have_count(0)

    def test_mixed_deployment_keeps_previous_worker_until_assets_match(self):
        browser = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(browser.close)
        self.server.legacy_shell = True
        self.addCleanup(setattr, self.server, "legacy_shell", False)
        self.addCleanup(setattr, self.server, "mixed_rules_release", False)
        page = browser.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url + "#settings")
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        self.server.legacy_shell = False
        self.server.mixed_rules_release = True
        status = page.locator("#updateStatus")
        page.get_by_role("button", name="Check for Updates").click()
        expect(status).to_contain_text("The update could not be installed", timeout=16000)
        expect(page.locator("#updateNotice")).to_be_hidden()
        page.reload(wait_until="domcontentloaded")
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", "3.0.9")
        self.server.mixed_rules_release = False
        page.get_by_role("button", name="Check for Updates").click()
        expect(page.locator("#updateNotice")).to_be_visible(timeout=16000)

    def test_stale_canonical_worker_uses_release_qualified_worker(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        self.server.legacy_shell = True
        self.addCleanup(setattr, self.server, "legacy_shell", False)
        self.addCleanup(setattr, self.server, "stale_worker", False)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url + "#settings")
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", "3.0.9")
        self.server.legacy_shell = False
        self.server.stale_worker = True
        page.get_by_role("button", name="Check for Updates").click()
        expect(page.locator("#updateNotice")).to_contain_text("3.0.10 is ready", timeout=18000)
        self.assertTrue(page.evaluate("navigator.serviceWorker.controller.scriptURL.endsWith('?release=3.0.10')"))
        page.locator("#applyNoticeUpdate").click()
        expect(page).to_have_url(self.url + "#settings")
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", "3.0.10")

    def test_qualified_old_worker_updates_even_when_release_marker_is_stale(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        self.server.legacy_shell = True
        self.addCleanup(setattr, self.server, "legacy_shell", False)
        self.addCleanup(setattr, self.server, "stale_marker", False)
        page.goto(self.url + "#settings")
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        page.evaluate("""async () => {
            localStorage.setItem('marinecastAppearance','light');
            await navigator.serviceWorker.register('./sw.js?release=3.0.9', {updateViaCache:'none'});
        }""")
        page.wait_for_function("navigator.serviceWorker.controller.scriptURL.endsWith('?release=3.0.9')")
        self.server.legacy_shell = False
        self.server.stale_marker = True
        page.get_by_role("button", name="Check for Updates").click()
        expect(page.locator("#updateNotice")).to_contain_text("3.0.10 is ready", timeout=18000)
        page.locator("#applyNoticeUpdate").click()
        expect(page.locator('meta[name="marinecast-version"]')).to_have_attribute("content", "3.0.10")
        expect(page).to_have_url(self.url + "#settings")
        self.assertEqual(page.evaluate("localStorage.getItem('marinecastAppearance')"), "light")

    def test_rules_warn_for_mismatched_region_and_skip_trip_network(self):
        page = self.page
        page.goto(self.url + "#rules")
        expect(page.locator("#rules-context")).to_contain_text("San Francisco Bay")
        self.assertFalse(any(host in {"api.weather.gov", "api.tidesandcurrents.noaa.gov"}
                             for host, _, _ in self.requests))
        region = page.get_by_label("Regulatory region")
        region.select_option("delta")
        expect(page.locator("#rules-context")).to_contain_text("Region mismatch")
        expect(page.locator("#rules-context")).to_contain_text("Sacramento–San Joaquin Delta")
        expect(page.locator("#rules-snapshot")).to_contain_text("11/28/2026")
        region.select_option("trip")
        expect(page.locator("#rules-context")).not_to_contain_text("Region mismatch")
        page.get_by_role("link", name="Forecast", exact=True).click()
        expect(page.locator("#combined svg").first).to_be_visible()
        self.assertTrue(any(host == "api.weather.gov" for host, *_ in self.requests))

    def test_beta_feedback_download_and_compact_layout(self):
        page = self.page
        page.set_viewport_size({"width": 320, "height": 725})
        page.goto(self.url + "#feedback")
        expect(page.locator(".beta-label")).to_have_text("Beta · 3.0.10")
        action = page.get_by_role("link", name="Change location/date", exact=True)
        box = action.bounding_box()
        self.assertLessEqual(box["x"] + box["width"], 320)
        page.get_by_label("What happened?").fill("The map was blank.")
        with page.expect_download() as download:
            page.get_by_role("button", name="Download report").click()
        path = download.value.path()
        self.assertEqual(json.loads(path.read_text()), {
            "version": "3.0.10", "type": "Bug", "description": "The map was blank."
        })
        self.assertFalse(self.requests)
        for route, heading in [
            ("overview", "#page-home"), ("locations", "#page-map"), ("timeline", "#page-forecast"),
            ("mpa", "#page-mpa"), ("rules", "#page-rules"), ("more", "#page-more")
        ]:
            page.evaluate("route => location.hash = route", route)
            expect(page.locator(heading)).to_be_visible()
            self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), route)
        page.evaluate("location.hash = 'settings'")
        page.get_by_label("Appearance").select_option("light")
        expect(page.locator("body")).to_have_class("light")
        expect(page.locator(".beta-label")).to_be_visible()

    def test_offline_retains_log_favorites_and_rules(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url + "#rules")
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        expect(page.locator(".rule-card").first).to_be_visible()
        page.evaluate("""() => {
            localStorage.setItem('marineIQfavorites','[0]');
            localStorage.setItem('marinecastFishingLog',JSON.stringify([
              {species:'Lingcod',count:1,location:'Test harbor',date:'2026-11-28'}
            ]));
        }""")
        self.addCleanup(setattr, self.server, "offline_app", False)
        self.server.offline_app = True
        page.add_init_script("Object.defineProperty(Navigator.prototype, 'onLine', {get: () => false})")
        self.assertTrue(page.goto(self.url + "offline-check#rules").ok)
        expect(page.locator(".rule-card").first).to_be_visible()
        page.evaluate("location.hash = 'log'")
        expect(page.locator("#logentries")).to_contain_text("Lingcod")
        page.evaluate("location.hash = 'favorites'")
        expect(page.locator("#favorites")).to_contain_text("Richmond")
        page.evaluate("location.hash = 'timeline'")
        expect(page.locator("#combined")).to_contain_text("Unavailable offline")

    def test_solar_times_use_pacific_time_without_sending_coordinates(self):
        self.page.goto(self.url + "#astro")
        readings = self.page.evaluate("""() => {
            const times = {};
            extraAstro(['San Francisco',37.77,-122.42], '2026-07-15',
                (id,value) => { times[id] = value; });
            return times;
        }""")
        self.assertRegex(readings["sunquick"], r"^(5:5[6-9]|6:0[0-3]) AM$")
        self.assertRegex(readings["setquick"], r"^8:(2[8-9]|3[0-4]) PM$")
        self.assertIn("Approximate sunrise", readings["astrodata"])
        self.assertFalse(any("sunrise-sunset.org" in host for host, *_ in self.requests))

    def test_home_gps_status_and_static_markup(self):
        page = self.page
        page.add_init_script("""Object.defineProperty(navigator, 'geolocation', {value:{
            getCurrentPosition(success, failure) {
                if (window.gpsDenied) failure({message:'Permission denied'});
                else success({coords:{latitude:38.12,longitude:-121.70}});
            }
        }})""")
        page.goto(self.url)
        status = page.locator("#gpsstatus")
        expect(status).to_have_attribute("aria-live", "polite")
        expect(page.locator("body")).not_to_contain_text('aria-live="polite" class="muted"')
        self.assertEqual(page.evaluate("""() => {
            const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
            return ids.filter((id,i) => ids.indexOf(id) !== i);
        }"""), [])
        page.get_by_role("button", name="Use my location", exact=True).click()
        expect(status).to_contain_text("GPS location saved locally")
        self.assertEqual(page.evaluate("JSON.parse(localStorage.marinecastCustomSpots).at(-1).slice(0,3)"),
                         ["My GPS location", 38.12, -121.70])
        page.evaluate("window.gpsDenied = true")
        page.get_by_role("button", name="Use my location", exact=True).click()
        expect(status).to_contain_text("Permission denied")

    def test_groundfish_sublimits_region_method_and_expiry(self):
        page = self.page
        page.add_init_script("""window.rulesNow=Date.parse('2026-11-28T20:00:00Z');
            Date.now=()=>window.rulesNow;""")
        page.goto(self.url + "#rules")
        page.get_by_role("button", name="Today", exact=True).click()
        region = page.get_by_label("Regulatory region")
        region.select_option("north")
        page.get_by_role("searchbox", name="Search fish and shellfish").fill("yelloweye")
        card = page.locator(".rule-card")
        card.locator(":scope > summary").click()
        expect(card.locator(".rule-quick-limits")).to_contain_text("10 fish combined")
        expect(card.get_by_text("Individual species bag limits", exact=True)).to_be_visible()
        expect(card.get_by_text("Prohibited retention", exact=True)).to_be_visible()
        expect(card.locator(".rule-status")).to_have_text("Conditional")
        expect(card.get_by_text("Additional Regulations", exact=True)).to_be_visible()
        expect(card.get_by_role("heading", name="Official regulatory sources")).to_be_hidden()
        expect(card).to_contain_text("4 per person")
        expect(card).to_contain_text("Quillback rockfish")
        photo = card.locator(".rule-prohibited").get_by_role("button", name="Enlarge Quillback rockfish photo")
        expect(photo).to_be_visible()
        photo.click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.get_by_role("button", name="Close photo").click()
        expect(card.get_by_text("Cowcod · Verified photo pending")).to_be_visible()
        expect(card.get_by_text("Sunset rockfish · Verified photo pending")).to_be_visible()
        expect(card.get_by_text("10 fish combined", exact=True)).to_have_count(1)
        expect(card.get_by_text("Additional Regulations", exact=True)).to_have_count(1)
        region.select_option("south")
        expect(card).to_contain_text("2 per person")
        expect(card).not_to_contain_text("4 per person")
        expect(card).to_contain_text("seaward of the 50-fathom boundary")
        expect(card).to_contain_text("No boat retention")
        page.get_by_label("Groundfish fishing method").select_option("shore")
        expect(card).to_contain_text("Shore exemption")
        page.evaluate("window.rulesNow=Date.parse('2026-12-08T20:00:00Z')")
        page.get_by_role("button", name="Today", exact=True).click()
        expect(card.locator(".rule-status")).to_have_text("Unverified")
        expect(card).not_to_contain_text("2 per person")
        expect(card).to_contain_text("Unverified")

    def test_salmon_tabs_require_matching_waters_reach_and_date(self):
        page = self.page
        page.set_viewport_size({"width": 320, "height": 740})
        page.add_init_script("Date.now = () => Date.parse('2026-11-28T20:00:00Z')")
        page.goto(self.url + "#rules")
        page.get_by_label("Regulatory region").select_option("sf")
        page.get_by_role("searchbox", name="Search fish and shellfish").fill("salmon")
        page.get_by_role("button", name="Today", exact=True).click()
        panel = page.get_by_role("tabpanel")
        chinook = panel.locator('[data-species=chinook].rule-card')
        coho = panel.locator('[data-species=coho].rule-card')
        expect(panel).to_contain_text("Point Arena to Pigeon Point")
        expect(chinook.locator(".rule-status")).to_have_text("Closed")
        expect(coho.locator(".rule-status")).to_have_text("No retention")
        expect(coho.locator(":scope > summary")).to_contain_text("0 fish")
        expect(panel.get_by_text("Ocean-phase Chinook · Verified photo pending")).to_be_visible()
        expect(panel.get_by_text("Ocean-phase Coho · Verified photo pending")).to_be_visible()
        expect(panel.get_by_role("img")).to_have_count(0)
        panel.get_by_text("Salmon identification photos and tips", exact=True).click()
        expect(panel.get_by_role("link", name="Chinook and Coho photo comparison", exact=False)).to_be_visible()
        expect(panel).to_contain_text("spots on both tail lobes")
        page.get_by_role("tab", name="Ocean Salmon").press("ArrowRight")
        expect(page.get_by_role("tab", name="River Salmon")).to_have_attribute("aria-selected", "true")
        expect(chinook.locator(".rule-status")).to_have_text("Unverified")
        expect(chinook.get_by_role("button", name="Enlarge River Chinook photo")).to_be_visible()
        expect(coho.get_by_role("button", name="Enlarge River Coho photo")).to_be_visible()
        expect(chinook).not_to_contain_text("season closed")
        for card in (chinook, coho):
            photo = card.get_by_role("img")
            photo.scroll_into_view_if_needed()
            self.assertTrue(photo.evaluate("(image) => image.decode().then(() => image.naturalWidth > 0)"))
        reach = page.get_by_label("River section")
        reach.select_option("sac-carquinez")
        expect(chinook.locator(":scope > summary")).to_contain_text("2 Chinook")
        expect(chinook.locator(":scope > summary")).to_contain_text("4 Chinook")
        reach.select_option("trinity-lower")
        expect(chinook.locator(":scope > summary")).to_contain_text("23 inches")
        reach.select_option("klamath-spit")
        expect(chinook.locator(".rule-status")).to_have_text("Closed")
        page.locator("#rules-date").fill("2027-01-01")
        expect(chinook.locator(".rule-status")).to_have_text("Unverified")
        expect(chinook.locator(":scope > summary")).not_to_contain_text("0 Chinook")
        self.assertTrue(page.evaluate("document.documentElement.scrollWidth === innerWidth"))

    def test_rockfish_comparisons_and_removed_freshwater_cards(self):
        page = self.page
        page.set_viewport_size({"width": 320, "height": 740})
        page.add_init_script("""localStorage.setItem('marinecastFishingLog',JSON.stringify([
            {date:'2026-11-28',location:'Saved spot',species:'Black bass',count:2}
        ]))""")
        page.goto(self.url + "#rules")
        rockfish = page.locator('.rule-card[data-species="rockfish"]')
        comparison = rockfish.locator("#rule-comparisons")
        expect(comparison.locator(":scope > summary")).to_be_hidden()
        rockfish.locator(":scope > summary").click()
        expect(comparison).not_to_have_attribute("open", "")
        expect(page.locator("#rule-comparisons")).to_have_count(1)
        expect(comparison.locator("article")).to_have_count(0)
        comparison.get_by_text("Compare Species", exact=True).click()
        expect(comparison.locator("article")).to_have_count(3)
        expect(comparison).to_contain_text("Juveniles typically have two pale stripes")
        selector = comparison.get_by_label("Rockfish group")
        expect(selector.locator('option[value="deacon"]')).to_have_count(0)
        selector.select_option("tail")
        expect(selector).to_contain_text("Yellowtail vs. Olive")
        expect(comparison.get_by_role("article")).to_have_count(2)
        expect(comparison.get_by_role("heading", name="Widow", exact=True)).to_have_count(0)
        expect(comparison).to_contain_text("nine soft anal-fin rays")
        for key, count in [("red", 3), ("copper", 3), ("dark", 3), ("black", 2), ("tail", 2)]:
            selector.select_option(key)
            expect(comparison.get_by_role("article")).to_have_count(count)
            self.assertTrue(page.evaluate("document.documentElement.scrollWidth === innerWidth"))
        selector.select_option("dark")
        quillback = comparison.get_by_role("button", name="Enlarge Quillback rockfish photo")
        quillback.click()
        expect(page.get_by_role("dialog")).to_contain_text("EDSClikes2hunt")
        page.get_by_role("button", name="Close photo").click()
        comparison.get_by_text("Identification guides", exact=True).click()
        expect(comparison.get_by_role("link", name="Common Groundfish of Northern California")).to_be_visible()
        self.assertTrue(page.evaluate("document.documentElement.scrollWidth === innerWidth"))
        search = page.get_by_role("searchbox", name="Search fish and shellfish")
        for name in ("black bass", "sunfish", "bluegill", "crappie"):
            search.fill(name)
            expect(page.locator("#rules-cards")).to_contain_text("No matching species")
        search.fill("rockfish")
        expect(rockfish).to_have_count(1)
        rockfish.locator(":scope > summary").click()
        comparison.locator(":scope > summary").click()
        expect(selector).to_be_hidden()
        page.goto(self.url + "#log")
        expect(page.locator("#logentries")).to_contain_text("Black bass")

    def test_approved_handoff_images_decode_and_open_at_iphone_size(self):
        page = self.page
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(self.url + "#rules")
        card = page.locator('.rule-card[data-species="rockfish"]')
        card.locator(":scope > summary").click()

        def check_photo(container, label, credit, license):
            button = container.get_by_role("button", name=f"Enlarge {label} photo", exact=True)
            button.scroll_into_view_if_needed()
            expect(button).to_be_visible()
            self.assertTrue(button.get_by_role("img").evaluate("(img) => img.decode().then(() => img.naturalWidth > 0)"))
            button.click()
            dialog = page.get_by_role("dialog", name=label, exact=True)
            expect(dialog).to_be_visible()
            self.assertTrue(dialog.get_by_role("img").evaluate("(img) => img.decode().then(() => img.naturalWidth > 0)"))
            expect(dialog.get_by_role("link", name=credit)).to_be_visible()
            expect(dialog.get_by_role("link", name=license)).to_be_visible()
            dialog.get_by_role("button", name="Close photo").click()

        table = card.locator(".groundfish-table")
        check_photo(table, "Blue rockfish", "Photo: Konshau Duman", "CC BY 4.0")
        check_photo(table, "Kelp greenling", "Photo: Matt Muir", "CC BY 4.0")
        check_photo(table, "Rock greenling · western Pacific red form", re.compile("Valeria Kovaleva"), "CC BY 4.0")
        check_photo(table, "Bocaccio", "Photo: Dominic Alianelli", "CC0 1.0")
        comparison = card.locator("#rule-comparisons")
        comparison.get_by_text("Compare Species", exact=True).click()
        comparison.get_by_label("Rockfish group").select_option("copper")
        check_photo(comparison, "Gopher rockfish", "Photo: Konshau Duman", "CC BY 4.0")
        self.assertTrue(page.evaluate("document.documentElement.scrollWidth === innerWidth"))

    def test_species_photo_remains_tappable_for_all_season_statuses(self):
        # Exercise rendering with a controlled status matrix. Production rules stay unchanged.
        page = self.page
        page.set_viewport_size({"width": 390, "height": 844})
        page.add_init_script("Date.now = () => Date.parse('2026-11-28T20:00:00Z')")
        data = json.loads((ROOT / "fishing-rules.json").read_text())
        cat = next(row for row in data["species"] if row["id"] == "white-sturgeon")
        asset = cat["image"]
        for status, label in (("open", "Season open"), ("closed", "Closed"), ("retention", "No retention")):
            data["entries"]["white-sturgeon"] = [{
                "regions": ["bay"], "from": "2026-11-28", "through": "2026-11-28",
                "verified": "2026-11-28", "reviewBy": "2026-11-28", "status": status, "rules": {},
            }]
            pattern = "**/fishing-rules.json?*"
            page.route(pattern, lambda route: route.fulfill(json=data))
            page.goto(self.url + f"?photo-test={status}#rules")
            page.get_by_role("button", name="Today", exact=True).click()
            page.get_by_label("Regulatory region").select_option("bay")
            page.get_by_role("searchbox").fill("white sturgeon")
            card = page.locator('.rule-card[data-species="white-sturgeon"]')
            expect(card.locator(".rule-status")).to_have_text(label)
            button = card.get_by_role("button", name="Enlarge White sturgeon photo")
            button.click()
            dialog = page.get_by_role("dialog", name="White sturgeon")
            expect(dialog.get_by_role("img")).to_have_attribute("src", asset.get("full", asset["url"]))
            self.assertTrue(dialog.get_by_role("img").evaluate("(img) => img.decode().then(() => img.naturalWidth > 0)"))
            dialog.get_by_role("button", name="Close photo").click()
            expect(card).not_to_have_attribute("open", "")
            page.unroute(pattern)

    def test_photo_viewer_keeps_regulations_and_loads_detail_on_demand(self):
        page = self.page
        page.goto(self.url + "#rules")
        page.get_by_role("searchbox").fill("white sturgeon")
        card = page.locator('.rule-card[data-species="white-sturgeon"]')
        enlarge = card.get_by_role("button", name="Enlarge White sturgeon photo")
        dialog = page.get_by_role("dialog", name="White sturgeon")
        for width in (320, 1280):
            page.set_viewport_size({"width": width, "height": 780})
            expect(card).not_to_have_attribute("open", "")
            enlarge.click()
            expect(dialog).to_be_visible()
            image = dialog.get_by_role("img")
            self.assertTrue(image.evaluate("(image) => image.decode().then(() => image.naturalWidth > 0)"))
            expect(image).to_have_attribute("src", re.compile("960px"))
            note = dialog.get_by_text("barbels closer to the snout tip", exact=False)
            expect(note).to_be_hidden()
            dialog.get_by_text("Identification tips", exact=True).click()
            expect(note).to_be_visible()
            expect(dialog.get_by_role("link", name="Identification guide")).to_be_visible()
            self.assertTrue(dialog.evaluate("(dialog) => dialog.getBoundingClientRect().right <= innerWidth"))
            dialog.get_by_role("button", name="Close photo").click()
            expect(dialog).to_be_hidden()
            expect(enlarge).to_be_focused()
            expect(card).not_to_have_attribute("open", "")
        page.locator("body").evaluate("(body) => body.classList.add('light')")
        enlarge.click()
        expect(dialog).to_have_css("background-color", "rgb(255, 255, 255)")
        page.keyboard.press("Escape")
        expect(dialog).to_be_hidden()
        page.route(re.compile(r"960px-White_sturgeon_"), lambda route: route.abort())
        page.reload()
        page.get_by_role("searchbox").fill("white sturgeon")
        enlarge.click()
        expect(dialog.get_by_text("Photo unavailable.", exact=True)).to_be_visible()
        expect(dialog.get_by_role("link", name="Photo: Justin Dummit / USFWS")).to_be_visible()

    def test_brannan_island_suggests_delta_without_rewriting_location(self):
        page = self.page
        label = "Brannan Island State Recreation Area, Sacramento County, California"
        page.add_init_script("""(() => {
            const label = """ + json.dumps(label) + """;
            localStorage.setItem('marinecastCustomSpots',JSON.stringify([[label,38.11,-121.70,'']]));
            localStorage.setItem('marinecastLastSpot',JSON.stringify([label,38.11,-121.70]));
        })()""")
        page.goto(self.url)
        option = page.locator("#spot option").filter(has_text=label)
        page.locator("#spot").select_option(value=option.get_attribute("value"))
        expect(page.locator("#pagecontext")).to_have_attribute("title", label)
        expect(page.locator("#pagecontext")).not_to_contain_text("Sacramento County")
        page.get_by_role("link", name="Rules", exact=True).click()
        expect(page.locator("#rules-context")).to_contain_text("Suggested region: Sacramento–San Joaquin Delta")
        page.get_by_label("Regulatory region").select_option("bay")
        expect(page.locator("#rules-context")).to_contain_text("Region mismatch")

    def test_published_wind_cell_support_and_close_zoom_reuse(self):
        self.published_geometry = True
        self.open_map()
        self.set_hour(0)
        result = self.page.evaluate("""() => {
            const shape = MarineMotion.publishedCell({type:'Polygon',coordinates:[[
                [-122.42,37.908],[-122.38,37.908],[-122.4,37.948],[-122.42,37.908]
            ]]}, point => map.project(point,9));
            const field = MarineMotion.cellField([{shape,speed:12,velocity:null}]);
            const center = map.project([37.92,-122.4],9);
            const outside = map.project([37.947,-122.381],9);
            return [field(center.x,center.y),field(outside.x,outside.y),field(center.x,center.y,true)];
        }""")
        self.assertEqual(result, [12,None,None])
        before = len(self.requests)
        self.page.evaluate("map.setView([37.928,-122.4],17,{animate:false})")
        self.page.wait_for_timeout(380)
        self.assertFalse(any(path.startswith(("/points/","/gridpoints/"))
                             for _,path,_ in self.requests[before:]))
        self.page.wait_for_function(self.heat_has_color)
        self.set_hour(1)
        expect(self.page.locator("#marineStatus")).to_contain_text("Readings unavailable")
        expect(self.page.locator(".marine-heat")).to_have_css("visibility", "hidden")
        self.page.wait_for_function("()=>!(" + self.heat_has_color + ")()")

    def test_tap_wind_cell_discloses_missing_fields_and_rejects_unsupported_points(self):
        self.published_geometry = True
        self.open_map()
        self.set_hour(0)
        page = self.page
        page.evaluate("map.fire('click', {latlng: L.latLng(37.928, -122.395)})")
        popup = page.locator(".marine-inspection")
        expect(popup).to_contain_text("NWS modeled grid forecast")
        expect(popup).to_contain_text("Wind 12 MPH from 90°")
        expect(popup).to_contain_text("Gust Unavailable")
        self.set_hour(1)
        expect(popup).to_contain_text("Wind Unavailable")
        expect(popup).to_contain_text("Gust 25 MPH")
        page.evaluate("map.fire('click', {latlng: L.latLng(37.928, -122.35)})")
        expect(popup).to_contain_text("No fresh published grid forecast")
        self.set_hour(0)
        page.evaluate("Date.now = () => performance.timeOrigin + performance.now() + 11 * 60000")
        page.evaluate("map.fire('click', {latlng: L.latLng(37.928, -122.395)})")
        expect(popup).to_contain_text("No fresh published grid forecast")

    def test_close_zoom_renders_supported_static_bearings_without_motion(self):
        page = self.page
        self.open_map()
        page.evaluate("map.setZoom(13,{animate:false})")
        expect(page.locator("#marineRefresh")).to_be_enabled()
        page.wait_for_function("""() => {
            const c = document.querySelector('.marine-bearing');
            return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0);
        }""")
        expect(page.locator(".marine-flow:not(.marine-heat)")).to_have_css("visibility","hidden")
        page.locator("#marineLayer").select_option("Gusts")
        expect(page.locator(".marine-bearing")).to_have_css("visibility","hidden")

    def test_forecast_readouts_align_color_and_keep_independent_midnight_sliders(self):
        self.open_map()
        self.page.evaluate("location.hash='timeline'")
        wind = self.page.locator('#combined .chartwrap[data-dual="true"]')
        slider = wind.locator("input")
        expect(slider).to_have_attribute("max", "1440")
        slider.evaluate("""input => {
            input.value = '0';
            input.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        expect(wind.locator(".chart-selected-time")).to_have_text("12:00 AM PT")
        expect(wind.locator(".chart-reading").nth(0)).to_have_text("Wind12 mph")
        expect(wind.locator(".chart-reading").nth(1)).to_have_text("GustUnavailable")
        expect(wind.locator("strong").first).to_have_css("text-align", "right")
        slider.evaluate("""input => {
            input.value = '1440';
            input.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        expect(wind.locator(".chart-selected-time")).to_have_text("12:00 AM (next day) PT")
        expect(wind.locator("strong").first).to_have_text("12 mph")
        other = self.page.locator("#combined .chartslider").nth(1)
        expect(other).not_to_have_value("1440")
        for theme in ("dark", "light"):
            self.page.evaluate("theme => document.body.classList.toggle('light', theme === 'light')", theme)
            self.assertTrue(wind.evaluate("""chart => {
                const reading = chart.querySelector('.chart-reading');
                const sample = chart.querySelector('circle[fill="var(--chart-primary)"]');
                return getComputedStyle(reading).color === getComputedStyle(sample).fill;
            }"""))

    def test_tile_preview_keeps_failed_zoom_covered(self):
        self.show_tiles = True
        self.open_map()
        expect(self.page.locator(".leaflet-tile-loaded").first).to_be_attached()
        self.failed_tile_zoom = 10
        with self.page.expect_request(re.compile(r"tile.openstreetmap.org/10/")):
            self.page.evaluate("map.setZoom(10, {animate:false})")
        tile = self.page.locator('[data-tile-zoom="10"][data-tile-preview="parent"]').first
        expect(tile).to_be_visible()
        self.page.wait_for_timeout(280)
        expect(tile.locator("canvas")).to_be_visible()
        self.failed_tile_zoom = None
        self.page.evaluate("map.setZoom(11, {animate:false})")
        expect(self.page.locator('[data-tile-zoom="11"].leaflet-tile-loaded').first).to_be_attached()

    def test_cached_pan_reuses_heatmap_raster(self):
        self.page.add_init_script("""(() => {
            window.heatRasters = 0;
            const original = CanvasRenderingContext2D.prototype.putImageData;
            CanvasRenderingContext2D.prototype.putImageData = function(...args) {
                window.heatRasters++;
                return original.apply(this, args);
            };
        })()""")
        self.open_map()
        self.page.wait_for_function(self.heat_has_color)
        count = self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.heatRasters))))")
        self.assertGreater(count, 0)
        self.page.evaluate("map.panBy([18, 0], {animate:false})")
        self.page.wait_for_timeout(350)
        self.assertEqual(self.page.evaluate("window.heatRasters"), count)
        self.assertTrue(self.page.evaluate(self.heat_has_color))

    def test_wind_controls_are_independent_and_do_not_fetch(self):
        self.open_map()
        self.page.emulate_media(reduced_motion="no-preference")
        self.page.locator("#map").scroll_into_view_if_needed()
        self.page.wait_for_function(self.canvas_has_color)
        offset = len(self.requests)
        self.page.locator("#marineHeatToggle").click()
        expect(self.page.locator("#marineHeatToggle")).to_have_attribute("aria-checked", "false")
        self.page.locator("#marineHeatToggle").click()
        expect(self.page.locator("#marineHeatToggle")).to_have_attribute("aria-checked", "true")
        self.page.wait_for_function(self.heat_has_color)
        expect(self.page.locator(".marine-flow:not(.marine-heat)")).to_have_css("visibility", "visible")
        self.page.locator("#marineLabelToggle").click()
        expect(self.page.locator(".marine-wind-pin b").first).to_be_hidden()
        self.page.locator("#marineMotion").click()
        expect(self.page.locator(".marine-flow:not(.marine-heat)")).to_have_css("visibility", "hidden")
        expect(self.page.locator(".marine-heat")).to_have_css("visibility", "visible")
        self.assertFalse(any(path.startswith(("/points/", "/gridpoints/"))
                             for _, path, _ in self.requests[offset:]))

    def test_tiles_start_only_when_map_opens_and_keep_visible_at_zoom_start(self):
        self.show_tiles = True
        self.page.goto(self.url)
        self.assertFalse(any(host == "tile.openstreetmap.org" for host, _, _ in self.requests))
        self.page.evaluate("location.hash='locations'")
        expect(self.page.locator(".leaflet-tile-loaded").first).to_be_attached()
        retained = self.page.evaluate("""() => {
            map.setZoom(10);
            return Boolean(document.querySelector('.leaflet-tile-loaded'));
        }""")
        self.assertTrue(retained)

    def open_mpa(self):
        self.page.goto(self.url + "#mpa")
        expect(self.page.get_by_role("heading", name="Marine Protected Areas")).to_be_visible()
        expect(self.page.locator("#mpaStatus")).to_have_text("155 mapped areas from the CDFW snapshot.")

    def test_mpa_official_polygons_search_legend_and_weather_overlay(self):
        self.open_mpa()
        expect(self.page.locator("#mpaSourceDate")).to_contain_text("Jan 9, 2024")
        expect(self.page.locator(".mpa-legend li")).to_have_count(4)
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
        self.assertGreaterEqual(self.page.locator("#mpaLocate").bounding_box()["height"], 44)
        self.page.wait_for_function("""() => {
            const canvas = document.querySelector('#mpaMap .leaflet-overlay-pane canvas');
            return canvas && canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height)
                .data.some((value,i)=>i%4===3&&value>0);
        }""")
        self.page.get_by_role("button", name="San Francisco Bay", exact=True).click()
        self.page.locator("#mpaQuery").fill("Crown")
        self.page.locator("#mpaSearchButton").click()
        self.page.get_by_role("button", name="Robert W. Crown State Marine Conservation Area").click()
        popup = self.page.locator("#mpaMap .leaflet-popup-content")
        expect(popup).to_contain_text("finfish by hook and line")
        expect(popup.get_by_role("link", name="Official area information")).to_have_attribute(
            "href", re.compile("San-Francisco-Bay"))
        self.assertFalse(any(host == "photon.komoot.io" for host, _, _ in self.requests))
        self.page.get_by_role("navigation", name="Main navigation").get_by_role("link", name="Map", exact=True).click()
        self.page.locator("#weatherMPA").check()
        expect(self.page.locator("#map .leaflet-overlay-pane path[stroke='#bf293b']").first).to_be_attached()
        self.page.locator("#weatherMPA").uncheck()
        expect(self.page.locator("#map .leaflet-overlay-pane path[stroke='#bf293b']")).to_have_count(0)

    def test_mpa_geometry_holes_distance_and_gps_quality(self):
        self.page.goto(self.url)
        result = self.page.evaluate("""() => {
            const closed = pts => [...pts,pts[0]];
            const exterior = closed([[-122.01,37.8],[-122,37.8],[-122,37.81],[-122.01,37.81]]);
            const hole = closed([[-122.007,37.803],[-122.003,37.803],[-122.003,37.807],[-122.007,37.807]]);
            const index = MarineMPA.buildIndex({type:'FeatureCollection',features:[
                {properties:{OBJECTID:1,Type:'SMR',NAME:'Fixture reserve'},geometry:{type:'Polygon',coordinates:[exterior,hole]}}
            ]});
            const point = (x,y,accuracy) => MarineMPA.nearestBoundaries(index,x,y,accuracy).nearby[0];
            const coords = {latitude:37.8,longitude:-122,accuracy:180};
            const now = Date.now();
            return {
                inside:point(-122.005,37.801,5).relation,
                hole:point(-122.005,37.805,5).relation,
                uncertain:point(-122.005,37.7999,20).relation,
                meters:point(-122.005,37.799,5).distance,
                poor:MarineMPA.readFix({coords,timestamp:now},now).reliable,
                stale:MarineMPA.readFix({coords,timestamp:now-31000},now)
            };
        }""")
        self.assertEqual((result["inside"], result["hole"], result["uncertain"]),
                         ("inside", "outside", "uncertain"))
        self.assertAlmostEqual(result["meters"], 111.2, places=1)
        self.assertFalse(result["poor"])
        self.assertIsNone(result["stale"])

    def test_mpa_gps_warns_after_two_inside_fixes_and_stops_in_background(self):
        self.page.add_init_script("""(() => {
            window.gpsCleared = 0;
            Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
                watchPosition(success){window.mpaWatch=success;return 7;},
                clearWatch(){window.gpsCleared++;delete window.mpaWatch;},
                getCurrentPosition(success){success({
                    coords:{latitude:38.02,longitude:-122.928,accuracy:180},timestamp:Date.now()-18000
                });}
            }});
        })()""")
        self.open_mpa()
        self.page.locator("#mpaAlerts").check()
        self.page.locator("#mpaLocate").click()
        expect(self.page.locator("#mpaWarning")).to_contain_text("accuracy is too low")
        expect(self.page.locator("#mpaPosition")).to_contain_text("GPS accuracy")
        expect(self.page.locator("#mpaNearby li")).to_have_count(3)
        expect(self.page.locator("#mpaNearby").first).to_contain_text("to boundary")

        def send(latitude, longitude, accuracy, ago):
            self.page.evaluate("""args => window.mpaWatch({
                coords:{latitude:args[0],longitude:args[1],accuracy:args[2]},
                timestamp:Date.now()-args[3]
            })""", [latitude, longitude, accuracy, ago])

        # The CDFW snapshot contains this verified point in Point Reyes State Marine Reserve.
        send(38.03, -122.915, 10, 15000)
        expect(self.page.locator("#mpaWarning")).to_contain_text("Near a mapped boundary")
        send(38.03, -122.915, 80, 12000)
        expect(self.page.locator("#mpaWarning")).to_contain_text("uncertainty could overlap")
        send(38.02, -123.2, 10, 9000)
        send(38.02, -122.928, 10, 6000)
        expect(self.page.locator("#mpaPosition")).to_contain_text("Point Reyes State Marine Reserve")
        expect(self.page.locator("#mpaWarning")).not_to_contain_text("Possible boundary entry")
        send(38.02, -122.928, 10, 3000)
        expect(self.page.locator("#mpaWarning")).to_contain_text("Possible boundary entry")
        self.page.get_by_role("navigation", name="Main navigation").get_by_role("link", name="Home", exact=True).click()
        expect(self.page.locator("#mpaAppAlert")).to_contain_text("Possible boundary entry")
        self.assertTrue(self.page.evaluate("Boolean(window.mpaWatch)"))
        self.page.evaluate("""() => {
            Object.defineProperty(document,'hidden',{configurable:true,value:true});
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        self.page.wait_for_function("window.gpsCleared > 0 && !window.mpaWatch")
        expect(self.page.locator("#mpaAppAlert")).to_be_hidden()

    def test_mpa_boundaries_and_renderer_open_after_origin_failure(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        self.addCleanup(setattr, self.server, "offline_app", False)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url)
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        self.assertFalse(page.evaluate("""async () => Boolean(
            await caches.match('./mpa-boundaries.geojson?v=28', {cacheName:'marinecast-mpa-v28'}))"""))
        page.evaluate("location.hash = 'mpa'")
        expect(page.locator("#mpaStatus")).to_contain_text("155 mapped areas")
        self.assertTrue(page.evaluate("""async () => Boolean(
            await caches.match('./mpa-boundaries.geojson?v=28', {cacheName:'marinecast-mpa-v28'}))"""))
        self.server.offline_app = True
        self.assertTrue(page.goto(self.url + "offline-check#mpa").ok)
        expect(page.locator("#mpaStatus")).to_contain_text("155 mapped areas")
        expect(page.locator("#mpaMap .leaflet-overlay-pane canvas")).to_be_attached()

    def test_service_worker_caches_versioned_shell(self):
        context = self.browser.new_context(**self.playwright.devices["iPhone 13"])
        self.addCleanup(context.close)
        page = context.new_page()
        page.route("https://**/*", self.mock_provider)
        page.goto(self.url)
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        self.assertTrue(page.evaluate("""async () => {
            const cache = await caches.open('marine-iq-v310');
            return Boolean(await cache.match('./marine-motion.js?v=309')) &&
                Boolean(await cache.match('./marine-tiles.js?v=309')) &&
                Boolean(await cache.match('./marine-rules.js?v=310')) &&
                Boolean(await cache.match('./fishing-rules.json?v=310'));
        }"""))
        page.evaluate("localStorage.setItem('marinecastAppearance', 'light')")
        response = page.goto(self.url + "offline-check")
        self.assertTrue(response.ok)
        self.assertTrue(page.evaluate("Boolean(window.MarineMotion && window.createMarineBasemap)"))
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
        expect(self.page.locator(".marine-flow:not(.marine-heat)")).to_have_css("visibility", "hidden")
        motion.click()
        expect(motion).to_have_attribute("aria-checked", "true")
        self.page.wait_for_function(self.canvas_has_color)
        self.page.evaluate("location.hash = 'tripsetup'")
        expect(self.page.locator("#page-map")).to_be_hidden()
        expect(self.page.locator(".marine-flow:not(.marine-heat)")).to_have_css("visibility", "hidden")

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
