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
    """A course name whose every section carries the 취소여석 badge, and one
    whose every section has the flag collected but off."""
    rows = json.loads(TERM_DATA.read_text(encoding="utf-8"))
    by_name = defaultdict(list)
    for row in rows:
        by_name[row["name"]].append(row)
    with_badge = without_badge = None
    for name, sections in by_name.items():
        flags = [s.get("cancel_vacancy") for s in sections]
        if any(f is None for f in flags):
            continue
        if with_badge is None and all(f == 1 for f in flags):
            with_badge = name
        if without_badge is None and all(f == 0 for f in flags):
            without_badge = name
        if with_badge and without_badge:
            return with_badge, without_badge
    raise AssertionError("term data lacks badge/no-badge courses; re-export?")


class CancelVacancyFilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.badge_name, cls.plain_name = _pick_targets()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def _search(self, page, name: str, cancel_only: bool) -> list[str]:
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
            page.click("#filterToggle")
        page.set_checked("#cancelOnly", cancel_only)
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

    def test_badged_class_shown_when_filter_on(self) -> None:
        def steps(page):
            names = self._search(page, self.badge_name, cancel_only=True)
            self.assertIn(self.badge_name, names)

        self._run(steps)

    def test_unbadged_class_hidden_when_filter_on(self) -> None:
        def steps(page):
            names = self._search(page, self.plain_name, cancel_only=False)
            self.assertIn(self.plain_name, names)  # sanity: visible unfiltered
            names = self._search(page, self.plain_name, cancel_only=True)
            self.assertNotIn(self.plain_name, names)

        self._run(steps)

    def test_result_card_shows_cancel_vacancy_tag(self) -> None:
        def steps(page):
            self._search(page, self.badge_name, cancel_only=True)
            tags = page.eval_on_selector_all(
                "#results .rtag.cancel", "nodes => nodes.map(n => n.textContent)"
            )
            self.assertIn("취소여석", tags)

        self._run(steps)


if __name__ == "__main__":
    unittest.main()
