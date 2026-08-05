from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
INDEX_DATA = WEB_ROOT / "data" / "classes" / "index.json"
TERM_DATA = WEB_ROOT / "data" / "classes" / "2026_U000200002U000300001.json"


class JsonBoundaryValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        index = json.loads(INDEX_DATA.read_text(encoding="utf-8"))
        cls.trend_term = next(t for t in index["terms"] if t.get("trend"))
        trend = json.loads(
            (WEB_ROOT / "data" / "trend" / cls.trend_term["trend"]).read_text(encoding="utf-8")
        )
        first_key = next(iter(trend["series"]))
        sbjt_cd, lt_no = first_key.rsplit("(", 1)
        lt_no = lt_no.rstrip(")")
        rows = json.loads(TERM_DATA.read_text(encoding="utf-8"))
        cls.trend_query = next(
            row["name"] for row in rows if row["sbjt_cd"] == sbjt_cd and row["lt_no"] == lt_no
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def test_non_array_term_payload_is_skipped_without_page_error(self) -> None:
        page_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.add_init_script(
                    "localStorage.setItem('snu_grad_state', JSON.stringify({"
                    "picks:{}, list:[{type:'main', major:'간호학과', year:'2026'}], eng:{}"
                    "}));"
                )
                page.route(
                    f"**/data/classes/{TERM_DATA.name}",
                    lambda route: route.fulfill(
                        content_type="application/json", body=json.dumps({"rows": []})
                    ),
                )
                page.goto(self.base_url + "/index.html", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.querySelector('#term')?.options.length > 1",
                    timeout=10000,
                )
                page.select_option("#year", "2026")
                page.select_option("#term", "U000200002U000300001")
                page.click("#searchForm button[type=submit]")
                page.wait_for_function(
                    "() => document.querySelector('#resultCount')?.textContent.includes('0 / 0건 검색됨')",
                    timeout=10000,
                )
                self.assertEqual([], page_errors)
            finally:
                browser.close()

    def test_malformed_trend_shape_is_rejected_without_page_error(self) -> None:
        page_errors: list[str] = []
        trend_value = f"{self.trend_term['year']}|{self.trend_term['term']}"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.route(
                    "**/data/trend/**",
                    lambda route: route.fulfill(
                        content_type="application/json",
                        body=json.dumps(
                            {
                                "updated": "2026-08-05T09:00:00+09:00",
                                "ts": ["2026-08-04T09:00:00+09:00"],
                                "series": None,
                            }
                        ),
                    ),
                )
                page.goto(self.base_url + "/index.html#trend", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.querySelector('#trendTerm')?.options.length > 1",
                    timeout=10000,
                )
                page.select_option("#trendTerm", trend_value)
                page.locator("#trendTerm").dispatch_event("change")
                page.wait_for_function(
                    "() => document.querySelector('#trendMsg')?.textContent === '데이터를 불러오지 못했습니다.'",
                    timeout=10000,
                )
                self.assertEqual([], page_errors)
            finally:
                browser.close()

    def test_non_numeric_trend_metric_is_rejected_before_rendering(self) -> None:
        page_errors: list[str] = []
        trend_value = f"{self.trend_term['year']}|{self.trend_term['term']}"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.route(
                    "**/data/trend/**",
                    lambda route: route.fulfill(
                        content_type="application/json",
                        body=json.dumps(
                            {
                                "updated": "2026-08-05T09:00:00+09:00",
                                "ts": ["2026-08-04T09:00:00+09:00"],
                                "series": {
                                    "MALICIOUS(001)": {
                                        "a": [
                                            '<img src=x onerror="document.body.dataset.validationProbe=\'xss\'">'
                                        ],
                                        "c": [1],
                                        "e": [1],
                                        "q": [1],
                                    }
                                },
                            }
                        ),
                    ),
                )
                page.goto(self.base_url + "/index.html#trend", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.querySelector('#trendTerm')?.options.length > 1",
                    timeout=10000,
                )
                page.select_option("#trendTerm", trend_value)
                page.locator("#trendTerm").dispatch_event("change")
                page.wait_for_function(
                    "() => document.querySelector('#trendMsg')?.textContent === '데이터를 불러오지 못했습니다.'",
                    timeout=10000,
                )
                self.assertEqual(0, page.locator("#trendTip img").count())
                self.assertEqual("", page.locator("body").get_attribute("data-validation-probe") or "")
                self.assertEqual([], page_errors)
            finally:
                browser.close()

    def test_current_explore_trend_and_graduation_payloads_load(self) -> None:
        page_errors: list[str] = []
        trend_value = f"{self.trend_term['year']}|{self.trend_term['term']}"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))

                page.goto(self.base_url + "/index.html#trend", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.querySelector('#trendTerm')?.options.length > 1",
                    timeout=10000,
                )
                page.select_option("#trendTerm", trend_value)
                page.locator("#trendTerm").dispatch_event("change")
                page.wait_for_function(
                    "() => document.querySelector('#trendMsg')?.textContent.includes('강좌를 검색해 선택하세요')",
                    timeout=10000,
                )
                page.fill("#trendClass", self.trend_query)
                page.wait_for_selector("#trendResults li:not(.r-empty)", timeout=10000)
                page.locator("#trendResults li:not(.r-empty)").first.click()
                page.locator("#trendChart svg rect").hover()
                page.wait_for_function(
                    "() => !document.querySelector('#trendTip')?.classList.contains('hidden')",
                    timeout=10000,
                )
                self.assertGreater(page.locator("#trendTip .tip-row").count(), 0)
                self.assertEqual(0, page.locator("#trendTip img").count())

                page.goto(self.base_url + "/index.html#explore", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.querySelector('#exploreQ') && document.querySelector('#exploreSearch')",
                    timeout=10000,
                )
                page.fill("#exploreQ", "M3502")
                page.wait_for_function(
                    "() => document.querySelector('#exploreCount')?.textContent.includes('과목')",
                    timeout=10000,
                )

                page.goto(self.base_url + "/index.html#grad", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => (document.querySelector('#gradBody')?.textContent || '').trim().length > 0",
                    timeout=10000,
                )
                grad_text = page.locator("#gradBody").text_content() or ""
                self.assertIn("간호학과", grad_text)
                self.assertNotIn("졸업요건 데이터를 불러오지 못했습니다.", grad_text)
                self.assertEqual([], page_errors)
            finally:
                browser.close()

    def test_malformed_explore_and_graduation_payloads_are_feature_local(self) -> None:
        page_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.route(
                    "**/data/explore-index.json",
                    lambda route: route.fulfill(
                        content_type="application/json", body=json.dumps({"strings": None})
                    ),
                )
                page.goto(self.base_url + "/index.html#explore", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.querySelector('#exploreSearch') && document.querySelector('#exploreQ')",
                    timeout=10000,
                )

                page.route(
                    "**/data/grad_req/index.json",
                    lambda route: route.fulfill(
                        content_type="application/json", body=json.dumps({"entries": []})
                    ),
                )
                page.goto(self.base_url + "/index.html#grad", wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => (document.querySelector('#gradBody')?.textContent || '').includes('졸업요건 데이터를 불러오지 못했습니다.')",
                    timeout=10000,
                )
                self.assertEqual([], page_errors)
            finally:
                browser.close()

    def test_all_checked_in_graduation_payloads_pass_boundary_validation(self) -> None:
        payloads = []
        for path in (WEB_ROOT / "data" / "grad_req").glob("*.json"):
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and "id" in raw:
                payloads.append({"kind": "spec", "name": path.name, "payload": raw})
        for path in (WEB_ROOT / "data" / "grad_req" / "gyo").glob("*.json"):
            raw = json.loads(path.read_text(encoding="utf-8"))
            if path.name == "bucket_defs.json":
                continue
            kind = "area" if path.name == "area_codes.json" else "gyo"
            payloads.append({"kind": kind, "name": path.name, "payload": raw})

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.goto(self.base_url + "/index.html", wait_until="domcontentloaded")
                failures = page.evaluate(
                    """payloads => payloads.flatMap(item => {
                      try {
                        if (item.kind === 'spec') _validateGradSpec(item.payload, item.name);
                        else if (item.kind === 'area') _validateAreaCodes(item.payload, item.name);
                        else _validateGyo(item.payload, item.name);
                        return [];
                      } catch (error) {
                        return [item.name + ': ' + error.message];
                      }
                    })""",
                    payloads,
                )
                self.assertEqual([], failures)
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
