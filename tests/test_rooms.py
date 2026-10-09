from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
SCRAPER = WEB_ROOT.parent
FIXTURE = SCRAPER / "tests" / "fixtures" / "room_names.json"
YEAR, TERM = "2026", "U000200002U000300001"


def expected_free(day, a, b, campus, building="", past=True):
    sys.path.insert(0, str(SCRAPER))
    from scraper.rooms import normalize_room
    rows = json.loads((WEB_ROOT / f"data/classes/{YEAR}_{TERM}.json").read_text())
    busy, cur = set(), set()
    for c in rows:
        for s in c.get("slots") or []:
            if s.get("day_index") is None or not s.get("start_time") or not s.get("room"):
                continue
            for raw in s["room"].split("/"):
                r = normalize_room(raw)
                if not r:
                    continue
                cur.add(r)
                sa, sb = (int(t[:2]) * 60 + int(t[3:]) for t in (s["start_time"], s["end_time"]))
                if s["day_index"] == day and sa < b and sb > a:
                    busy.add(r.key)
    pool = json.loads((WEB_ROOT / "data/classes/rooms-index.json").read_text())["rooms"]
    keys = {r.key for r in cur if r.key not in busy}
    if past:
        keys |= {f"{p[0]}|{p[2]}" for p in pool} - {r.key for r in cur}

    def ok(k):
        camp, name = k.split("|")
        rr = normalize_room(("#" if camp == "연건" else "*" if camp == "평창" else "") + name)
        return camp == campus and (not building or rr.building == building
                                   or rr.building.startswith(building + "-"))
    return sorted(k for k in keys if ok(k))


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class RoomsDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/index.html#rooms"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def _run(self, steps) -> None:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(self.base, wait_until="domcontentloaded")
                page.wait_for_function("() => typeof normRoom === 'function'", timeout=20000)
                steps(page)
            finally:
                browser.close()
        self.assertEqual(errors, [])

    def test_js_normalizer_matches_the_shared_fixture(self) -> None:
        if not FIXTURE.exists():
            self.skipTest("scraper checkout not next to web/")
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))

        def steps(page):
            got = page.evaluate("(cs) => cs.map((c) => { const r = normRoom(c.raw);"
                                " return [r.campus, r.building, r.name]; })", cases)
            self.assertEqual(got, [[c["campus"], c["building"], c["name"]] for c in cases])
            self.assertIsNone(page.evaluate("normRoom('#')"))
        self._run(steps)

    def test_rooms_index_loads(self) -> None:
        def steps(page):
            n = page.evaluate("async () => (await roomsIndex()).length")
            self.assertEqual(n, len(json.loads((WEB_ROOT / "data/classes/rooms-index.json")
                                               .read_text())["rooms"]))
        self._run(steps)

    def test_free_rooms_match_an_independent_computation(self) -> None:
        queries = [(1, 18 * 60, 21 * 60, "관악", ""), (0, 9 * 60, 10 * 60 + 30, "관악", "24"),
                   (2, 13 * 60, 15 * 60, "연건", "")]

        def steps(page):
            for day, a, b, campus, bld in queries:
                got = page.evaluate(
                    """async ([day, a, b, campus, building]) => {
                      const m = roomMeetings(await termRows('2026', 'U000200002U000300001'));
                      return freeRooms(m, await roomsIndex(), {day, a, b, campus, building, past: true})
                        .map((f) => f.room.key).sort(); }""", [day, a, b, campus, bld])
                with self.subTest(q=(day, a, b, campus, bld)):
                    self.assertEqual(got, expected_free(day, a, b, campus, bld))
        self._run(steps)
