from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from urllib.parse import quote, unquote

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
YEAR, TERM = "2026", "U000200002U000300001"


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class ShareLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html"
        rows = json.loads((WEB_ROOT / "data" / "classes" / f"{YEAR}_{TERM}.json").read_text())
        trend = json.loads((WEB_ROOT / "data" / "trend" / f"trend_{YEAR}_{TERM}.json").read_text())
        cls.row = next(r for r in rows if f"{r['sbjt_cd']}({r['lt_no']})" in trend["series"])
        cls.key = f"{cls.row['sbjt_cd']}({cls.row['lt_no']})"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def _run(self, fn) -> None:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                fn(page)
            finally:
                browser.close()
        self.assertEqual(errors, [])

    def _hash(self, route: str) -> str:
        return f"#{route}/{quote(YEAR + '|' + TERM, safe='')}/{quote(self.key, safe='')}"

    def test_search_link_round_trips_filters_and_results(self) -> None:
        def steps(page):
            page.goto(self.base, wait_until="domcontentloaded")
            page.wait_for_function("() => document.querySelector('#year')?.options.length > 1")
            page.fill("#name", "통계")
            page.evaluate("() => { document.querySelector('#seatsOnly').checked = true; }")
            page.click("#searchForm button[type=submit]")
            page.wait_for_function("() => /건 검색됨/.test(document.querySelector('#resultCount')?.textContent)")
            count = page.text_content("#resultCount")
            self.assertTrue(page.is_visible("#shareSearch"))
            link = page.evaluate("() => searchHash(lastFilters)")
            self.assertIn("seat=1", link)

            page.goto("about:blank")
            page.goto(self.base + link, wait_until="domcontentloaded")
            page.wait_for_function("() => /건 검색됨/.test(document.querySelector('#resultCount')?.textContent)")
            self.assertEqual(page.text_content("#resultCount"), count)
            self.assertEqual(page.input_value("#name"), "통계")
            self.assertTrue(page.is_checked("#seatsOnly"))

        self._run(steps)

    def test_class_link_opens_the_detail_drawer(self) -> None:
        def steps(page):
            page.goto(self.base + self._hash("class"), wait_until="domcontentloaded")
            page.wait_for_selector("#detailDrawer:not(.hidden) h3", timeout=15000)
            self.assertEqual(page.text_content("#detailDrawer h3"), self.row["name"])
            # the drawer links to the class's trend chart
            page.click("#detailDrawer a.d-link")
            page.wait_for_function(
                "k => (document.querySelector('#trendTitle')?.textContent || '').length > 0"
                " && typeof _trend !== 'undefined' && _trend.key === k", arg=self.key, timeout=20000)
            self.assertTrue(page.is_hidden("#detailDrawer"))

        self._run(steps)

    def test_trend_link_draws_the_chart_and_keeps_the_url(self) -> None:
        def steps(page):
            page.goto(self.base + self._hash("trend"), wait_until="domcontentloaded")
            page.wait_for_function("k => typeof _trend !== 'undefined' && _trend.key === k", arg=self.key, timeout=20000)
            page.wait_for_selector("#trendChart svg", state="attached")
            self.assertIn(self.key, unquote(page.evaluate("() => location.hash")))
            self.assertTrue(page.is_visible("#trendShare"))

        self._run(steps)


if __name__ == "__main__":
    unittest.main()


class HomeLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.root = f"http://127.0.0.1:{cls.server.server_port}/"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_title_returns_to_the_site_root(self) -> None:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.goto(self.root + "index.html#trend", wait_until="domcontentloaded")
                page.wait_for_selector(".home-link")
                page.click(".home-link")
                page.wait_for_url(self.root)
                page.wait_for_function(
                    "() => document.querySelector('.page.active')?.dataset.page === 'timetable'")
                self.assertEqual(page.evaluate("() => location.hash"), "")
            finally:
                browser.close()
