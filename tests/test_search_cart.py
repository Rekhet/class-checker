from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
TERM_DATA = WEB_ROOT / "data" / "classes" / "2026_U000200002U000300001.json"


class SearchCartDisplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def test_regular_search_result_shows_current_cart_count(self) -> None:
        rows = json.loads(TERM_DATA.read_text(encoding="utf-8"))
        target = next(row for row in rows if row.get("cart") is not None)
        page_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.goto(self.base_url + "/index.html", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.querySelector('#term')?.options.length > 1",
                    timeout=10000,
                )
                page.select_option("#year", "2026")
                page.select_option("#term", "U000200002U000300001")
                page.fill("#name", target["name"])
                page.click("#searchForm button[type=submit]")
                expected = f"장바구니 {target['cart']}"
                page.wait_for_function(
                    "expected => [...document.querySelectorAll('#results .rmeta')]"
                    ".some((node) => node.textContent.includes(expected))",
                    arg=expected,
                    timeout=10000,
                )

                result_text = page.locator("#results .rmeta").all_text_contents()
                self.assertTrue(any(expected in text for text in result_text))
                self.assertFalse(page_errors, page_errors)
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
