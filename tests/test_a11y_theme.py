from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from playwright.sync_api import sync_playwright

from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parents[1]


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class KeyboardAndThemeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def _run(self, fn, **ctx) -> None:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(**ctx)
                page.on("pageerror", lambda e: errors.append(str(e)))
                fn(page)
            finally:
                browser.close()
        self.assertEqual(errors, [])

    def test_result_card_opens_and_closes_by_keyboard(self) -> None:
        def steps(page):
            page.goto(self.base, wait_until="domcontentloaded")
            page.wait_for_function("() => document.querySelector('#year')?.options.length > 1")
            page.fill("#name", "통계")
            page.press("#name", "Enter")
            page.wait_for_selector("#results .rcard")
            card = page.locator("#results .rcard").first
            self.assertEqual(card.get_attribute("role"), "button")
            self.assertTrue(card.get_attribute("aria-label"))
            card.focus()
            page.keyboard.press("Enter")
            page.wait_for_selector("#detailDrawer:not(.hidden)")
            self.assertEqual(page.get_attribute("#detailDrawer", "role"), "dialog")
            self.assertEqual(page.evaluate("() => document.activeElement.className"), "d-close")
            page.keyboard.press("Escape")
            page.wait_for_selector("#detailDrawer", state="hidden")
            self.assertTrue(page.evaluate(
                "() => document.activeElement.classList.contains('rcard')"))

        self._run(steps)

    def test_filter_chips_toggle_by_keyboard(self) -> None:
        def steps(page):
            page.goto(self.base, wait_until="domcontentloaded")
            page.wait_for_selector("#typeChips .chip-tog")
            page.click("#filterToggle")
            chip = page.locator("#typeChips .chip-tog").first
            chip.focus()
            page.keyboard.press(" ")
            self.assertEqual(chip.get_attribute("aria-pressed"), "true")
            self.assertIn("on", chip.get_attribute("class"))

        self._run(steps)

    def test_theme_toggle_cycles_and_persists(self) -> None:
        def steps(page):
            page.goto(self.base, wait_until="domcontentloaded")
            page.wait_for_selector("#themeToggle")
            bg = lambda: page.evaluate("() => getComputedStyle(document.body).backgroundColor")
            system_dark = bg()
            page.click("#themeToggle")                      # system -> light
            self.assertEqual(page.evaluate("() => document.documentElement.dataset.theme"), "light")
            light = bg()
            self.assertNotEqual(light, system_dark)
            page.click("#themeToggle")                      # light -> dark
            self.assertEqual(bg(), system_dark)
            page.reload(wait_until="domcontentloaded")
            # applied before app.js runs (inline script in index.html)
            self.assertEqual(page.evaluate("() => document.documentElement.dataset.theme"), "dark")
            page.wait_for_selector("#themeToggle")
            page.click("#themeToggle")                      # dark -> system
            self.assertIsNone(page.evaluate("() => localStorage.getItem('snu_theme')"))

        self._run(steps, color_scheme="dark")


if __name__ == "__main__":
    unittest.main()
