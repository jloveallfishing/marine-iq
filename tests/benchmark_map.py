"""Measure map overlays at an iPhone 13 viewport with 180 ms per NWS request."""

import json
import os
from pathlib import Path

import test_marinecast as suite


def run():
    if baseline := os.environ.get("MARINECAST_BENCH_ROOT"):
        suite.ROOT = Path(baseline)
    case = suite.MarineCastTests()
    case.setUpClass()
    try:
        case.setUp()
        case.show_tiles = True
        case.page.add_init_script(suite.SLOW_PROVIDER)
        case.page.add_init_script("""(() => {
            window.rasterWrites = 0;
            window.datePartsCalls = 0;
            const format = Intl.DateTimeFormat.prototype.formatToParts;
            Intl.DateTimeFormat.prototype.formatToParts = function(...args) {
                window.datePartsCalls++;
                return format.apply(this, args);
            };
            const original = CanvasRenderingContext2D.prototype.putImageData;
            CanvasRenderingContext2D.prototype.putImageData = function(...args) {
                window.rasterWrites++;
                return original.apply(this, args);
            };
        })()""")
        case.page.goto(case.url)
        case.page.wait_for_timeout(200)
        before_map = sum(host == 'tile.openstreetmap.org' for host, _, _ in case.requests)
        case.open_map()

        def move(expression):
            before = len(case.requests)
            format_calls = case.page.evaluate("window.datePartsCalls")
            case.page.evaluate("""expression => {
                const container = document.querySelector('#map');
                const refresh = document.querySelector('#marineRefresh');
                const started = performance.now();
                let first = null, settled = null, pending = false;
                function frame(now) {
                    const bounds = container.getBoundingClientRect();
                    const visible = [...container.querySelectorAll('.marine-pin')].some(pin => {
                        if (getComputedStyle(pin).visibility === 'hidden') return false;
                        const box = pin.getBoundingClientRect();
                        return box.right > bounds.left && box.left < bounds.right &&
                               box.bottom > bounds.top && box.top < bounds.bottom;
                    });
                    if (visible && first === null) first = Math.round(now - started);
                    if (refresh.disabled) pending = true;
                    if (pending && !refresh.disabled && settled === null) settled = Math.round(now - started);
                }
                (0, eval)(expression);
                frame(performance.now());
                window.mapBenchmark = new Promise(resolve => {
                    function poll(now) {
                        frame(now);
                        if (first !== null && (settled !== null || (!pending && now - started > 375))) {
                            resolve({first_visible_ms: first, request_cycle_ms: settled});
                        } else if (now - started > 20000) {
                            resolve({first_visible_ms: first, request_cycle_ms: settled});
                        } else requestAnimationFrame(poll);
                    }
                    requestAnimationFrame(poll);
                });
            }""", expression)
            result = case.page.evaluate("window.mapBenchmark")
            result["provider_requests"] = sum(
                path.startswith(('/points/', '/gridpoints/')) for _, path, _ in case.requests[before:]
            )
            result["date_format_calls"] = case.page.evaluate("window.datePartsCalls") - format_calls
            return result

        results = {
            "tile_requests_before_opening_map": before_map,
            "short_pan": move("map.panBy([65, 0], {animate: false})"),
            "return_pan": move("map.panBy([-65, 0], {animate: false})"),
            "new_area": move("map.panTo([36.5, -122.1], {animate: false})"),
            "close_zoom": move("map.setZoom(14, {animate: false})"),
        }
        case.page.evaluate("map.setView([38, -122.1], 9, {animate:false})")
        case.page.locator(".leaflet-tile-loaded").first.wait_for(state="attached")
        case.page.wait_for_timeout(320)
        case.failed_tile_zoom = 10
        case.page.evaluate("map.setZoom(10, {animate:false})")
        case.page.wait_for_timeout(650)
        results["basemap_coverage_after_failed_zoom_percent"] = case.page.evaluate("""() => {
            const viewport = document.querySelector('#map').getBoundingClientRect();
            const tiles = [...document.querySelectorAll('.leaflet-tile-loaded, [data-tile-preview]')]
                .filter(tile => getComputedStyle(tile).visibility === 'visible' && +getComputedStyle(tile).opacity > 0)
                .map(tile => tile.getBoundingClientRect());
            let covered = 0;
            for(let y=0;y<8;y++)for(let x=0;x<8;x++){
                const px=viewport.left+(x+.5)*viewport.width/8,py=viewport.top+(y+.5)*viewport.height/8;
                if(tiles.some(tile=>px>=tile.left&&px<tile.right&&py>=tile.top&&py<tile.bottom))covered++;
            }
            return Math.round(covered*100/64);
        }""")
        case.failed_tile_zoom = None
        case.page.evaluate("map.setView([38, -122.1], 9, {animate:false})")
        case.page.wait_for_timeout(300)
        case.page.locator("#marineRefresh").wait_for(state="attached")
        case.page.wait_for_function("!document.querySelector('#marineRefresh').disabled")
        case.page.locator("#marineLayer").select_option("Wind heatmap")
        case.page.wait_for_function("window.rasterWrites > 0")
        raster_writes = case.page.evaluate("window.rasterWrites")
        case.page.evaluate("map.panBy([18, 0], {animate:false})")
        case.page.wait_for_timeout(400)
        results["heatmap_raster_rebuilds_on_cached_pan"] = case.page.evaluate("window.rasterWrites") - raster_writes
        print(json.dumps(results, indent=2))
    finally:
        case.doCleanups()
        case.doClassCleanups()


if __name__ == "__main__":
    run()
