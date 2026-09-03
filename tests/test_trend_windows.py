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
W001 = WEB_ROOT / "data" / "trend" / "trend_2026_U000200002U000300001_w001.json"


class TrendWindowNavTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.live_first_ts = json.loads(LIVE.read_text())["ts"][0]
        cls.w001_first_ts = json.loads(W001.read_text())["ts"][0]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def _open_trend(self, page):
        page.goto(self.base_url + "/index.html#trend",
                  wait_until="domcontentloaded")
        page.select_option("#trendTerm", "2026|U000200002U000300001")
        page.wait_for_function(
            "() => !document.querySelector('#trendClass').disabled",
            timeout=15000,
        )

    def _run(self, fn) -> None:
        page_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                fn(page)
            finally:
                browser.close()
        self.assertEqual(page_errors, [], f"page errors: {page_errors}")

    def test_window_nav_visible_with_archives(self) -> None:
        def steps(page):
            self._open_trend(page)
            label = page.text_content("#trendWinLabel")
            self.assertIn("최신", label)
            self.assertFalse(page.is_disabled("#trendPrev"))
            self.assertTrue(page.is_disabled("#trendNext"))  # already at live

        self._run(steps)

    def test_prev_loads_archived_window(self) -> None:
        def steps(page):
            self._open_trend(page)
            page.click("#trendPrev")
            page.wait_for_function(
                "d => document.querySelector('#trendWinLabel').textContent.includes(d)",
                arg=self.w001_first_ts[5:10].replace("-", "/"), timeout=20000,
            )
            self.assertFalse(page.is_disabled("#trendNext"))
            # back to live
            page.click("#trendNext")
            page.wait_for_function(
                "() => document.querySelector('#trendWinLabel').textContent.includes('최신')",
                timeout=20000,
            )

        self._run(steps)


if __name__ == "__main__":
    unittest.main()
