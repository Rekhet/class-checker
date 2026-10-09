from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]

ROWS = """() => [...document.querySelectorAll('#gradMajorList .gm-row')].map((r) => {
  const q = (s) => r.querySelector(s).getBoundingClientRect();
  const rr = r.getBoundingClientRect();
  const kids = ['.gm-head', '.gm-major', '.gm-year'].map(q);
  return {stack: r.classList.contains('gm-stack'), right: rr.right,
          tops: kids.map((k) => k.top), rights: kids.map((k) => k.right)};
})"""


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class GradLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html#grad"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def _run(self, width, steps) -> None:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": width, "height": 800})
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(self.base, wait_until="domcontentloaded")
                page.wait_for_selector("#gradMajorList .gm-row", timeout=20000)
                page.wait_for_timeout(300)
                steps(page)
            finally:
                browser.close()
        self.assertEqual(errors, [])

    def assertOneLine(self, r) -> None:
        self.assertFalse(r["stack"])
        self.assertLessEqual(max(r["tops"]) - min(r["tops"]), 4, r)

    def assertStacked(self, r) -> None:
        self.assertTrue(r["stack"])
        t = r["tops"]
        self.assertTrue(t[0] < t[1] < t[2], r)
        for x in r["rights"]:
            self.assertLessEqual(x, r["right"] + 1, r)

    def test_desktop_rows_stay_on_one_line(self) -> None:
        def steps(page):
            rows = page.evaluate(ROWS)
            self.assertTrue(rows)
            for r in rows:
                self.assertOneLine(r)
        self._run(1280, steps)

    def test_narrow_rows_stack_without_page_overflow(self) -> None:
        def steps(page):
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 320)
            rows = page.evaluate(ROWS)
            self.assertTrue(rows)
            for r in rows:
                if r["stack"]:
                    self.assertStacked(r)
                else:
                    self.assertOneLine(r)
        self._run(320, steps)

    def test_stack_follows_the_width_both_ways(self) -> None:
        def steps(page):
            self.assertTrue(any(r["stack"] for r in page.evaluate(ROWS)))
            page.set_viewport_size({"width": 1280, "height": 800})
            page.wait_for_timeout(500)
            for r in page.evaluate(ROWS):
                self.assertOneLine(r)
            page.set_viewport_size({"width": 320, "height": 800})
            page.wait_for_timeout(500)
            self.assertTrue(any(r["stack"] for r in page.evaluate(ROWS)))
        self._run(320, steps)


if __name__ == "__main__":
    unittest.main()
