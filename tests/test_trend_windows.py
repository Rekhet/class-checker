from __future__ import annotations

from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
INDEX = WEB_ROOT / "data" / "classes" / "index.json"
TERM = "2026|U000200002U000300001"


def _day_label(epoch: int) -> str:
    """The UI's M/D label, always in KST whatever the test machine's zone."""
    d = datetime.fromtimestamp(epoch, ZoneInfo("Asia/Seoul"))
    return f"{d.month}/{d.day}"


class TrendWindowNavTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        entry = next(t for t in json.loads(INDEX.read_text())["terms"]
                     if f"{t['year']}|{t['term']}" == TERM)
        cls.archives = entry["trendArchives"]
        live = WEB_ROOT / "data" / "trend" / entry["trend"]
        cls.live = json.loads(live.read_text())
        prev = live.with_name(live.stem + f"_w{cls.archives - 1:03d}.json")
        cls.prev = json.loads(prev.read_text())

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def _open_trend(self, page):
        page.goto(self.base_url + "/index.html#trend",
                  wait_until="domcontentloaded")
        page.select_option("#trendTerm", TERM)
        page.wait_for_function(
            "() => !document.querySelector('#trendClass').disabled",
            timeout=15000,
        )

    def _run(self, fn) -> None:
        page_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(timezone_id="America/New_York")
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
            # KST dates even though the browser runs in New York
            self.assertIn(_day_label(self.live["t"][0]), label)
            self.assertFalse(page.is_disabled("#trendPrev"))
            self.assertTrue(page.is_disabled("#trendNext"))  # already at live

        self._run(steps)

    def test_prev_loads_the_window_just_before_live_without_overlap(self) -> None:
        # the live file starts where the previous page ends
        self.assertEqual(self.prev["t"][-1] < self.live["t"][0], True)

        def steps(page):
            self._open_trend(page)
            page.click("#trendPrev")
            page.wait_for_function(
                "d => document.querySelector('#trendWinLabel').textContent.includes(d)",
                arg=f"구간 {self.archives}/{self.archives + 1}", timeout=20000,
            )
            self.assertIn(_day_label(self.prev["t"][0]),
                          page.text_content("#trendWinLabel"))
            self.assertFalse(page.is_disabled("#trendNext"))
            page.click("#trendNext")
            page.wait_for_function(
                "() => document.querySelector('#trendWinLabel').textContent.includes('최신')",
                timeout=20000,
            )

        self._run(steps)

    def test_window_cache_stays_bounded(self) -> None:
        def steps(page):
            self._open_trend(page)
            for _ in range(min(6, self.archives)):
                before = page.text_content("#trendWinLabel")
                page.click("#trendPrev")
                page.wait_for_function(
                    "b => document.querySelector('#trendWinLabel').textContent !== b"
                    " && !document.querySelector('#trendWinLabel').textContent.includes('불러오는')",
                    arg=before, timeout=20000,
                )
            size = page.evaluate("() => _trend.winCache.size")
            self.assertLessEqual(size, 4)

        self._run(steps)


if __name__ == "__main__":
    unittest.main()
