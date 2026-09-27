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


def _decode(enc, n):
    if enc is None or isinstance(enc, int):
        return [enc] * n
    out = [None] * n
    for k in range(0, len(enc), 2):
        end = enc[k + 2] if k + 2 < len(enc) else n
        out[enc[k]:end] = [enc[k + 1]] * (end - enc[k])
    return out


def expected_feed(data: dict, hours: int, mode: str) -> set[str]:
    """Independent reading of the feed rule over fully decoded series."""
    t = data["t"]
    n, last = len(t), len(t) - 1
    base = 0
    if hours > 0:
        since = t[last] - hours * 3600
        base = max([i for i in range(n) if t[i] <= since] or [0])
    keys = set()
    for key, enc in data["series"].items():
        a, q, e = (_decode(enc.get(m), n) for m in "aqe")
        if all(s[i] == s[base] for s in (a, q, e) for i in range(base, n)):
            continue                                   # nothing moved after base
        s0 = q[base] - a[base] if None not in (q[base], a[base]) else None
        s1 = q[last] - a[last] if None not in (q[last], a[last]) else None
        if mode == "open" and not (s1 is not None and s1 > 0 and (s0 is None or s1 > s0)):
            continue
        keys.add(key)
    return keys


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class ChangeFeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html#trend"
        cls.data = json.loads(LIVE.read_text())

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_feed_matches_an_independent_computation(self) -> None:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(self.base, wait_until="domcontentloaded")
                page.wait_for_function("() => typeof _trend !== 'undefined' && !!_trend.live", timeout=20000)
                self.assertTrue(page.is_visible("#trendFeed"))
                for hours in (3, 24, 0):
                    for mode in ("open", "all"):
                        got = set(page.evaluate(
                            "([h, m]) => trendFeed(_trend.live, h, m).map((x) => x.key)",
                            [hours, mode]))
                        with self.subTest(hours=hours, mode=mode):
                            self.assertEqual(got, expected_feed(self.data, hours, mode))
                # the list renders and a row opens that class's chart
                page.select_option("#trendFeedMode", "all")
                page.select_option("#trendFeedHours", "0")
                first = page.locator("#trendFeedList .tf-name").first
                first.click()
                page.wait_for_function("() => typeof _trend !== 'undefined' && !!_trend.key", timeout=10000)
            finally:
                browser.close()
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
