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
        case.page.add_init_script(suite.SLOW_PROVIDER)
        case.open_map()

        def move(expression):
            before = len(case.requests)
            case.page.evaluate("""expression => {
                const container = document.querySelector('#map');
                const refresh = document.querySelector('#marineRefresh');
                const started = performance.now();
                let first = null, settled = null, pending = false;
                function frame(now) {
                    const bounds = container.getBoundingClientRect();
                    const visible = [...container.querySelectorAll('.marine-pin')].some(pin => {
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
            return result

        print(json.dumps({
            "short_pan": move("map.panBy([65, 0], {animate: false})"),
            "return_pan": move("map.panBy([-65, 0], {animate: false})"),
            "new_area": move("map.panTo([36.5, -122.1], {animate: false})"),
        }, indent=2))
    finally:
        case.doCleanups()
        case.doClassCleanups()


if __name__ == "__main__":
    run()
