from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
LIVE = WEB_ROOT / "data" / "trend" / "trend_2026_U000200002U000300001.json"


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class MobileLayoutTests(unittest.TestCase):
    """Phone viewport (iPhone 13): no page scrolls sideways, and the trend
    chart's axis text stays readable."""

    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html"
        cls.key = next(iter(json.loads(LIVE.read_text())["series"]))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_pages_fit_the_width_and_chart_text_is_readable(self) -> None:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for scheme in ("light", "dark"):
                    ctx = browser.new_context(**playwright.devices["iPhone 13"],
                                              color_scheme=scheme)
                    page = ctx.new_page()
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    for route in ("", "#explore", "#grad", "#trend"):
                        page.goto(self.base + route, wait_until="networkidle")
                        overflow = page.evaluate(
                            "() => document.documentElement.scrollWidth - window.innerWidth")
                        with self.subTest(scheme=scheme, route=route or "#timetable"):
                            self.assertLessEqual(overflow, 0)
                    from urllib.parse import quote
                    page.goto(self.base + "#trend/" + quote("2026|U000200002U000300001", safe="")
                              + "/" + quote(self.key, safe=""), wait_until="networkidle")
                    page.wait_for_selector("#trendChart svg text", state="attached")
                    px = page.evaluate("""() => {
                      const t = document.querySelector('#trendChart svg text');
                      return t.getBoundingClientRect().height; }""")
                    self.assertGreaterEqual(px, 9, "axis labels scaled below 9 px")
                    page.locator("#trendChart svg rect").tap(position={"x": 100, "y": 60})
                    page.wait_for_selector("#trendTip:not(.hidden)")
                    ctx.close()
            finally:
                browser.close()
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
