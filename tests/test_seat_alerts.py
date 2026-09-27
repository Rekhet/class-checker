from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from urllib.parse import quote

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
YEAR, TERM = "2026", "U000200002U000300001"
LIVE = WEB_ROOT / "data" / "trend" / f"trend_{YEAR}_{TERM}.json"


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def _with_seats(data: dict, key: str, seats: int) -> str:
    """The live payload with `key` forced to quota - applied == seats at the end."""
    out = json.loads(json.dumps(data))
    enc = out["series"][key]
    quota = enc["q"] if isinstance(enc["q"], int) else enc["q"][-1]
    n = len(out["t"])
    enc["a"] = [0, quota, n - 1, quota - seats] if n > 1 else quota - seats
    return json.dumps(out)


class SeatAlertTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.data = json.loads(LIVE.read_text())
        cls.key = next(k for k, v in cls.data["series"].items() if isinstance(v.get("q"), int))
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_alert_fires_once_when_seats_open(self) -> None:
        errors: list[str] = []
        payload = {"body": _with_seats(self.data, self.key, 0)}
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                ctx = browser.new_context()
                ctx.grant_permissions(["notifications"])
                page = ctx.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.add_init_script("""
                  window.__notes = [];
                  window.Notification = class { constructor(title, opts) { window.__notes.push([title, opts.body]); } };
                  window.Notification.permission = "granted";
                  window.Notification.requestPermission = async () => "granted";
                """)
                page.route(f"**/data/trend/trend_{YEAR}_{TERM}.json",
                           lambda route: route.fulfill(content_type="application/json",
                                                       body=payload["body"]))
                link = f"#trend/{quote(YEAR + '|' + TERM, safe='')}/{quote(self.key, safe='')}"
                page.goto(self.base + link, wait_until="domcontentloaded")
                page.wait_for_function("k => typeof _trend !== 'undefined' && _trend.key === k", arg=self.key, timeout=20000)
                page.click("#trendWatchSlot .watch-btn")
                self.assertEqual(page.get_attribute("#trendWatchSlot .watch-btn", "aria-pressed"), "true")
                page.wait_for_function("() => document.querySelector('#trendWatchList li') !== null")

                page.evaluate("() => _watchCheck")   # the check the click started
                # still full: no alert
                page.evaluate("() => checkWatches()")
                self.assertEqual(page.evaluate("() => window.__notes.length"), 0)
                # seats open: exactly one alert, and not again while they stay open
                payload["body"] = _with_seats(self.data, self.key, 3)
                page.evaluate("() => checkWatches()")
                page.evaluate("() => checkWatches()")
                notes = page.evaluate("() => window.__notes")
                self.assertEqual(len(notes), 1)
                self.assertIn("여석 3개", notes[0][1])
                self.assertIn("여석이 생겼습니다", page.text_content("#toast"))
                # persisted across a reload
                page.reload(wait_until="domcontentloaded")
                page.wait_for_function("() => document.querySelector('#trendWatchList li') !== null",
                                       timeout=20000)
                self.assertEqual(page.evaluate("() => Object.keys(_watch.items).length"), 1)
            finally:
                browser.close()
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()


class AlertExtensionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.data = json.loads(LIVE.read_text())
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html"
        rows = json.loads((WEB_ROOT / "data" / "classes" / f"{YEAR}_{TERM}.json").read_text())
        timed = [r for r in rows
                 if any(s["day_index"] is not None and s["start_time"] for s in r["slots"])
                 and f"{r['sbjt_cd']}({r['lt_no']})" in cls.data["series"]]
        cls.row = timed[0]
        cls.key = f"{cls.row['sbjt_cd']}({cls.row['lt_no']})"
        cls.others = timed[1:3]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def _page(self, playwright, payload):
        browser = playwright.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.add_init_script("""
          window.__notes = [];
          window.Notification = class { constructor(t, o) { window.__notes.push([t, o.body]); } };
          window.Notification.permission = "granted";
          window.Notification.requestPermission = async () => "granted";
          window.confirm = () => true;
        """)
        page.route(f"**/data/trend/trend_{YEAR}_{TERM}.json",
                   lambda route: route.fulfill(content_type="application/json",
                                               body=payload["body"]))
        return browser, page

    def test_watch_every_bookmarked_class_at_once(self) -> None:
        payload = {"body": LIVE.read_text()}
        with sync_playwright() as playwright:
            browser, page = self._page(playwright, payload)
            try:
                page.goto(self.base, wait_until="domcontentloaded")
                page.wait_for_function("() => typeof wishlist !== 'undefined'")
                page.evaluate("rows => { wishlist = rows.concat([{...rows[0], year: '2019'}]);"
                              " renderWishlist(); }", [self.row, *self.others])
                page.click("#wishToggle")
                page.click(".wish-actions button")
                page.wait_for_function("() => Object.keys(_watch.items).length === 3")
                toast = page.text_content("#toast")
                self.assertIn("3개 알림 등록", toast)
                self.assertIn("인원 데이터가 없는 학기 1개 제외", toast)
                # running it again adds nothing
                page.click(".wish-actions button")
                page.wait_for_function(
                    "() => /이미 등록 3개/.test(document.querySelector('#toast').textContent)")
            finally:
                browser.close()

    def test_a_clashing_class_is_not_announced_while_the_option_is_on(self) -> None:
        payload = {"body": _with_seats(self.data, self.key, 0)}
        with sync_playwright() as playwright:
            browser, page = self._page(playwright, payload)
            try:
                link = f"#trend/{quote(YEAR + '|' + TERM, safe='')}/{quote(self.key, safe='')}"
                page.goto(self.base + link, wait_until="domcontentloaded")
                page.wait_for_function("k => typeof _trend !== 'undefined' && _trend.key === k",
                                       arg=self.key, timeout=20000)
                page.click("#trendWatchSlot .watch-btn")
                page.evaluate("() => _watchCheck")
                page.check("#watchSkipConflicts")
                # a class on the timetable at the same time as the watched one
                page.evaluate("row => { timetable.push({...row, sbjt_cd: 'CLASH', lt_no: '999'}); }",
                              self.row)
                payload["body"] = _with_seats(self.data, self.key, 2)
                page.evaluate("() => checkWatches()")
                self.assertEqual(page.evaluate("() => window.__notes.length"), 0)
                self.assertIn("시간표와 겹침", page.text_content("#trendWatchList"))
                # option off, seats gone and back: announced
                page.uncheck("#watchSkipConflicts")
                payload["body"] = _with_seats(self.data, self.key, 0)
                page.evaluate("() => checkWatches()")
                payload["body"] = _with_seats(self.data, self.key, 1)
                page.evaluate("() => checkWatches()")
                self.assertEqual(page.evaluate("() => window.__notes.length"), 1)
                # the option persists
                self.assertTrue(page.evaluate(
                    "() => JSON.parse(localStorage.getItem('snu_seat_watch')).opts.skipConflicts === false"))
                page.click("#watchClearAll")
                self.assertEqual(page.evaluate("() => Object.keys(_watch.items).length"), 0)
            finally:
                browser.close()
