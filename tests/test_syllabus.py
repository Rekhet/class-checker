from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
YEAR, TERM = "2026", "U000200002U000300001"
SHINE = "https://shine.snu.ac.kr/com/download/noflt/downloadWebFile.action"
KO1 = "강의계획서(초급독일어1).hwp (123.5KB)"
KO2 = "syllabus_부록.pdf (1.2MB)"


def cls(sbjt, lt="001", subh=""):
    return {"term": TERM, "year": YEAR, "shtm_fg": "U000200002", "deta_shtm_fg": "U000300001",
            "sbjt_cd": sbjt, "lt_no": lt, "subh_cd": subh, "name": "시험강좌",
            "professor": "홍길동", "department": "독어독문학과", "credits": 3,
            "classification": [], "slots": []}


FILE = {"generated": "x", "year": YEAR, "term": TERM, "collected_at": "x", "classes": {
    "A001|001": {"ko": [[KO1, "11", "1"], [KO2, "11", "2"]], "en": [["en.pdf (9KB)", "12", "1"]]},
    "B002|001": {},
}}


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class SyllabusDrawerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls_) -> None:
        handler = partial(_Quiet, directory=str(WEB_ROOT))
        cls_.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls_.server.serve_forever, daemon=True).start()
        cls_.base = f"http://127.0.0.1:{cls_.server.server_port}/index.html"

    @classmethod
    def tearDownClass(cls_) -> None:
        cls_.server.shutdown()
        cls_.server.server_close()

    def _run(self, steps, route=None, proxy=None) -> None:
        errors: list[str] = []
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                ctx = browser.new_context(accept_downloads=True)
                page = ctx.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                if route:
                    page.route("**/data/syllabus/*", route)
                page.goto(self.base, wait_until="domcontentloaded")
                page.wait_for_function("() => typeof openDetail === 'function'", timeout=20000)
                if proxy is not None:
                    page.evaluate("(p) => { window.SYLLABUS_PROXY = p; }", proxy)
                steps(page)
            finally:
                browser.close()
        self.assertEqual(errors, [])

    @staticmethod
    def _open(page, c):
        page.evaluate("(c) => openDetail(c)", c)

    @staticmethod
    def _rows(page):
        return page.evaluate("""() => {
          const out = {};
          for (const r of document.querySelectorAll('#detailDrawer .d-syl .d-row'))
            out[r.children[0].textContent] = r.children[1].textContent;
          return out; }""")

    def _serve_file(self, route):
        route.fulfill(status=200, content_type="application/json", body=json.dumps(FILE))

    def test_statuses_and_two_korean_files(self) -> None:
        def steps(page):
            self._open(page, cls("A001"))
            page.wait_for_selector("#detailDrawer .d-syl a")
            links = page.locator("#detailDrawer .d-syl .d-row", has_text="국문").locator("a")
            self.assertEqual(links.all_inner_texts(), [KO1, KO2])
            q = parse_qs(urlparse(links.first.get_attribute("href")).query)
            self.assertEqual(q, {"cscLocale": ["ko_KR"], "attcFileNo": ["11"], "attcFileDetaNo": ["1"]})
            self.assertTrue(links.first.get_attribute("href").startswith(SHINE + "?"))
            self.assertIsNone(links.first.get_attribute("download"))
            self.assertEqual(self._rows(page).get("원본"), None)
            # collected, no attachment in either language
            self._open(page, cls("B002"))
            self.assertEqual(self._rows(page), {"국문": "-", "영문": "-"})
            # class without a key -> not collected
            self._open(page, cls("C003"))
            self.assertEqual(self._rows(page), {"국문": "미수집", "영문": "미수집"})
        self._run(steps, self._serve_file)

    def test_term_file_404_is_not_collected(self) -> None:
        def steps(page):
            self._open(page, cls("A001"))
            page.wait_for_function("() => document.querySelector('#detailDrawer .d-syl')"
                                   " && !document.querySelector('#detailDrawer .d-syl').textContent.includes('불러오는 중')")
            self.assertEqual(self._rows(page), {"국문": "미수집", "영문": "미수집"})
        self._run(steps, lambda r: r.fulfill(status=404, body="no"))

    def test_loading_and_failed(self) -> None:
        held = []

        def steps(page):
            self._open(page, cls("A001"))
            page.wait_for_function("() => document.querySelector('#detailDrawer .d-syl')")
            self.assertEqual(self._rows(page), {"국문": "불러오는 중", "영문": "불러오는 중"})
            page.wait_for_timeout(300)
            self.assertEqual(len(held), 1)
            held[0].abort()
            page.wait_for_function("() => document.querySelector('#detailDrawer .d-syl')"
                                   ".textContent.includes('불러오지 못함')")
            self.assertEqual(self._rows(page), {"국문": "불러오지 못함", "영문": "불러오지 못함"})
        self._run(steps, lambda r: held.append(r))

    def test_failed_fetch_is_retried_on_reopen(self) -> None:
        calls = []

        def route(r):
            calls.append(1)
            if len(calls) == 1:
                r.abort()
            else:
                self._serve_file(r)

        def steps(page):
            self._open(page, cls("A001"))
            page.wait_for_function("() => document.querySelector('#detailDrawer .d-syl')"
                                   ".textContent.includes('불러오지 못함')")
            page.evaluate("() => closeDetail()")
            self._open(page, cls("A001"))
            page.wait_for_selector("#detailDrawer .d-syl a")
            self.assertEqual(len(calls), 2)
            self.assertEqual(self._rows(page)["국문"], KO1 + KO2)
        self._run(steps, route)

    def test_success_and_404_stay_cached(self) -> None:
        calls = []

        def route(r):
            calls.append(1)
            r.fulfill(status=404, body="no")

        def steps(page):
            for _ in range(2):
                self._open(page, cls("A001"))
                page.wait_for_function("() => document.querySelector('#detailDrawer .d-syl')"
                                       ".textContent.includes('미수집')")
                page.evaluate("() => closeDetail()")
            self.assertEqual(len(calls), 1)
        self._run(steps, route)

    def test_old_fetch_does_not_rerender_a_different_term(self) -> None:
        held = []

        def steps(page):
            page.evaluate("() => { window.__n = 0; const f = renderDetail;"
                          " window.renderDetail = () => { window.__n++; return f(); }; }")
            self._open(page, cls("A001"))
            page.wait_for_timeout(300)
            other = cls("A001"); other["term"] = "U000200001U000300001"
            self._open(page, other)
            page.wait_for_timeout(300)
            self.assertEqual(len(held), 2)
            n = page.evaluate("() => window.__n")
            held[0].fulfill(status=200, content_type="application/json", body=json.dumps(FILE))
            page.wait_for_timeout(300)
            self.assertEqual(page.evaluate("() => window.__n"), n)
            self.assertEqual(self._rows(page), {"국문": "불러오는 중", "영문": "불러오는 중"})
        self._run(steps, lambda r: held.append(r))

    def test_only_one_language_has_files(self) -> None:
        def steps(page):
            self._open(page, cls("D004"))
            page.wait_for_selector("#detailDrawer .d-syl a")
            self.assertEqual(self._rows(page), {"국문": "-", "영문": "e.pdf (1KB)"})
        f = json.loads(json.dumps(FILE))
        f["classes"]["D004|001"] = {"en": [["e.pdf (1KB)", "5", "1"]]}
        self._run(steps, lambda r: r.fulfill(status=200, content_type="application/json",
                                             body=json.dumps(f)))

    def test_entry_without_file_number_is_skipped(self) -> None:
        def steps(page):
            self._open(page, cls("E005"))
            page.wait_for_selector("#detailDrawer .d-syl a")
            hrefs = page.locator("#detailDrawer .d-syl a").evaluate_all("(a) => a.map((x) => x.href)")
            self.assertEqual(len(hrefs), 1)
            self.assertNotIn("null", hrefs[0])
            self.assertEqual(self._rows(page)["영문"], "-")
        f = json.loads(json.dumps(FILE))
        f["classes"]["E005|001"] = {"ko": [["bad.pdf", None, "1"], ["ok.pdf", "7", "2"]],
                                    "en": [["bad2.pdf", "", "1"]]}
        self._run(steps, lambda r: r.fulfill(status=200, content_type="application/json",
                                             body=json.dumps(f)))

    def test_click_downloads_without_navigating(self) -> None:
        def steps(page):
            page.route(SHINE + "*", lambda r: r.fulfill(
                status=200, body=b"hello",
                headers={"Content-Disposition": 'attachment; filename="a.hwp"',
                         "Content-Type": "application/octet-stream"}))
            self._open(page, cls("A001"))
            page.wait_for_selector("#detailDrawer .d-syl a")
            before = page.url
            with page.expect_download() as d:
                page.locator("#detailDrawer .d-syl a").first.click()
            self.assertEqual(d.value.suggested_filename, "a.hwp")
            self.assertEqual(page.url, before)
        self._run(steps, self._serve_file)

    def test_original_link_when_proxy_set(self) -> None:
        def steps(page):
            self._open(page, cls("A001", subh="01 &"))
            page.wait_for_selector("#detailDrawer .d-syl a")
            a = page.locator("#detailDrawer .d-syl .d-row", has_text="원본").locator("a")
            self.assertEqual(a.inner_text(), "수강신청 사이트에서 보기 ↗")
            self.assertEqual(a.get_attribute("href"),
                             "https://w.example.workers.dev/sugang/cc/cc103.action?openSchyy=2026"
                             "&openShtmFg=U000200002&openDetaShtmFg=U000300001&sbjtCd=A001"
                             "&ltNo=001&sbjtSubhCd=01%20%26")
            self.assertEqual(a.get_attribute("target"), "_blank")
            rel = a.get_attribute("rel").split()
            self.assertIn("noopener", rel)
            self.assertNotIn("noreferrer", rel)
            self._open(page, cls("A001"))
            self.assertIn("sbjtSubhCd=000", page.locator("#detailDrawer .d-syl a").first.get_attribute("href"))
        self._run(steps, self._serve_file, proxy="https://w.example.workers.dev")

    def test_original_row_absent_when_proxy_empty(self) -> None:
        def steps(page):
            self._open(page, cls("A001"))
            page.wait_for_selector("#detailDrawer .d-syl a")
            self.assertNotIn("원본", self._rows(page))
            self.assertEqual(page.evaluate("() => window.SYLLABUS_PROXY"), "")
        self._run(steps, self._serve_file)

    def test_manual_class_has_no_group(self) -> None:
        def steps(page):
            c = cls("A001"); c["term"] = "MANUAL"
            self._open(page, c)
            self.assertEqual(page.locator("#detailDrawer .d-syl").count(), 0)
        self._run(steps, self._serve_file)


if __name__ == "__main__":
    unittest.main()
