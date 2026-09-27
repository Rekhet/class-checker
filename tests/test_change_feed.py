from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
TREND_DIR = WEB_ROOT / "data" / "trend"
YEAR, TERM = "2026", "U000200002U000300001"
LIVE = TREND_DIR / f"trend_{YEAR}_{TERM}.json"


def _decode(enc, n):
    if enc is None or isinstance(enc, int):
        return [enc] * n
    out = [None] * n
    for k in range(0, len(enc), 2):
        end = enc[k + 2] if k + 2 < len(enc) else n
        out[enc[k]:end] = [enc[k + 1]] * (end - enc[k])
    return out


def _windows_for(hours: int) -> list[dict]:
    """Live window plus the archive windows (newest first) needed to reach back
    `hours` (0 = the whole semester), oldest first."""
    index = json.loads((WEB_ROOT / "data" / "classes" / "index.json").read_text())
    entry = next(t for t in index["terms"] if t["year"] == YEAR and t["term"] == TERM)
    live = json.loads(LIVE.read_text())
    since = live["t"][-1] - hours * 3600 if hours > 0 else float("-inf")
    wins = [live]
    i = entry["trendArchives"] - 1
    while i >= 0 and wins[0]["t"][0] > since:
        path = TREND_DIR / f"trend_{YEAR}_{TERM}_w{i:03d}.json"
        wins.insert(0, json.loads(path.read_text()))
        i -= 1
    return wins


def _dense(wins: list[dict]) -> tuple[list[int], dict]:
    """Concatenate windows into dense per-class arrays. A window that did not
    collect a metric repeats the previous value; a class missing from a window
    that did is None there."""
    t = [x for w in wins for x in w["t"]]
    keys = {k for w in wins for k in w["series"]}
    out = {}
    for key in keys:
        cls = {}
        for m in "aeq":
            values, prev = [], None
            for w in wins:
                n = len(w["t"])
                if m != "q" and m not in w["m"]:
                    values += [prev] * n
                    continue
                vals = _decode(w["series"].get(key, {}).get(m), n)
                values += vals
                prev = vals[-1]
            cls[m] = values
        out[key] = cls
    return t, out


def expected_feed(hours: int, mode: str) -> set[str]:
    """Independent reading of the feed rule over fully decoded series."""
    t, series = _dense(_windows_for(hours))
    n, last = len(t), len(t) - 1
    base = 0
    if hours > 0:
        since = t[last] - hours * 3600
        base = max([i for i in range(n) if t[i] <= since] or [0])
    keys = set()
    for key, s in series.items():
        a, q, e = s["a"], s["q"], s["e"]
        if all(v[i] == v[base] for v in (a, q, e) for i in range(base, n)):
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

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def _run(self, fn) -> None:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(self.base, wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => typeof _trend !== 'undefined' && !!_trend.live", timeout=20000)
                fn(page)
            finally:
                browser.close()
        self.assertEqual(errors, [])

    def test_feed_matches_an_independent_computation(self) -> None:
        def steps(page):
            self.assertTrue(page.is_visible("#trendFeed"))
            # 3 h and 24 h stay inside the live window; 7 days and the whole
            # semester join archive windows
            for hours in (3, 24, 168, 0):
                for mode in ("open", "all"):
                    got = set(page.evaluate(
                        "async ([h, m]) => trendFeed(await feedData(h), h, m).map((x) => x.key)",
                        [hours, mode]))
                    with self.subTest(hours=hours, mode=mode):
                        self.assertEqual(got, expected_feed(hours, mode))

        self._run(steps)

    def test_more_pages_and_older_periods_render(self) -> None:
        def steps(page):
            rows = "#trendFeedList li:not(.tf-empty)"
            page.select_option("#trendFeedMode", "all")
            page.select_option("#trendFeedHours", "0")
            page.wait_for_function(
                "() => /개 강좌 ·/.test(document.querySelector('#trendFeedMeta').textContent)",
                timeout=30000)
            total = int(page.text_content("#trendFeedMeta").split("개 강좌")[0].replace(",", ""))
            self.assertGreater(total, 100)
            self.assertEqual(page.locator(rows).count(), 50)
            page.click("#trendFeedMore")
            page.wait_for_function(f"() => document.querySelectorAll('{rows}').length === 100")
            # rows are not duplicated when a page is appended
            names = page.eval_on_selector_all(rows, "ls => ls.map((l) => l.textContent)")
            self.assertEqual(len(names), len(set(names)))
            # a new period starts from one page again, and a row opens its chart
            page.select_option("#trendFeedHours", "168")
            page.wait_for_function(
                f"() => document.querySelectorAll('{rows}').length <= 50"
                " && /개 강좌 ·/.test(document.querySelector('#trendFeedMeta').textContent)",
                timeout=30000)
            page.locator("#trendFeedList .tf-name").first.click()
            page.wait_for_function("() => !!_trend.key", timeout=10000)

        self._run(steps)


if __name__ == "__main__":
    unittest.main()


class FeedRetryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html#trend"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_a_dropped_archive_request_is_retried(self) -> None:
        failed = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()

                def flaky(route):
                    if route.request.url.endswith("_w003.json") and not failed:
                        failed.append(route.request.url)
                        route.abort("failed")          # the first attempt drops
                    else:
                        route.continue_()
                page.route("**/data/trend/*_w0*.json", flaky)
                page.goto(self.base, wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => typeof _trend !== 'undefined' && !!_trend.live", timeout=20000)
                passes = page.evaluate("async () => (await feedData(0)).t.length")
            finally:
                browser.close()
        self.assertEqual(len(failed), 1)
        self.assertGreater(passes, 4000)
