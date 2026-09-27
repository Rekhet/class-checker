"""Characterization tests for the graduation audit (_gradAuditBlock).

The audit's rules are dense (tracks, 택N groups, 수리통계, recognition caps,
교양 buckets with flexible areas), and nothing checked its output before. For
every graduation spec this runs the audit on four synthetic transcripts built
deterministically from the catalog and records, per transcript, whether the
entry passes and every "have / need" figure the page shows. A change in any of
them fails the test: intended changes regenerate the snapshot with

    UPDATE_GOLDEN=1 python -m pytest web/tests/test_grad_golden.py

and the diff of tests/golden/grad_audit.json is the review.
"""
from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


WEB_ROOT = Path(__file__).resolve().parents[1]
GOLDEN = Path(__file__).resolve().parent / "golden" / "grad_audit.json"

AUDIT_ALL = """
async () => {
  // Transcripts come from the newest year's catalog so they do not depend on
  // which past terms happen to be exported.
  const idx = await _loadGradIndex();
  const areaCodes = await _loadAreaCodes();
  const codeEquiv = await _loadCodeEquiv();
  const di = await dataIndex();
  const year = di.terms.map((t) => t.year).sort().reverse()[0];
  const catalog = (await Promise.all(di.terms.filter((t) => t.year === year)
    .map((t) => termRows(t.year, t.term)))).flat();
  const byCode = new Map();
  for (const c of [...catalog].sort((a, b) => (a.sbjt_cd < b.sbjt_cd ? -1 : a.sbjt_cd > b.sbjt_cd ? 1 : 0)))
    if (!byCode.has(c.sbjt_cd)) byCode.set(c.sbjt_cd, c);
  const asRow = (c) => ({ name: c.name, sbjt_cd: c.sbjt_cd, credits: Number(c.credits) || 0,
    cls: c.classification || [], dept: c.department || "", college: c.college || "" });
  const gyo = [...byCode.values()].filter((c) => (c.classification || []).includes("교양"))
    .slice(0, 80).map(asRow);
  const out = {};
  for (const ie of [...idx].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const spec = await _loadGradSpec(ie.file);
    if (!spec) { out[ie.file] = "unloadable"; continue; }
    const entry = { type: _gradIsInter(ie.major) ? "union" : "main", major: ie.major, year: String(ie.batch) };
    const list = [entry];
    const track = _gradTrackOf(spec, entry, list);
    const required = await _gradRequired(spec, entry.year);
    const ruleset = await _loadGyo(spec.general);
    const depts = [...(spec.major_select_match?.departments || []),
                   ...(spec.major_required_match?.departments || [])];
    const req = new Set([...required.map((c) => c.code),
      ...((track.required && track.required.all) || []).map((c) => c.code)].filter(Boolean));
    const reqRows = [...req].map((code) => byCode.get(code)).filter(Boolean).map(asRow);
    // 전공선택 alone up to the track's whole 전공 minimum: generous on purpose,
    // so the credit bars are met whenever the catalog offers enough courses
    const sel = [];
    let cr = 0;
    for (const c of byCode.values()) {
      if (cr >= (track.major_min_credits || 0) + 3) break;
      if (req.has(c.sbjt_cd) || !(c.classification || []).includes("전선")) continue;
      if (!depts.some((d) => (c.department || "").includes(d))) continue;
      sel.push(asRow(c)); cr += Number(c.credits) || 0;
    }
    // "graduate": each 교양 bucket filled from its own areas (round-robin, so
    // pick_min_areas is met), the named 필수 교양, then any course until the
    // spec's total — the transcript that should pass wherever the rules can.
    const fineOf = (sb) => (areaCodes.exceptions || {})[sb] || (areaCodes.codes || {})[String(sb).split(".")[0]] || "";
    const grad = [...reqRows, ...sel];
    const usedG = new Set(grad.map((r) => r.sbjt_cd));
    for (const bk of (ruleset && ruleset.buckets) || []) {
      const pools = (bk.areas || []).map((a) => [...byCode.values()].filter((c) =>
        (c.classification || []).includes("교양") && fineOf(c.sbjt_cd) === a && !usedG.has(c.sbjt_cd)));
      let got = 0;
      for (let round = 0; got < bk.min + 3 && pools.some((pl) => pl.length > round); round++)
        for (const pl of pools) if (pl[round] && got < bk.min + 3) {
          grad.push(asRow(pl[round])); usedG.add(pl[round].sbjt_cd); got += Number(pl[round].credits) || 0;
        }
    }
    for (const g of spec.dept_required_general || []) {
      const c = [...byCode.values()].find((x) => x.name === g.name || x.name.includes(g.name));
      if (c && !usedG.has(c.sbjt_cd)) { grad.push(asRow(c)); usedG.add(c.sbjt_cd); }
    }
    let total = grad.reduce((s, r) => s + r.credits, 0);
    for (const c of byCode.values()) {
      if (total >= (spec.total_credits || 0)) break;
      if (usedG.has(c.sbjt_cd) || !(c.classification || []).includes("교양")) continue;
      grad.push(asRow(c)); usedG.add(c.sbjt_cd); total += Number(c.credits) || 0;
    }
    const transcripts = { empty: [], major: [...reqRows, ...sel], full: [...reqRows, ...sel, ...gyo],
                          graduate: grad };
    const res = {};
    for (const [name, rows] of Object.entries(transcripts)) {
      _gradState.eng = { 0: name === "graduate" };   // 영어강좌: checked only for "graduate"
      const r = _gradAuditBlock(spec, track, rows, required, entry, 0, ruleset, areaCodes, codeEquiv);
      res[name] = { ok: r.ok, figures: [...r.node.querySelectorAll(".gc-num")].map((n) => n.textContent) };
    }
    out[ie.file] = { track: track.key, ...res };
  }
  return out;
}
"""


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class GraduationAuditGoldenTests(unittest.TestCase):
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

    def _audit(self) -> dict:
        errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(self.base, wait_until="networkidle")
                page.wait_for_function("() => typeof _gradAuditBlock === 'function'")
                result = page.evaluate(AUDIT_ALL)
            finally:
                browser.close()
        self.assertEqual(errors, [])
        return result

    def test_audit_matches_the_golden_snapshot(self) -> None:
        result = self._audit()
        self.assertGreater(len(result), 100)
        # invariants that hold whatever the snapshot says
        for file, r in result.items():
            with self.subTest(spec=file):
                self.assertNotEqual(r, "unloadable")
                self.assertFalse(r["empty"]["ok"], "an empty transcript cannot graduate")
        if os.environ.get("UPDATE_GOLDEN") == "1" or not GOLDEN.exists():
            GOLDEN.parent.mkdir(exist_ok=True)
            GOLDEN.write_text(json.dumps(result, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                              encoding="utf-8")
            self.skipTest(f"wrote {GOLDEN.name} ({len(result)} specs)")
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        changed = sorted(f for f in set(golden) | set(result) if golden.get(f) != result.get(f))
        self.assertEqual(changed, [], f"audit output changed for {len(changed)} spec(s); "
                                      "review, then UPDATE_GOLDEN=1 to accept")


if __name__ == "__main__":
    unittest.main()
