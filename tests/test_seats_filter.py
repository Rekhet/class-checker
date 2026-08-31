from __future__ import annotations

from collections import defaultdict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
TERM_DATA = WEB_ROOT / "data" / "classes" / "2026_U000200002U000300001.json"
YEAR = "2026"
TERM = "U000200002U000300001"


def _pick_targets():
    """One course name whose every section has seats left, and one whose
    every section is full (quota - applied <= 0). Grouped by name because
    the search box matches by name and other sections would muddy assertions."""
    rows = json.loads(TERM_DATA.read_text(encoding="utf-8"))
    by_name = defaultdict(list)
    for row in rows:
        by_name[row["name"]].append(row)
    seated = full = None
    for name, sections in by_name.items():
        counted = all(
            s.get("quota") is not None and s.get("applied") is not None
            for s in sections
        )
        if not counted:
            continue
        if seated is None and all(s["quota"] - s["applied"] > 0 for s in sections):
            seated = name
        if full is None and all(s["quota"] - s["applied"] <= 0 for s in sections):
            full = name
        if seated and full:
            return seated, full
    raise AssertionError("term data lacks a fully-seated or fully-full course")


class SeatsFilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.seated_name, cls.full_name = _pick_targets()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def _search(self, page, name: str, seats_only: bool) -> list[str]:
        """Run a search on the loaded page; return the result-card names."""
        page.wait_for_function(
            "() => document.querySelector('#term')?.options.length > 1",
            timeout=10000,
        )
        page.select_option("#year", YEAR)
        page.select_option("#term", TERM)
        page.fill("#name", name)
        if not page.evaluate(
            "() => document.querySelector('#advFilters').classList.contains('open')"
        ):
            page.click("#filterToggle")  # checkbox sits in the collapsed panel
        page.set_checked("#seatsOnly", seats_only)
        page.evaluate("() => { document.querySelector('#resultCount').textContent = ''; }")
        page.click("#searchForm button[type=submit]")
        page.wait_for_function(
            "() => document.querySelector('#resultCount').textContent.includes('검색됨')",
            timeout=10000,
        )
        return page.eval_on_selector_all(
            "#results .rname",
            "nodes => nodes.map(n => n.childNodes[0].textContent)",
        )

    def _run(self, fn) -> None:
        page_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.goto(self.base_url + "/index.html", wait_until="domcontentloaded")
                fn(page)
            finally:
                browser.close()
        self.assertEqual(page_errors, [], f"page errors: {page_errors}")

    def test_seated_class_shown_when_seats_filter_on(self) -> None:
        def steps(page):
            names = self._search(page, self.seated_name, seats_only=True)
            self.assertIn(self.seated_name, names)

        self._run(steps)

    def test_full_class_hidden_when_seats_filter_on(self) -> None:
        def steps(page):
            names = self._search(page, self.full_name, seats_only=False)
            self.assertIn(self.full_name, names)  # sanity: visible unfiltered
            names = self._search(page, self.full_name, seats_only=True)
            self.assertNotIn(self.full_name, names)

        self._run(steps)

    def test_rows_without_seat_counts_excluded(self) -> None:
        def steps(page):
            page.wait_for_function("() => typeof matchRow === 'function'")
            rejected = page.evaluate(
                "() => !matchRow({quota: null, applied: null}, {seatsOnly: true})"
            )
            self.assertTrue(rejected, "null quota/applied row must not pass seatsOnly")

        self._run(steps)


if __name__ == "__main__":
    unittest.main()
