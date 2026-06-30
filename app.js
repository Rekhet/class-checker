"use strict";

const DAYS = ["월", "화", "수", "목", "금", "토", "일"];   // 0..6
const DAY_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PERIODS = Array.from({ length: 14 }, (_, i) => i); // 0..13 -> 08:00..21:00
// proportional timetable geometry
const HOUR_PX = 54;          // vertical px per hour
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return h * 60 + m;
};
const TT_KEY = "snu_tt_v1";          // legacy single-timetable storage (migrated)
const SHEETS_KEY = "snu_sheets_v1";  // multiple named timetables
// SNU term codes (cmmnCd) are year-independent, so year and semester are chosen
// separately everywhere; this maps a term code to its semester-only label.
const SEMESTER_LABEL = {
  "U000200001U000300001": "1학기 Spring",
  "U000200002U000300001": "2학기 Fall",
  "U000200001U000300002": "여름학기 Summer",
  "U000200002U000300002": "겨울학기 Winter",
};
const ADMIN_TERMS = Object.entries(SEMESTER_LABEL)
  .map(([code, label]) => ({ code, label }));
const PALETTE = ["#376dc8", "#2e9e6b", "#c87a37", "#8b5cf6", "#c8485a",
  "#0d9488", "#d4a017", "#5b48b0", "#1f7a8c", "#b5446e"];

// Sheets are id-keyed: lightweight metadata (names/counts/order) for ALL sheets,
// but each sheet's class list lives in its own localStorage key and is loaded on
// demand into an LRU cache (so 1000s of sheets don't serialize/hold all at once).
const META_KEY = "snu_sheets_v2";
const WISHLIST_KEY = "snu_wishlist";
const SHEET_PREFIX = "snu_sheet_";
const MAX_LIVE_SHEETS = Math.max(2, window.MAX_LIVE_SHEETS || 12);   // configurable
const SHEET_TAB_LIMIT = Math.max(1, window.SHEET_TAB_LIMIT || 20);   // above this -> picker, not tabs
const MAX_SHEETS = Math.max(1, window.MAX_SHEETS || 1000);           // hard cap on sheet count
let meta = { active: 0, ids: [], names: {}, counts: {}, nextId: 1, seen: {}, cur: null, sems: {} };
const liveSheets = new Map();   // id -> classes[]; insertion order = LRU (oldest first)
let _quotaWarned = false;       // declared before initSheets() runs (it writes to storage)
let _metaRaf = 0;               // pending rAF id for the coalesced meta write
let timetable = initSheets();   // active sheet's classes (=== liveSheets.get(activeId()))
let wishlist = _loadWishlist(); // bookmarked classes (not on any sheet), persisted
const _undo = {}, _redo = {};   // per-sheet edit history (in-memory, sheet id -> [snapshots])
let hoverPreview = null;   // ghost preview of a hovered search result

// ---------- utils ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok && r.status !== 409) throw new Error(`${r.status}`);
  return r.json();
}

// ---------- static data layer ----------
// Catalog comes from prebuilt JSON in /data/classes (index.json + one file per term), so
// the page needs no backend. The same files are served by the Python server too,
// so search/vocab work identically with or without it.
let _dataIndex = null;
const _termData = new Map();   // "year|term" -> [class rows]
async function dataIndex() {
  if (!_dataIndex) _dataIndex = await fetch("data/classes/index.json").then((r) => r.json());
  return _dataIndex;
}
async function termRows(year, term) {
  const key = `${year}|${term}`;
  if (!_termData.has(key)) {
    const meta = (await dataIndex()).terms.find((t) => t.year === year && t.term === term);
    _termData.set(key, meta ? await fetch("data/classes/" + meta.file).then((r) => r.json()) : []);
  }
  return _termData.get(key);
}
// does the query narrow results by anything other than year/term?
function hasOtherFilters(f) {
  return !!(f.name || f.professor || f.department || f.day != null || f.period != null
    || f.classifications?.length || f.levels?.length || f.grades?.length);
}
// which term files to load. Year/term scope them; otherwise every matching term
// is searched so "all years" is complete. Only a TRULY empty query (no filters at
// all) falls back to the latest term, to avoid loading the whole catalog for nothing.
async function rowsForScope(f) {
  const idx = await dataIndex();
  let ts = idx.terms.filter((t) => (!f.year || t.year === f.year) && (!f.term || t.term === f.term));
  if (!f.year && !f.term && !hasOtherFilters(f)) ts = idx.terms.slice(0, 1);
  const out = [];
  for (const t of ts) out.push(...await termRows(t.year, t.term));
  return out;
}
// subsequence: query chars appear in order in the haystack
function subseqMatch(hay, needle) {
  hay = (hay || "").toLowerCase(); needle = needle.toLowerCase();
  if (!needle) return true;
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return false;
}
// first char of each whitespace word: "심층신경망의 수학적 기초" -> "심수기"
function wordInitials(name) {
  return (name || "").toLowerCase().split(/\s+/).filter(Boolean).map((w) => w[0]).join("");
}
// relevance of a name vs a (possibly shorthand) query. 0 = no match; higher = better.
// Lets a shorthand like "심수기" rank the intended class above loose subsequence noise.
function nameScore(name, q) {
  const n = (name || "").toLowerCase(); q = (q || "").toLowerCase();
  if (!q) return 1;
  if (n.includes(q)) return n.startsWith(q) ? 6 : 5;     // substring (prefix best)
  const ini = wordInitials(name);
  if (ini === q) return 4;                                // exact word-initials
  if (ini.startsWith(q)) return 3;
  if (subseqMatch(ini, q)) return 2;                      // initials subsequence (skips prefixes)
  if (subseqMatch(n, q)) return 1;                        // loose full-name subsequence
  return 0;
}
function matchRow(c, f) {
  const has = (hay, needle) => (hay || "").toLowerCase().includes(needle.toLowerCase());
  if (f.name && nameScore(c.name, f.name) === 0) return false;
  if (f.professor && !has(c.professor, f.professor)) return false;
  if (f.department && !has(c.department, f.department)) return false;
  if (f.grades?.length && !f.grades.includes(gradeBucket(c.grade))) return false;
  const cls = c.classification || [];
  if (f.classifications?.length && !f.classifications.some((x) => cls.includes(x))) return false;
  if (f.levels?.length && !f.levels.some((x) => cls.includes(x))) return false;
  if (f.credits != null) {
    const cr = Number(c.credits);
    if (f.credits === "4+" ? !(cr >= 4) : cr !== f.credits) return false;
  }
  if (f.room && !has(c.room, f.room)) return false;
  if (f.englishOnly && c.language !== "영어") return false;
  if (f.day != null || f.period != null) {
    if (!(c.slots || []).some((s) =>
      (f.day == null || s.day_index === f.day) && (f.period == null || s.period === f.period)))
      return false;
  }
  return true;
}
// busy meeting intervals from the current timetable (skip removed; keep key to
// exclude a class from clashing with itself)
function timetableBusy() {
  const busy = [];
  for (const c of timetable) {
    if (c.removed) continue;
    const key = classKey(c);
    for (const s of (c.slots || [])) {
      if (s.day_index == null || !s.start_time || !s.end_time) continue;
      busy.push({ key, d: s.day_index, a: toMin(s.start_time), b: toMin(s.end_time) });
    }
  }
  return busy;
}
function overlapsBusy(c, busy) {
  const key = classKey(c);
  for (const s of (c.slots || [])) {
    if (s.day_index == null || !s.start_time || !s.end_time) continue;
    const a = toMin(s.start_time), b = toMin(s.end_time);
    for (const x of busy)
      if (x.key !== key && x.d === s.day_index && a < x.b && x.a < b) return true;
  }
  return false;
}
async function searchLocal(f, { limit = 100, offset = 0 } = {}) {
  let rows = (await rowsForScope(f)).filter((c) => matchRow(c, f));
  if (f.emptyOnly) {   // only classes that fit the timetable's free slots (no overlap)
    const busy = timetableBusy();
    rows = rows.filter((c) => !overlapsBusy(c, busy));
  }
  if (f.timedOnly) {   // only classes with a scheduled time (exclude 시간미정/TBA)
    rows = rows.filter((c) => (c.slots || []).some((s) => s.day_index != null && s.start_time));
  }
  if (f.name) {   // rank by name relevance so a shorthand surfaces the best match first
    rows.sort((a, b) => nameScore(b.name, f.name) - nameScore(a.name, f.name)
      || (a.name || "").localeCompare(b.name || "")
      || (a.lt_no || "").localeCompare(b.lt_no || ""));
  } else {
    rows.sort((a, b) => (a.name || "").localeCompare(b.name || "")
      || (a.lt_no || "").localeCompare(b.lt_no || ""));
  }
  return { total: rows.length, classes: limit == null ? rows : rows.slice(offset, offset + limit) };
}
async function lookupLocal(keys) {
  const want = new Set(keys.map((k) => k.join("|")));
  const terms = new Map(keys.map(([y, t]) => [`${y}|${t}`, [y, t]]));
  const out = [];
  for (const [, [y, t]] of terms)
    for (const c of await termRows(y, t))
      if (want.has([c.year, c.term, c.sbjt_cd, c.lt_no].join("|"))) out.push(c);
  return out;
}

// ---------- export (client-side: no backend) ----------
const EXPORT_HEADERS = ["연도", "학기", "교과목명", "교수", "단과대학", "학과", "교과목번호",
  "강좌번호", "학점", "학년", "이수구분", "정원", "재학생정원", "신입생정원", "신청", "수업시간"];
function fmtSlotsExport(slots) {
  return (slots || []).filter((s) => s.day_index != null && s.start_time)
    .map((s) => `${DAYS[s.day_index]}(${s.start_time}~${s.end_time || ""})`).join("/");
}
function exportRow(c) {
  const q = c.quota, ret = c.quota_returning;
  return [c.year || "", (SEMESTER_LABEL[c.term] || c.term || "").split(" ")[0],
    c.name || "", c.professor || "", c.college || "", c.department || "",
    c.sbjt_cd || "", c.lt_no || "", c.credits ?? "", c.grade || "",
    (c.classification || []).join(" "), q ?? "", ret ?? "",
    (q != null && ret != null) ? q - ret : "", c.applied ?? "", fmtSlotsExport(c.slots)];
}
function rowsToCsv(classes) {
  const esc = (v) => { v = String(v ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return [EXPORT_HEADERS.join(","), ...classes.map((c) => exportRow(c).map(esc).join(","))].join("\r\n");
}
let _xlsxLib;
function loadSheetJS() {
  if (_xlsxLib) return _xlsxLib;
  _xlsxLib = new Promise((res, rej) => {
    if (window.XLSX) return res(window.XLSX);
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error("XLSX 라이브러리 로드 실패 (네트워크 확인)"));
    document.head.appendChild(s);
  });
  return _xlsxLib;
}
async function rowsToXlsx(classes) {
  let XLSX;
  try { XLSX = await loadSheetJS(); }
  catch (e) { alert(`${e.message} — CSV로 내보내세요.`); return; }
  const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, ...classes.map(exportRow)]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "classes");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  downloadBlob(new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "classes.xlsx");
}
function classKey(c) { return `${c.year}|${c.term}|${c.sbjt_cd}|${c.lt_no}`; }
function semKey(c) { return `${c.year}|${c.term}`; }
// chronological order within a year: 1학기 < 여름 < 2학기 < 겨울
const TERM_ORDER = [
  "U000200001U000300001", // 1학기 Spring
  "U000200001U000300002", // 여름학기 Summer
  "U000200002U000300001", // 2학기 Fall
  "U000200002U000300002", // 겨울학기 Winter
];
function termRank(t) { const i = TERM_ORDER.indexOf(t); return i < 0 ? 0 : i; }
function semRankKey(key) { const [y, t] = String(key).split("|"); return Number(y) * 10 + termRank(t); }
// newest semester present in the catalog (index.json terms), as a "year|term" key
function catalogNewest() {
  const terms = _dataIndex?.terms || [];
  let best = "", bestR = -Infinity;
  for (const t of terms) {
    const k = `${t.year}|${t.term}`, r = semRankKey(k);
    if (r > bestR) { bestR = r; best = k; }
  }
  return best;
}
// config.js: the page semester to open on first load (before any saved choice).
// Authoritative — honored even if absent from the catalog. "" when not configured.
function configuredSemester() {
  const y = (window.DEFAULT_SEMESTER_YEAR || "").toString().trim();
  const t = resolveTermDefault(window.DEFAULT_SEMESTER_TERM);
  return (y && t) ? `${y}|${t}` : "";
}
// the default semester for fresh state: configured value wins, else newest catalog term
function defaultSemester() { return configuredSemester() || catalogNewest(); }
// every selectable semester: catalog terms ∪ semesters any sheet belongs to, newest first
function availableSemesters() {
  const set = new Set();
  for (const t of (_dataIndex?.terms || [])) set.add(`${t.year}|${t.term}`);
  for (const k of Object.values(meta.sems)) if (k) set.add(k);
  if (meta.cur) set.add(meta.cur);
  return [...set].sort((a, b) => semRankKey(b) - semRankKey(a));
}
function semLabel(key) {
  const [y, t] = String(key).split("|");
  const hit = (_dataIndex?.terms || []).find((x) => x.year === y && x.term === t);
  if (hit && hit.label) return hit.label;                 // "2026 2학기"
  const s = (SEMESTER_LABEL[t] || t).split(" ")[0];       // "2학기"
  return `${y} ${s}`;
}
// backfill sems for pre-feature sheets + pick a default cur (runs after catalog loads)
function migrateSemesters() {
  if (!_dataIndex) return;
  const def = defaultSemester();
  for (const id of meta.ids) if (!meta.sems[id]) meta.sems[id] = def;
  if (!meta.cur) {
    const a = activeId();
    meta.cur = (a != null && meta.sems[a]) || def;
  }
  _saveMeta();
}
function colorFor(c) {
  let h = 0; const k = classKey(c);
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function periodLabel(p) { return String(8 + p).padStart(2, "0"); }
function hhmm(min) {
  return `${String((min / 60) | 0).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ---------- search rail (name input + foldable advanced filters) ----------
// 과정(level)+이수구분(type) share one chip row: every classification token is a
// chip; currentFilters() splits the selected ones back into levels vs types.
function buildFilters() {
  const form = $("#searchForm");
  const sel = (name) => el("select", { name, id: name });
  const labeled = (text, control) => el("label", {}, text, control);

  // always-visible course-name search
  form.append(el("input", {
    type: "text", name: "name", id: "name", className: "name-input", placeholder: "강좌명 검색",
  }));

  // advanced filters, smoothly expanded/collapsed by #filterToggle
  const adv = el("div", { className: "adv", id: "advFilters" });
  const grid = el("div", { className: "adv-grid" });
  grid.append(labeled("연도", sel("year")));
  grid.append(labeled("학기", sel("term")));
  grid.append(labeled("교수", el("input", { type: "text", name: "professor", id: "professor", placeholder: "이름" })));
  const dept = el("input", { type: "text", name: "department", id: "department", placeholder: "학과명" });
  dept.setAttribute("list", "deptList");
  const deptLabel = labeled("학과", dept);
  deptLabel.append(el("datalist", { id: "deptList" }));
  grid.append(deptLabel);
  grid.append(labeled("요일", sel("day")));
  grid.append(labeled("교시", sel("period")));
  grid.append(labeled("학점", el("select", { name: "credits", id: "credits" },
    el("option", { value: "" }, "전체"),
    el("option", { value: "1" }, "1학점"),
    el("option", { value: "2" }, "2학점"),
    el("option", { value: "3" }, "3학점"),
    el("option", { value: "4+" }, "4학점 이상"))));
  grid.append(labeled("강의실", el("input", { type: "text", name: "roomFilter", id: "roomFilter", placeholder: "예: 38 또는 38-422" })));
  adv.append(grid);

  adv.append(el("div", { className: "adv-label" }, "과정"));
  adv.append(el("div", { className: "chips", id: "levelChips" }));
  adv.append(el("div", { className: "adv-label" }, "이수구분"));
  adv.append(el("div", { className: "chips", id: "typeChips" }));
  adv.append(el("div", { className: "adv-label" }, "학년"));
  adv.append(el("div", { className: "chips", id: "gradeChips" }));

  const empty = el("input", { type: "checkbox", id: "emptyOnly" });   // only classes that fit the free slots
  const timed = el("input", { type: "checkbox", id: "timedOnly" });   // only classes with a scheduled time
  const eng = el("input", { type: "checkbox", id: "englishOnly" });   // only 영어강의
  adv.append(el("div", { className: "adv-checks" },
    el("label", {}, empty, " 빈 시간만"),
    el("label", {}, timed, " 시간 배정만"),
    el("label", {}, eng, " 영어강의만")));
  form.append(adv);

  form.append(el("button", { type: "submit", className: "primary" }, "검색 Search"));
}
// multi-select chip row: click toggles .on; currentFilters reads the selected set
function fillChips(containerId, tokens, labelOf = (t) => t) {
  const box = $("#" + containerId); if (!box) return;
  box.replaceChildren();
  tokens.forEach((t) => {
    const chip = el("span", { className: "chip-tog" }, labelOf(t));
    chip.dataset.value = t;
    chip.addEventListener("click", () => chip.classList.toggle("on"));
    box.append(chip);
  });
}
// smooth open/close of the advanced filters. A forced reflow commits the start
// value so the max-height transition runs; once open, the clamp is dropped
// (.open -> max-height:none) so the content can reflow (e.g. chips wrapping).
function setAdvancedOpen(open) {
  const adv = $("#advFilters"); if (!adv) return;
  $("#filterToggle").textContent = open ? "간단히" : "상세 검색";
  if (open) {
    adv.classList.add("open");
    adv.style.maxHeight = "0px";
    void adv.offsetHeight;
    adv.style.maxHeight = adv.scrollHeight + "px";
    const done = (e) => {
      if (e.propertyName !== "max-height") return;
      adv.style.maxHeight = "";   // fall back to .open { max-height:none }
      adv.removeEventListener("transitionend", done);
    };
    adv.addEventListener("transitionend", done);
    setTimeout(() => { adv.style.maxHeight = ""; }, 350);   // fallback if no transitionend
  } else {
    adv.style.maxHeight = adv.scrollHeight + "px";   // from auto -> explicit, so 0 animates
    void adv.offsetHeight;
    adv.classList.remove("open");
    adv.style.maxHeight = "0px";
  }
}

// ---------- init ----------
function fillSelects() {
  const year = $("#year");
  year.append(el("option", { value: "" }, "전체 All"));
  const term = $("#term");
  term.append(el("option", { value: "" }, "전체 All"));
  const day = $("#day");
  day.append(el("option", { value: "" }, "전체 All"));
  DAYS.forEach((d, i) => day.append(el("option", { value: i }, `${d} ${DAY_EN[i]}`)));
  const period = $("#period");
  period.append(el("option", { value: "" }, "전체 All"));
  PERIODS.forEach((p) => period.append(
    el("option", { value: p }, `${p}교시 (${periodLabel(p)}:00~)`)));
  const rt = $("#refreshTerm");        // admin panel — absent on a production page
  if (rt) {
    rt.append(el("option", { value: "" }, "전체 All"));
    ADMIN_TERMS.forEach((t) => rt.append(el("option", { value: t.code }, t.label)));
  }
  const ct = $("#cntTerm");            // 인원 추이 collection panel (admin only)
  if (ct) {
    ct.append(el("option", { value: "" }, "전체 All"));
    ADMIN_TERMS.forEach((t) => ct.append(el("option", { value: t.code }, t.label)));
  }
  const md = $("#mDay");
  DAYS.forEach((d, i) => md.append(el("option", { value: i }, `${d} ${DAY_EN[i]}`)));
}

async function loadTerms() {
  const { terms } = await dataIndex();
  const yearSel = $("#year"), termSel = $("#term");
  [...new Set(terms.map((t) => t.year))].sort().reverse()
    .forEach((y) => yearSel.append(el("option", { value: y }, y)));
  const seen = new Set();
  terms.forEach((t) => {
    if (seen.has(t.term)) return;
    seen.add(t.term);
    termSel.append(el("option", { value: t.term }, SEMESTER_LABEL[t.term] || t.term));
  });
  applySearchDefaults();
  migrateSemesters();                       // backfill sems + default cur now that catalog is loaded
  const [cy, ct] = String(meta.cur || "").split("|");
  if (cy && $("#year")) $("#year").value = cy;     // toggle is the source of truth for scope
  if (ct && $("#term")) $("#term").value = ct;
  updateScope();
  renderSheets();                           // re-render now that sems/cur are known
}

// config.js: map a friendly term default (1학기 / spring / code) to a term code
const TERM_ALIASES = {
  "1학기": "U000200001U000300001", "spring": "U000200001U000300001", "1": "U000200001U000300001",
  "2학기": "U000200002U000300001", "fall": "U000200002U000300001", "2": "U000200002U000300001",
  "여름": "U000200001U000300002", "여름학기": "U000200001U000300002", "summer": "U000200001U000300002",
  "겨울": "U000200002U000300002", "겨울학기": "U000200002U000300002", "winter": "U000200002U000300002",
};
function resolveTermDefault(v) {
  v = (v || "").toString().trim();
  if (!v) return "";
  if (SEMESTER_LABEL[v]) return v;                 // already a raw code
  return TERM_ALIASES[v.toLowerCase()] || "";
}
// apply config defaults to the year/term selects (only if that option exists)
function applySearchDefaults() {
  const yEl = $("#year"), tEl = $("#term");
  const y = (window.SEARCH_DEFAULT_YEAR || "").toString().trim();
  if (y && yEl && [...yEl.options].some((o) => o.value === y)) yEl.value = y;
  const t = resolveTermDefault(window.SEARCH_DEFAULT_TERM);
  if (t && tEl && [...tEl.options].some((o) => o.value === t)) tEl.value = t;
}

async function loadDepartments() {
  try {
    const { departments } = await dataIndex();
    const dl = $("#deptList");
    dl.replaceChildren();
    departments.forEach((d) => dl.append(el("option", { value: d })));
  } catch { /* autocomplete is optional; free-text search still works */ }
}

// 과정 (level) and 이수구분 (type) come from the same classification list; LEVELS
// marks which tokens are "과정" so currentFilters can split the selected chips.
const LEVELS = ["학사", "대학원", "석박사통합", "석사", "박사"];
async function loadClassifications() {
  try {
    const { classifications } = await dataIndex();
    fillChips("levelChips", classifications.filter((t) => LEVELS.includes(t)));    // 과정
    fillChips("typeChips", classifications.filter((t) => !LEVELS.includes(t)));    // 이수구분
  } catch { /* classification filters optional */ }
}

// 학년: raw '0' means 전학년 (no grade restriction); show it readably.
// 5·6년제(건축·약학) 5/6학년은 검색 칩에서 "5+학년" 하나로 묶는다(소수 과목).
const gradeBucket = (g) => {
  const s = String(g ?? "");
  return s === "5학년" || s === "6" || s === "6학년" ? "5+학년" : s;
};
const gradeLabel = (g) => {
  if (g === "0") return "전학년 All-yr";
  if (g === "6") return "6학년";   // 약학 6년제: 원본은 접미사 없는 '6'
  return g;
};
async function loadGrades() {
  try {
    const { grades } = await dataIndex();
    const seen = new Set();
    const bucketed = grades.reduce((acc, g) => {
      const b = gradeBucket(g);
      if (!seen.has(b)) { seen.add(b); acc.push(b); }
      return acc;
    }, []);
    fillChips("gradeChips", bucketed, gradeLabel);
  } catch { /* grade filter optional */ }
}

async function loadStatus() {
  if (!$("#status")) return;   // status line is dev-only (absent on the production page)
  try {
    const s = await api("/api/status");
    const c = s.counts;
    let txt = `강좌 ${c.classes} · 시간셀 ${c.slots} · 학기 ${c.terms}`;
    if (s.backend) txt += ` · DB ${s.backend}`;
    if (s.last_run && s.last_run.finished_at)
      txt += ` · 최근 갱신 ${s.last_run.finished_at} (${s.last_run.status})`;
    $("#status").textContent = txt;
    return s;
  } catch {
    // no backend (static host): summarise from the data index instead
    try {
      const { terms } = await dataIndex();
      const total = terms.reduce((n, t) => n + (t.count || 0), 0);
      $("#status").textContent = `강좌 ${total} · 학기 ${terms.length}`;
    } catch { $("#status").textContent = "—"; }
  }
}

// ---------- time-assigned % ----------
let timeStats = [];
async function loadTimeStats() {
  if (!$("#statTerm")) return;   // stats panel — absent on a production page
  try {
    const { stats } = await api("/api/timestats");
    timeStats = stats || [];
    const ysel = $("#statYear"), tsel = $("#statTerm");
    const keepY = ysel.value, keepT = tsel.value;
    ysel.replaceChildren(); tsel.replaceChildren();
    ysel.append(el("option", { value: "" }, "전체 All"));
    tsel.append(el("option", { value: "" }, "전체 All"));
    [...new Set(timeStats.map((s) => s.year))].sort().reverse()
      .forEach((y) => ysel.append(el("option", { value: y }, y)));
    const seen = new Set();
    timeStats.forEach((s) => {
      if (seen.has(s.term)) return;
      seen.add(s.term);
      tsel.append(el("option", { value: s.term }, SEMESTER_LABEL[s.term] || s.term));
    });
    ysel.value = keepY; tsel.value = keepT;  // preserve selection across reloads
    ysel.onchange = tsel.onchange = renderTimeStat;
    renderTimeStat();
  } catch { /* stats optional */ }
}
function renderTimeStat() {
  const yEl = $("#statYear"), tEl = $("#statTerm");
  if (!yEl || !tEl) return;   // stats panel absent
  const yv = yEl.value, tv = tEl.value;  // "" = all
  let total = 0, timed = 0;
  for (const s of timeStats) {
    if ((!yv || s.year === yv) && (!tv || s.term === tv)) {
      total += s.total; timed += s.timed;
    }
  }
  const pct = total ? (timed / total) * 100 : 0;
  $("#statPct").textContent = total ? pct.toFixed(1) + "%" : "데이터 없음";
  $("#statBar").style.width = pct + "%";
  $("#statDetail").textContent = total
    ? `시간 있음 ${timed} · 시간미정 ${total - timed} · 전체 ${total}`
    : "DB를 새로고침하세요";
}

// ---------- search (client-side over the JSON data layer) ----------
const PAGE_SIZE = 100;
let searchOffset = 0, searchTotal = 0;
let lastFilters = null;   // null until a search runs; what export reuses

function currentFilters() {
  const f = $("#searchForm");
  const val = (n) => f.elements[n].value.trim();
  const chipVals = (id) => [...$$(`#${id} .chip-tog.on`)].map((c) => c.dataset.value);
  const num = (n) => { const v = val(n); return v === "" ? null : Number(v); };
  return {
    year: val("year") || null, term: val("term") || null,
    name: val("name"), professor: val("professor"), department: val("department"),
    classifications: chipVals("typeChips"),   // 이수구분 (전선/전필/교양…)
    levels: chipVals("levelChips"),            // 과정 (학사/석사/박사…)
    grades: chipVals("gradeChips"),
    day: num("day"), period: num("period"),
    credits: (() => { const v = val("credits"); return v === "" ? null : (v === "4+" ? "4+" : Number(v)); })(),
    room: val("roomFilter"),
    englishOnly: $("#englishOnly")?.checked || false,
    emptyOnly: $("#emptyOnly")?.checked || false,
    timedOnly: $("#timedOnly")?.checked || false,
  };
}

async function doSearch(e) {
  if (e) e.preventDefault();
  searchOffset = 0;
  lastFilters = currentFilters();
  $("#resultCount").textContent = "검색 중…";
  const data = await searchLocal(lastFilters, { limit: PAGE_SIZE, offset: 0 });
  searchTotal = data.total;
  renderResults(data.classes, false);
  updateResultMeta();
  updateScope();
}

// header scope line: "2026 여름학기 · 357개 강좌" for the searched year/term
function updateScope() {
  const info = $("#scopeInfo"); if (!info || !_dataIndex) return;
  const y = $("#year")?.value, t = $("#term")?.value, terms = _dataIndex.terms;
  let m;
  if (y && t) m = terms.find((x) => x.year === y && x.term === t);
  else if (t) m = terms.find((x) => x.term === t);
  else if (y) m = terms.find((x) => x.year === y);
  m = m || terms[0];
  info.textContent = m ? `${m.label} · ${(m.count || 0).toLocaleString()}개 강좌` : "";
}

async function loadMore() {
  searchOffset += PAGE_SIZE;
  const data = await searchLocal(lastFilters, { limit: PAGE_SIZE, offset: searchOffset });
  renderResults(data.classes, true);
  updateResultMeta();
}

function updateResultMeta() {
  const loaded = lastResults.length;
  $("#resultCount").textContent = `${loaded} / ${searchTotal}건 검색됨`;
  $("#loadMore").classList.toggle("hidden", loaded >= searchTotal);
}

// export the full filtered result set, built client-side (no backend needed)
async function exportSearch(fmt) {
  if (lastFilters === null) {
    alert("먼저 강좌를 검색하세요. 검색한 결과만 내보낼 수 있습니다.");
    return;
  }
  if (searchTotal === 0) { alert("검색 결과가 없습니다."); return; }
  const { classes } = await searchLocal(lastFilters, { limit: null });
  if (fmt === "csv") {
    downloadBlob(new Blob(["﻿" + rowsToCsv(classes)],
      { type: "text/csv;charset=utf-8" }), "classes.csv");
  } else {
    await rowsToXlsx(classes);
  }
}

let lastResults = [];
function renderResults(classes, append = false) {
  const ul = $("#results");
  if (!append) { ul.replaceChildren(); lastResults = []; }
  lastResults = lastResults.concat(classes);
  const inTT = new Set(timetable.map(classKey));
  for (const c of classes) {
    const added = inTT.has(classKey(c));
    const times = slotSummary(c.slots);
    const sem = `${c.year || ""} ${(SEMESTER_LABEL[c.term] || c.term || "").split(" ")[0]}`.trim();
    let seats = "";
    if (c.applied != null && c.quota != null) {
      seats = ` · 정원 ${c.applied}/${c.quota}`;
      if (c.quota_returning != null)   // 재학생/신입생 split, same as the detail drawer
        seats += ` (재학생 ${c.quota_returning}·신입생 ${(c.quota ?? 0) - c.quota_returning})`;
    }
    const card = el("li", { className: "rcard" });
    card.addEventListener("click", () => openDetail(c));        // open the detail drawer
    card.addEventListener("mouseenter", () => startHoverPreview(c));
    card.addEventListener("mouseleave", cancelHoverPreview);
    const bar = el("span", { className: "rbar" }); bar.style.background = colorFor(c);
    const addBtn = el("button", {
      className: "radd" + (added ? " added" : ""), textContent: added ? "✓" : "담기",
      onclick: (e) => { e.stopPropagation(); added ? removeFromTT(c) : addToTT(c); },
    });
    const wished = inWish(c);
    const wishBtn = el("button", {
      className: "rwish" + (wished ? " on" : ""), textContent: wished ? "★" : "☆",
      title: wished ? "찜 해제" : "찜하기",
      onclick: (e) => { e.stopPropagation(); toggleWish(c); },
    });
    const tags = [];
    if (c.language === "영어") tags.push(el("span", { className: "rtag eng" }, "영어"));
    if (c.status === "폐강대상") tags.push(el("span", { className: "rtag warn" }, "폐강대상"));
    card.append(bar,
      el("div", { className: "rbody" },
        el("div", { className: "rname" }, c.name, ...tags),
        el("div", { className: "rmeta" },
          `${sem ? sem + " · " : ""}${c.professor || "미정"} · ${c.department || "-"} · ${c.credits ?? "?"}학점${c.room ? " · " + c.room : ""}${seats}`),
        el("div", { className: "rtime" }, times.length ? times.join("  ·  ") : "시간미정")),
      wishBtn, addBtn);
    ul.append(card);
  }
}

// "월 09:00~10:15" chips from exact slots (dedupe identical times within a day)
function slotSummary(slots) {
  const byDay = new Map();
  for (const s of slots || []) {
    if (s.day_index == null || !s.start_time) continue;
    if (!byDay.has(s.day_index)) byDay.set(s.day_index, new Set());
    byDay.get(s.day_index).add(`${s.start_time}~${s.end_time || ""}`);
  }
  const out = [];
  for (const [d, set] of [...byDay.entries()].sort((a, b) => a[0] - b[0]))
    out.push(`${DAYS[d]} ${[...set].join(", ")}`);
  return out;
}

// ---------- timetable sheets ----------
// ---------- timetable sheets (id-keyed; per-sheet storage + LRU memory) ----------
// function declarations (hoisted) so the early `let timetable = initSheets()` can call them
function activeId() { return meta.active >= 0 ? meta.ids[meta.active] : null; }
function _sheetKey(id) { return SHEET_PREFIX + id; }
function _readSheet(id) {
  try { const a = JSON.parse(localStorage.getItem(_sheetKey(id))); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function _onQuota(e) {                       // surface a full localStorage instead of silent data loss
  console.error("localStorage write failed (quota?)", e);
  if (!_quotaWarned) {
    _quotaWarned = true;
    alert("저장 공간이 가득 찼습니다. 새로 추가한 시간표가 저장되지 않을 수 있습니다. 사용하지 않는 시간표를 삭제해 주세요.");
  }
}
function _writeSheet(id, classes) {
  try { localStorage.setItem(_sheetKey(id), JSON.stringify(classes)); _quotaWarned = false; }
  catch (e) { _onQuota(e); }
}
// metadata write is rAF-coalesced: a bulk add/deleteSheet loop mutates `meta` many times
// per frame but persists ONCE. Was O(n²) — re-serializing the whole growing meta on every
// op. `meta` in memory is always authoritative; only the write to disk is deferred.
function _saveMetaNow() {
  _metaRaf = 0;
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); _quotaWarned = false; }
  catch (e) { _onQuota(e); }
}
function _saveMeta() { if (!_metaRaf) _metaRaf = requestAnimationFrame(_saveMetaNow); }
function flushMeta() { if (_metaRaf) { cancelAnimationFrame(_metaRaf); _saveMetaNow(); } }
// LRU: bring a sheet's classes into memory (most-recent), flushing+dropping the
// least-recently-used ones beyond MAX_LIVE_SHEETS (never the active sheet).
function _loadSheet(id) {
  if (liveSheets.has(id)) { const v = liveSheets.get(id); liveSheets.delete(id); liveSheets.set(id, v); return v; }
  const classes = _readSheet(id);
  liveSheets.set(id, classes);
  _evict();
  return classes;
}
function _evict() {
  for (const id of [...liveSheets.keys()]) {
    if (liveSheets.size <= MAX_LIVE_SHEETS) break;
    if (id === activeId()) continue;
    _writeSheet(id, liveSheets.get(id));   // flush before dropping from memory
    liveSheets.delete(id);
  }
}

function initSheets() {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY));
    if (m && Array.isArray(m.ids) && m.ids.length) {
      meta = { active: Math.min(Math.max(0, m.active | 0), m.ids.length - 1),
               ids: m.ids, names: m.names || {}, counts: m.counts || {}, seen: m.seen || {},
               nextId: m.nextId || (m.ids.reduce((mx, x) => (x > mx ? x : mx), 0) + 1),
               cur: m.cur || null, sems: m.sems || {} };
      return _loadSheet(activeId());
    }
  } catch { /* fall through to migrate */ }
  // migrate v1 (all sheets in one key) or the legacy single timetable -> per-sheet
  meta = { active: 0, ids: [], names: {}, counts: {}, nextId: 1, seen: {}, cur: null, sems: {} };
  let v1 = null;
  try { v1 = JSON.parse(localStorage.getItem(SHEETS_KEY)); } catch { /* none */ }
  if (v1 && Array.isArray(v1.sheets) && v1.sheets.length) {
    v1.sheets.forEach((s, i) => {
      const id = meta.nextId++; meta.ids.push(id);
      meta.names[id] = s.name || `시간표 ${i + 1}`;
      const cls = s.classes || []; meta.counts[id] = cls.length; _writeSheet(id, cls);
    });
    meta.active = Math.min(Math.max(0, v1.active | 0), meta.ids.length - 1);
  } else {
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(TT_KEY)) || []; } catch { /* none */ }
    const id = meta.nextId++; meta.ids = [id]; meta.names[id] = "시간표 1";
    meta.counts[id] = legacy.length; _writeSheet(id, legacy);
  }
  _saveMeta();
  return _loadSheet(activeId());
}
function saveTT() {
  const id = activeId();
  if (id == null) return;               // no active sheet (empty group) — nothing to persist
  liveSheets.set(id, timetable);        // keep the active array in the cache
  meta.counts[id] = timetable.length;
  _writeSheet(id, timetable);           // O(active sheet) — not every sheet
  _saveMeta();
}
function switchSheet(i) {
  if (i === meta.active || i < 0 || i >= meta.ids.length) return;
  saveTT();
  meta.active = i; timetable = _loadSheet(activeId());
  _saveMeta(); renderSheets(); renderTT(); refreshCardStates(); updateUndoButtons();
}
function addSheet() {
  if (meta.ids.length >= MAX_SHEETS) {
    alert(`시간표는 최대 ${MAX_SHEETS}개까지 만들 수 있습니다. 사용하지 않는 시간표를 삭제해 주세요.`);
    return;
  }
  saveTT();
  if (meta.cur == null) meta.cur = defaultSemester();      // defensive: should be set at init
  const id = meta.nextId++;
  const n = meta.ids.filter((x) => meta.sems[x] === meta.cur).length + 1;  // Nth sheet *in this group*
  meta.ids.push(id);
  meta.sems[id] = meta.cur;
  meta.names[id] = `시간표 ${n}`; meta.counts[id] = 0;
  meta.active = meta.ids.length - 1;
  timetable = []; liveSheets.set(id, timetable); _evict();
  _writeSheet(id, timetable); _saveMeta();
  renderSheets(); renderTT(); refreshCardStates();
}
// remove a set of sheet ids in ONE O(n) pass (not repeated O(n) splices -> O(n²)).
// Callers must keep the active sheet out of idSet, so at least one sheet always remains.
function _removeSheets(idSet) {
  const keptActive = activeId();            // survives unless this delete includes the active sheet
  meta.ids = meta.ids.filter((id) => !idSet.has(id));
  for (const id of idSet) {
    delete meta.names[id]; delete meta.counts[id]; delete meta.sems[id];
    liveSheets.delete(id);
    if (meta.seen) delete meta.seen[id];
    delete _sheetChanges[id];
    try { localStorage.removeItem(_sheetKey(id)); } catch { /* ignore */ }
  }
  const ai = meta.ids.indexOf(keptActive);  // >=0 when the active sheet survived
  if (ai >= 0) {
    meta.active = ai;
  } else {
    // active was deleted: prefer a surviving sheet in the current semester group, else none
    const next = meta.ids.find((id) => meta.sems[id] === meta.cur);
    meta.active = next != null ? meta.ids.indexOf(next) : -1;
  }
  timetable = meta.active >= 0 ? _loadSheet(activeId()) : [];
  _saveMeta(); renderSheets(); renderTT(); refreshCardStates();
}
function deleteSheet(i) {
  const id = meta.ids[i];
  if (id == null) return;
  if (!confirm(`'${meta.names[id]}' 시간표를 삭제할까요?`)) return;
  _removeSheets(new Set([id]));
}
// delete many sheets with a SINGLE confirm (vs one dialog per call). Never deletes the
// active sheet, so one always remains. `ids` omitted/empty = all sheets but the active one.
function deleteSheetsBulk(ids, { confirm: ask = true } = {}) {
  const active = activeId();
  const pool = (ids && ids.length ? ids : meta.ids).filter((id) => id !== active && meta.names[id] != null);
  const set = new Set(pool);
  if (!set.size) return;
  if (ask && !confirm(`${set.size}개 시간표를 삭제할까요? (현재 시간표는 유지됩니다)`)) return;
  _removeSheets(set);
}
function renameSheet(i) {
  const id = meta.ids[i];
  const name = (prompt("시간표 이름:", meta.names[id]) || "").trim();
  if (!name) return;
  meta.names[id] = name; _saveMeta(); renderSheets();
}
// rAF-coalesced: many mutations in one frame (e.g. a bulk addSheet loop) collapse
// into ONE rebuild instead of O(n²) rebuilds.
let _sheetsRaf = 0;
function renderSheets() {
  if (_sheetsRaf) return;
  _sheetsRaf = requestAnimationFrame(() => { _sheetsRaf = 0; renderSheetsNow(); });
}
function _buildTab(id, i) {               // one tab node (metadata-only)
  const tab = el("div", {
    className: "tt-sheet" + (i === meta.active ? " active" : ""),
    title: i === meta.active ? "클릭하여 이름 변경" : "클릭하여 전환",
    onclick: () => (i === meta.active ? renameSheet(i) : switchSheet(i)),
  },
    el("span", {}, meta.names[id] || "시간표"),
    el("span", { className: "sheet-count" }, String(meta.counts[id] ?? 0)));
  const chg = _sheetChanges[id];
  if (chg) tab.append(el("span", { className: "sheet-chg", title: `변경 ${chg.chg.length + chg.rm.length}건` }, "●"));
  if (i === meta.active) tab.append(el("span", { className: "sheet-pen", title: "이름 변경" }, "✎"));
  tab.append(el("span", {
    className: "sheet-x", title: "삭제",
    onclick: (e) => { e.stopPropagation(); deleteSheet(i); },
  }, "×"));
  return tab;
}
// past SHEET_TAB_LIMIT a tab strip is unusable + huge — switch to a compact picker
function _buildSheetPicker(group) {
  const sel = el("select", { className: "sheet-select",
    onchange: (e) => switchSheet(Number(e.target.value)) });
  group.forEach(({ id, i }) => {
    const o = el("option", { value: String(i) },
      `${meta.names[id] || "시간표"} (${meta.counts[id] ?? 0})${_sheetChanges[id] ? " ⚠" : ""}`);
    if (i === meta.active) o.selected = true;
    sel.append(o);
  });
  return el("div", { className: "sheet-picker" },
    sel,
    el("button", { type: "button", className: "sheet-mini", title: "이름 변경",
      onclick: () => renameSheet(meta.active) }, "✎"),
    el("button", { type: "button", className: "sheet-mini", title: "삭제",
      onclick: () => deleteSheet(meta.active) }, "×"),
    el("span", { className: "sheet-total" }, `${group.length}개`));
}
function _buildSemToggle() {
  const sel = el("select", {
    className: "sem-toggle", title: "학기 전환",
    onchange: (e) => switchSemester(e.target.value),
  });
  for (const key of availableSemesters()) {
    const o = el("option", { value: key }, semLabel(key));
    if (key === meta.cur) o.selected = true;
    sel.append(o);
  }
  return sel;
}
function switchSemester(key) {
  if (!key || key === meta.cur) return;
  saveTT();
  meta.cur = key;
  const [y, t] = key.split("|");
  if ($("#year")) $("#year").value = y;          // sync search scope to the toggle…
  if ($("#term")) $("#term").value = t;          // …user may change it again afterward
  const idx = meta.ids.findIndex((id) => meta.sems[id] === key);   // first sheet of this group
  meta.active = idx;                              // -1 when the group is empty
  timetable = idx >= 0 ? _loadSheet(activeId()) : [];
  _saveMeta();
  renderSheets(); renderTT(); refreshCardStates(); updateUndoButtons();
  doSearch();                                     // re-run search for the new year/term
}
function renderSheetsNow() {
  const box = $("#ttSheets"); if (!box) return;
  box.replaceChildren();
  const group = meta.ids
    .map((id, i) => ({ id, i }))
    .filter((x) => meta.sems[x.id] === meta.cur);    // only sheets of the current semester
  if (group.length > SHEET_TAB_LIMIT) box.append(_buildSheetPicker(group));
  else group.forEach(({ id, i }) => box.append(_buildTab(id, i)));
  box.append(el("div", { className: "tt-sheet add", title: "시간표 추가", onclick: addSheet }, "＋ 시간표 추가"));
  box.append(_buildSemToggle());
  updateHero();
}

// hero header: active sheet name + class count (credit total is set in renderTT)
function updateHero() {
  const id = activeId();
  if (id == null) {
    if ($("#activeName")) $("#activeName").textContent = "시간표 없음";
    if ($("#activeSub")) $("#activeSub").textContent = "＋ 시간표 추가로 시작하세요";
    return;
  }
  const n = meta.counts[id] ?? (timetable ? timetable.length : 0);
  if ($("#activeName")) $("#activeName").textContent = (meta.names[id] || "시간표");
  if ($("#activeSub")) $("#activeSub").textContent = n ? `${n}개 강좌` : "비어 있음";
}

function addToTT(c) {
  if (meta.active < 0) addSheet();          // empty group: create "시간표 1" under the current semester
  if (timetable.some((x) => classKey(x) === classKey(c))) return;
  if ($("#blockOverlap")?.checked && overlapsBusy(c, timetableBusy())) {
    alert("이미 추가된 강좌와 시간이 겹쳐 추가하지 않았습니다.");
    return;
  }
  const sheetSem = meta.sems[activeId()];   // semester this timetable belongs to
  if (sheetSem && semKey(c) !== sheetSem &&
      !confirm(`이 강좌는 ${semLabel(sheetSem)} 강좌가 아닙니다. 추가할까요?`)) return;
  pushUndo();
  timetable.push({
    year: c.year, term: c.term, name: c.name, sbjt_cd: c.sbjt_cd, lt_no: c.lt_no,
    professor: c.professor, credits: c.credits, slots: c.slots || [],
    manual: c.manual || undefined,
  });
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
  if (detailClass) renderDetail();
}

// a manual entry isn't in the catalog; give it a unique key and the manual flag
// so reconcileTT leaves it alone (won't flag it cancelled).
function addManual(e) {
  if (e) e.preventDefault();
  const name = $("#mName").value.trim();
  if (!name) return;
  const di = $("#mDay").value, st = $("#mStart").value, en = $("#mEnd").value;
  const slots = (di !== "" && st && en)
    ? [{ day_index: Number(di), period: Math.max(0, +st.slice(0, 2) - 8),
         start_time: st, end_time: en }]
    : [];
  const cr = $("#mCredits").value.trim();
  addToTT({
    year: "", term: "MANUAL", sbjt_cd: "M" + Date.now().toString(36),
    lt_no: String(Math.floor(Math.random() * 1e6)), name,
    professor: $("#mProf").value.trim(),
    credits: cr === "" ? null : Number(cr), slots, manual: true,
  });
  $("#manualForm").reset();
  $("#manualForm").classList.add("hidden");
}
function removeFromTT(c) {
  pushUndo();
  timetable = timetable.filter((x) => classKey(x) !== classKey(c));
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
  if (detailClass) renderDetail();
}
function clearTT() {
  if (!timetable.length) return;
  if (!confirm("이 시간표를 비울까요?")) return;
  pushUndo();
  timetable = []; saveTT(); renderSheets(); renderTT(); refreshCardStates();
  if (detailClass) renderDetail();
}
let _cardsRaf = 0;
function refreshCardStates() {               // rAF-coalesced (mirror renderSheets)
  if (_cardsRaf) return;
  _cardsRaf = requestAnimationFrame(() => { _cardsRaf = 0; refreshCardStatesNow(); });
}
function refreshCardStatesNow() {
  if (lastResults.length) renderResults(lastResults);
  renderWishlist();
}

// ---------- wishlist (bookmarked courses, separate from any sheet) ----------
function _loadWishlist() {
  try { const a = JSON.parse(localStorage.getItem(WISHLIST_KEY)); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveWishlist() {
  try { localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist)); _quotaWarned = false; }
  catch (e) { _onQuota(e); }
}
function inWish(c) { const k = classKey(c); return wishlist.some((x) => classKey(x) === k); }
function toggleWish(c) {
  const k = classKey(c);
  if (inWish(c)) wishlist = wishlist.filter((x) => classKey(x) !== k);
  else wishlist.push({ year: c.year, term: c.term, name: c.name, sbjt_cd: c.sbjt_cd, lt_no: c.lt_no,
    professor: c.professor, credits: c.credits, slots: c.slots || [], manual: c.manual || undefined });
  saveWishlist(); renderWishlist(); refreshCardStates();
}
function renderWishlist() {
  const cnt = $("#wishCount"); if (cnt) cnt.textContent = String(wishlist.length);
  const panel = $("#wishPanel"); if (!panel || panel.classList.contains("hidden")) return;
  if (!wishlist.length) {
    panel.replaceChildren(el("div", { className: "wish-empty" }, "찜한 강좌가 없습니다. 검색 결과의 ☆를 눌러 저장하세요."));
    return;
  }
  const inTT = new Set(timetable.map(classKey));
  panel.replaceChildren(...wishlist.map((c) => {
    const added = inTT.has(classKey(c));
    const bar = el("span", { className: "wbar" }); bar.style.background = colorFor(c);
    return el("div", { className: "wish-item" }, bar,
      el("div", { className: "wbody" },
        el("div", { className: "wname" }, c.name),
        el("div", { className: "wmeta" }, `${c.professor || "미정"} · ${c.credits ?? "?"}학점 · ${slotSummary(c.slots).join(", ") || "시간미정"}`)),
      el("button", { className: "wadd" + (added ? " added" : ""), disabled: added,
        title: added ? "이미 추가됨" : "시간표에 추가", onclick: () => addToTT(c) }, added ? "✓" : "담기"),
      el("button", { className: "wdel", title: "찜 해제", onclick: () => toggleWish(c) }, "✕"));
  }));
}
function toggleWishPanel() {
  const p = $("#wishPanel"); if (!p) return;
  const open = !p.classList.toggle("hidden");
  $("#wishToggle")?.classList.toggle("on", open);
  if (open) renderWishlist();
}

// ---------- undo / redo (per active sheet, in-memory) ----------
function _snapTT() { return JSON.stringify(timetable); }
function pushUndo() {
  const id = activeId();
  (_undo[id] || (_undo[id] = [])).push(_snapTT());
  if (_undo[id].length > 100) _undo[id].shift();
  _redo[id] = [];
  updateUndoButtons();
}
function _applySnapshot(json) {
  timetable = JSON.parse(json);
  liveSheets.set(activeId(), timetable);
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
  if (detailClass) renderDetail();
  updateUndoButtons();
}
function undo() {
  const id = activeId(), st = _undo[id];
  if (!st || !st.length) return;
  (_redo[id] || (_redo[id] = [])).push(_snapTT());
  _applySnapshot(st.pop());
}
function redo() {
  const id = activeId(), st = _redo[id];
  if (!st || !st.length) return;
  (_undo[id] || (_undo[id] = [])).push(_snapTT());
  _applySnapshot(st.pop());
}
function updateUndoButtons() {
  const id = activeId(), u = $("#undoBtn"), r = $("#redoBtn");
  if (u) u.disabled = !(_undo[id] && _undo[id].length);
  if (r) r.disabled = !(_redo[id] && _redo[id].length);
}

// signature of a class's meeting times, for detecting catalog changes
function slotSig(slots) {
  return (slots || []).map((s) => `${s.day_index}-${s.start_time}`).sort().join("|");
}

// per-sheet change summary from the last reconcile: id -> {chg:[names], rm:[names], sig}
let _sheetChanges = {};
function _nm(c) { return c.name || c.sbjt_cd || "(이름 없음)"; }
function _changeSig(chg, rm) { return "c:" + [...chg].sort().join("§") + ";r:" + [...rm].sort().join("§"); }
// flag one sheet's classes against the latest catalog `cur` (Map keyed by classKey).
// Mutates in place; returns {changed, chg, rm} where chg/rm are the CURRENT flagged names.
function _reconcileClasses(classes, cur) {
  let changed = false;
  for (const c of classes) {
    if (c.manual) continue;               // manual entries aren't in the catalog
    const now = cur.get(classKey(c));
    if (!now) { if (!c.removed) { c.removed = true; changed = true; } continue; }
    if (c.removed) { delete c.removed; changed = true; }
    if (slotSig(c.slots) !== slotSig(now.slots)) { c.slots = now.slots; c.timeChanged = true; changed = true; }
    else if (c.timeChanged) { delete c.timeChanged; changed = true; }
  }
  return { changed, chg: classes.filter((c) => c.timeChanged).map(_nm), rm: classes.filter((c) => c.removed).map(_nm) };
}
// seed the active sheet's summary from already-stored flags so the banner shows instantly
// on load, before the async catalog reconcile resolves.
function _seedActiveChanges() {
  const chg = timetable.filter((c) => c.timeChanged).map(_nm);
  const rm = timetable.filter((c) => c.removed).map(_nm);
  if (chg.length || rm.length) _sheetChanges[activeId()] = { chg, rm, sig: _changeSig(chg, rm) };
  else delete _sheetChanges[activeId()];
}
// reconcile EVERY sheet AND the wishlist against the latest catalog in one pass: one
// catalog scan (lookupLocal is term-batched) + reading each sheet from storage (no LRU
// churn). Best-effort (skips silently if offline).
async function reconcileAll() {
  const ids = meta.ids.slice();
  const aid = activeId();
  const lists = ids.map((id) => (id === aid ? timetable : _readSheet(id)));
  const keys = [];
  for (const list of [...lists, wishlist])   // wishlist shares the same staleness gap
    for (const c of list) if (!c.manual) keys.push([c.year, c.term, c.sbjt_cd, c.lt_no]);
  if (!keys.length) { _sheetChanges = {}; renderSheets(); renderTT(); return; }
  let cur;
  try { cur = new Map((await lookupLocal(keys)).map((c) => [classKey(c), c])); }
  catch { return; }                       // offline: keep saved copies + existing flags
  const next = {};
  ids.forEach((id, i) => {
    const { changed, chg, rm } = _reconcileClasses(lists[i], cur);
    if (chg.length || rm.length) next[id] = { chg, rm, sig: _changeSig(chg, rm) };
    if (changed) { if (id === aid) saveTT(); else _writeSheet(id, lists[i]); }
  });
  _sheetChanges = next;
  if (_reconcileClasses(wishlist, cur).changed) saveWishlist();  // refreshCardStates re-renders it
  renderSheets(); renderTT(); refreshCardStates();
}

// "label N: a, b, 외 K개" chip for one change category
function _chipList(label, names, cls) {
  if (!names.length) return null;
  const cap = 4, shown = names.slice(0, cap).join(", ");
  const extra = names.length > cap ? ` 외 ${names.length - cap}개` : "";
  return el("span", { className: "chg-item " + cls },
    el("b", {}, `${label} ${names.length}`),
    el("span", { className: "chg-names" }, ` ${shown}${extra}`));
}
// itemized + dismissible change banner. Active sheet's changes show until "확인"ed
// (remembered by signature, so only NEW changes re-surface); other changed sheets get
// a jump link.
function renderChangeNotice() {
  const notice = $("#ttNotice"); if (!notice) return;
  const aid = activeId();
  const mine = _sheetChanges[aid];
  const dismissed = mine && (meta.seen || {})[aid] === mine.sig;
  const others = meta.ids.filter((id) => id !== aid && _sheetChanges[id]);
  if ((!mine || dismissed) && !others.length) { notice.replaceChildren(); notice.classList.add("hidden"); return; }
  const kids = [];
  if (mine && !dismissed) {
    const items = [_chipList("시간 변경", mine.chg, "is-chg"), _chipList("폐강", mine.rm, "is-rm")].filter(Boolean);
    kids.push(el("span", { className: "chg-lead" }, "변경된 강좌:"), ...items,
      el("button", { type: "button", className: "chg-dismiss", title: "확인",
        onclick: () => { (meta.seen ||= {})[aid] = mine.sig; _saveMeta(); renderTT(); } }, "확인 ×"));
  }
  if (others.length) {
    const n = others.reduce((s, id) => s + _sheetChanges[id].chg.length + _sheetChanges[id].rm.length, 0);
    kids.push(el("button", { type: "button", className: "chg-others", title: "변경된 다른 시간표로 이동",
      onclick: () => switchSheet(meta.ids.indexOf(others[0])) }, `다른 시간표 ${others.length}개에 변경 ${n}건 →`));
  }
  notice.replaceChildren(...kids);
  notice.classList.remove("hidden");
}

// hover a search result -> show it immediately as a ghost preview on the grid
function startHoverPreview(c) {
  if (hoverPreview === c) return;
  hoverPreview = c; renderTT();
}
function cancelHoverPreview() {
  if (hoverPreview) { hoverPreview = null; renderTT(); }
}

// ---------- course detail drawer ----------
let detailClass = null;
async function openDetail(c) {
  let full = c;
  // a timetable entry is a trimmed snapshot — pull the full catalog row for the
  // detail fields (seats, grade, classification) if they're missing.
  if (c.department === undefined && c.term !== "MANUAL") {
    try {
      const found = (await lookupLocal([[c.year, c.term, c.sbjt_cd, c.lt_no]]))[0];
      if (found) full = found;
    } catch { /* offline: render whatever we have */ }
  }
  detailClass = full;
  renderDetail();
  $("#detailOverlay").classList.remove("hidden");
  $("#detailDrawer").classList.remove("hidden");
}
function closeDetail() {
  detailClass = null;
  $("#detailOverlay").classList.add("hidden");
  $("#detailDrawer").classList.add("hidden");
  $("#detailDrawer").replaceChildren();
}
function renderDetail() {
  const c = detailClass; if (!c) return;
  const drawer = $("#detailDrawer"); drawer.replaceChildren();
  const added = timetable.some((x) => classKey(x) === classKey(c));
  const conflict = !added && overlapsBusy(c, timetableBusy());

  const bar = el("span", { className: "d-bar" }); bar.style.background = colorFor(c);
  const head = el("div", { className: "d-head" },
    el("div", { className: "d-head-row" },
      el("div", { className: "d-title" }, bar, el("h3", {}, c.name)),
      el("button", { className: "d-close", title: "닫기", textContent: "×", onclick: closeDetail })),
    el("div", { className: "d-sub" }, `${c.professor || "미정"} · ${c.department || "-"}`));

  const body = el("div", { className: "d-body" });
  if (conflict) body.append(el("div", { className: "d-conflict" }, "이미 담은 강좌와 시간이 겹칩니다."));

  const grid = el("div", { className: "d-grid" });
  const kv = (k, v) => grid.append(el("span", { className: "k" }, k),
    v && v.nodeType ? v : el("span", {}, String(v)));
  kv("학기", `${c.year || ""} ${(SEMESTER_LABEL[c.term] || c.term || "").split(" ")[0]}`.trim() || "-");
  kv("학점", `${c.credits ?? "?"}학점`);
  kv("학년", gradeLabel(String(c.grade ?? "")) || "-");
  const cls = c.classification || [];
  kv("구분", cls.length
    ? el("div", { className: "d-chips" }, ...cls.map((x) => el("span", { className: "d-chip" }, x)))
    : "-");
  kv("코드", `${c.sbjt_cd || ""}(${c.lt_no || ""})`);
  if (c.room) kv("강의실", c.room);
  body.append(grid);

  const seats = [];
  if (c.quota != null) seats.push(["정원", c.quota]);
  if (c.quota_returning != null) {
    seats.push(["재학생정원", c.quota_returning]);
    if (c.quota != null) seats.push(["신입생정원", c.quota - c.quota_returning]);
  }
  if (c.applied != null) seats.push(["신청", c.applied]);
  if (c.enrolled != null) seats.push(["수강", c.enrolled]);
  body.append(el("div", { className: "d-section" }, "정원"));
  const seatRows = el("div", { className: "d-rows" });
  (seats.length ? seats : [["정원", "-"]]).forEach(([k, v]) =>
    seatRows.append(el("div", { className: "d-row" },
      el("span", {}, k), el("span", { className: "v" }, String(v)))));
  body.append(seatRows);

  const lines = [];
  for (const s of (c.slots || [])) {
    if (s.day_index == null || !s.start_time) continue;
    lines.push([DAYS[s.day_index], `${s.start_time}~${s.end_time || ""}`]);
  }
  body.append(el("div", { className: "d-section" }, "수업 시간"));
  const slotRows = el("div", { className: "d-rows" });
  (lines.length ? lines : [["—", "시간미정"]]).forEach(([d, t]) =>
    slotRows.append(el("div", { className: "d-slot" },
      el("span", { className: "day" }, d), el("span", { className: "time" }, t))));
  body.append(slotRows);

  const foot = el("div", { className: "d-foot" },
    el("button", {
      className: "d-toggle" + (added ? " remove" : ""),
      textContent: added ? "시간표에서 빼기" : "이 시간표에 담기",
      onclick: () => { added ? removeFromTT(c) : addToTT(c); },   // renderDetail re-runs via the mutators
    }));

  drawer.append(head, body, foot);
}

let _ttRaf = 0;
function renderTT() {                         // rAF-coalesced (mirror renderSheets): bulk
  if (_ttRaf) return;                         // sheet ops rebuild the grid ONCE per frame
  _ttRaf = requestAnimationFrame(() => { _ttRaf = 0; renderTTNow(); });
}
function renderTTNow() {
  const grid = $("#ttGrid"); grid.replaceChildren();
  // credits are stored as plain numbers, so the total is a direct sum (null = 0)
  const creditSum = timetable.reduce((s, c) => s + (Number(c.credits) || 0), 0);
  $("#creditSum").textContent = `총 ${creditSum}학점`;

  renderChangeNotice();

  // collect exact meetings (start/end) + time-less classes
  const meetings = [];
  const tba = [];
  let minS = 24 * 60, maxE = 0, maxDay = 4;   // default Mon–Fri; expand if a class lands later
  for (const c of timetable) {
    const sl = (c.slots || []).filter((s) => s.day_index != null && s.start_time && s.end_time);
    if (!sl.length) { tba.push(c); continue; }
    for (const s of sl) {
      const a = toMin(s.start_time), b = toMin(s.end_time);
      if (b <= a) continue;
      meetings.push({ c, day: s.day_index, a, b });
      minS = Math.min(minS, a); maxE = Math.max(maxE, b); maxDay = Math.max(maxDay, s.day_index);
    }
  }
  // hovered search result -> ghost preview meetings (NOT part of the timetable)
  const preview = [];
  if (hoverPreview && !timetable.some((x) => classKey(x) === classKey(hoverPreview))) {
    for (const s of (hoverPreview.slots || [])) {
      if (s.day_index == null || !s.start_time || !s.end_time) continue;
      const a = toMin(s.start_time), b = toMin(s.end_time);
      if (b <= a) continue;
      preview.push({ day: s.day_index, a, b });
      minS = Math.min(minS, a); maxE = Math.max(maxE, b); maxDay = Math.max(maxDay, s.day_index);
    }
  }
  const hasAny = meetings.length || preview.length;
  const dayN = maxDay + 1;
  const startMin = hasAny ? Math.min(9 * 60, Math.floor(minS / 60) * 60) : 9 * 60;
  const endMin = hasAny ? Math.max(18 * 60, Math.ceil(maxE / 60) * 60) : 18 * 60;
  const H = (endMin - startMin) / 60 * HOUR_PX;
  const cols = `44px repeat(${dayN}, minmax(0, 1fr))`;

  // header row (separate + unbordered, matching the design)
  const head = el("div", { className: "ttx-head" });
  head.style.gridTemplateColumns = cols;
  head.append(el("div", {}));
  for (let d = 0; d < dayN; d++)
    head.append(el("div", { className: "ttx-hd" }, DAYS[d],
      el("span", { className: "en" }, DAY_EN[d].toUpperCase())));
  grid.append(head);

  // bordered body grid
  const ttx = el("div", { className: "ttx" });
  ttx.style.gridTemplateColumns = cols;
  const gutter = el("div", { className: "ttx-gutter" });
  gutter.style.height = H + "px";
  for (let m = startMin; m <= endMin; m += 60) {
    const lab = el("div", { className: "ttx-hour" }, hhmm(m));
    lab.style.top = ((m - startMin) / 60 * HOUR_PX) + "px";
    gutter.append(lab);
  }
  ttx.append(gutter);

  // Pack each day first and flag every class that has a clashing meeting, so all
  // of that lecture's boxes get outlined — even the non-overlapping ones on other
  // days/periods — making the conflicting lecture obvious across the whole grid.
  const packedByDay = [];
  const conflictKeys = new Set();
  for (let d = 0; d < dayN; d++) {
    const packed = packDay(meetings.filter((x) => x.day === d));
    packedByDay.push(packed);
    for (const m of packed) if (m.lanes > 1) conflictKeys.add(classKey(m.c));
  }

  const hourCount = (endMin - startMin) / 60;
  for (let d = 0; d < dayN; d++) {
    const col = el("div", { className: "ttx-col" });
    col.style.height = H + "px";
    for (let i = 1; i < hourCount; i++) {   // hour gridlines
      const line = el("div", { className: "ttx-line" });
      line.style.top = (i * HOUR_PX) + "px";
      col.append(line);
    }
    for (const m of packedByDay[d]) {
      const c = m.c, conflict = conflictKeys.has(classKey(c));
      const h = Math.max(20, (m.b - m.a) / 60 * HOUR_PX - 2);
      const b = el("div", {
        className: "ttx-block" + (conflict ? " conflict" : "")
          + (c.timeChanged ? " changed" : "") + (c.removed ? " removed" : ""),
        title: `${c.name}\n${c.professor || "미정"} · ${c.sbjt_cd}(${c.lt_no})`
          + `\n${hhmm(m.a)}~${hhmm(m.b)}`
          + (c.timeChanged ? "\n⚠ 시간 변경됨" : "")
          + (c.removed ? "\n⚠ 폐강/삭제됨" : ""),
      });
      b.style.background = colorFor(c);
      b.style.top = ((m.a - startMin) / 60 * HOUR_PX + 1) + "px";
      b.style.height = h + "px";
      b.style.left = `calc(${m.lane / m.lanes * 100}% + 1px)`;
      b.style.width = `calc(${100 / m.lanes}% - 2px)`;
      b.append(el("div", { className: "b-name" }, c.name));
      if (h > 34) b.append(el("small", {}, `${hhmm(m.a)}~${hhmm(m.b)}`));
      if (h > 52 && c.professor) b.append(el("small", { className: "ttx-prof" }, c.professor));
      b.addEventListener("click", () => openDetail(c));   // open the detail drawer
      col.append(b);
    }
    for (const m of preview.filter((x) => x.day === d)) {
      const pb = el("div", { className: "ttx-block preview",
        title: `${hoverPreview.name} (미리보기)` }, "미리보기");
      pb.style.top = ((m.a - startMin) / 60 * HOUR_PX + 1) + "px";
      pb.style.height = Math.max(20, (m.b - m.a) / 60 * HOUR_PX - 2) + "px";
      pb.style.left = "1px"; pb.style.width = "calc(100% - 2px)";
      col.append(pb);
    }
    ttx.append(col);
  }

  // body wrapper hosts the empty-state overlay over the grid
  const bodyWrap = el("div", {}); bodyWrap.style.position = "relative";
  bodyWrap.append(ttx);
  if (!hasAny)
    bodyWrap.append(el("div", { className: "tt-empty-overlay" },
      el("div", { className: "eo-t" }, "담은 강좌가 없습니다"),
      el("div", { className: "eo-s" }, "왼쪽에서 검색해 시간표를 채워보세요")));
  grid.append(bodyWrap);

  // time-less (TBA) classes — can't be placed on the grid
  const tbaBox = $("#ttTBA");
  if (tbaBox) {
    tbaBox.replaceChildren();
    if (tba.length) {
      tbaBox.append(el("div", { className: "tba-h" }, "시간미정 TBA"));
      for (const c of tba) {
        const chip = el("span", {
          className: "tba-chip" + (c.removed ? " removed" : ""),
          title: `${c.professor || "미정"} · ${c.sbjt_cd}(${c.lt_no})`,
        }, c.name);
        chip.style.borderLeftColor = colorFor(c);
        chip.addEventListener("click", () => openDetail(c));
        tbaBox.append(chip);
      }
    }
  }
  renderTTList();
}

// list of every added entry below the grid, each with a delete button — the
// deliberate way to remove a class (grid clicks intentionally don't delete).
function renderTTList() {
  const box = $("#ttList");
  if (!box) return;
  box.replaceChildren();
  if (!timetable.length) return;
  box.append(el("div", { className: "tt-list-h" }, `담은 강좌 ${timetable.length}`));
  for (const c of timetable) {
    const times = slotSummary(c.slots);
    const meta = (c.professor ? c.professor + " · " : "")
      + (c.credits != null ? c.credits + "학점 · " : "")
      + (times.length ? times.join(", ") : "시간미정 TBA")
      + (c.manual ? " · 직접추가" : "");
    const row = el("div", { className: "tt-li" + (c.removed ? " removed" : "") },
      el("span", { className: "li-dot" }),
      el("div", { className: "li-text", onclick: () => openDetail(c) },
        el("div", { className: "li-name" }, c.name),
        el("div", { className: "li-meta" }, meta)),
      el("button", {
        className: "li-del", title: "삭제", textContent: "×",
        onclick: () => removeFromTT(c),
      }),
    );
    row.querySelector(".li-dot").style.background = colorFor(c);
    box.append(row);
  }
}

// pack a day's meetings into lanes; overlapping ones go side-by-side
function packDay(ms) {
  ms.sort((a, b) => a.a - b.a || a.b - b.b);
  const out = [];
  let group = [], groupEnd = -1;
  const flush = (g) => {
    const laneEnd = [];
    for (const m of g) {
      let lane = laneEnd.findIndex((e) => e <= m.a);
      if (lane < 0) { lane = laneEnd.length; laneEnd.push(m.b); } else laneEnd[lane] = m.b;
      m.lane = lane;
    }
    for (const m of g) { m.lanes = laneEnd.length; out.push(m); }
  };
  for (const m of ms) {
    if (group.length && m.a >= groupEnd) { flush(group); group = []; groupEnd = -1; }
    group.push(m); groupEnd = Math.max(groupEnd, m.b);
  }
  flush(group);
  return out;
}

// ---------- admin refresh ----------
let pollTimer = null;
async function refreshDB() {
  const years = $("#years").value.split(",").map((s) => s.trim()).filter(Boolean);
  const termSel = $("#refreshTerm").value;
  const terms = termSel ? [termSel] : [];   // empty = all terms for the year(s)
  $("#refreshBtn").disabled = true;
  $("#refreshProgress").classList.remove("hidden");
  $("#progressTxt").textContent = "세션 생성 및 크롤링 시작…";
  try {
    await api("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ years, terms }),
    });
  } catch { /* 409 handled below by polling */ }
  pollTimer = setInterval(pollRefresh, 1500);
}

async function pollRefresh() {
  const s = await loadStatus();
  if (!s) return;
  const r = s.refresh || {};
  const p = r.progress || {};
  if (p.slot_total) {
    const pct = Math.round((p.slot_index / p.slot_total) * 100);
    $("#barFill").style.width = pct + "%";
    $("#progressTxt").textContent =
      `${p.label || p.term} · ${p.slot_index}/${p.slot_total} 셀 ` +
      `(${p.slot_label || ""}) · 강좌 ${p.classes_so_far ?? 0}`;
  } else if (p.phase) {
    $("#progressTxt").textContent = `${p.phase}: ${p.label || p.term || ""}`;
  }
  if (!r.running) {
    clearInterval(pollTimer); pollTimer = null;
    $("#refreshBtn").disabled = false;
    $("#barFill").style.width = "100%";
    $("#progressTxt").textContent = r.error
      ? "실패: " + r.error
      : `완료 · 강좌 ${r.result?.classes ?? "?"} · 시간셀 ${r.result?.slots ?? "?"}`;
    doSearch();
    if (!r.error) { reconcileAll(); loadTimeStats(); }  // catalog changed
  }
}

// ---------- 인원 추이 collection (admin) ----------
let cntPoll = null;
async function runCounts(force, confirm = false) {
  const years = $("#cntYears").value.split(",").map((s) => s.trim()).filter(Boolean);
  const tv = $("#cntTerm").value;
  const terms = tv ? [tv] : [];
  $("#cntBtn").disabled = $("#cntForceBtn").disabled = true;
  $("#cntProgress").classList.remove("hidden");
  $("#cntTxt").textContent = "수집 시작…";
  let res = {};
  try {
    res = await api("/api/refresh-counts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ years, terms, force, confirm }),
    });
  } catch { /* 409 etc handled by polling */ }
  if (res && res.needs_confirm) {   // forced re-collect of a 마감 term — ask (default N)
    $("#cntBtn").disabled = $("#cntForceBtn").disabled = false;
    $("#cntProgress").classList.add("hidden");
    const list = (res.closed || []).map((c) => c.join("/")).join(", ");
    if (window.confirm(`이미 마감된 학기: ${list}\n다시 강제 수집할까요? (기본: 아니오)`)) {
      return runCounts(force, true);
    }
    return;
  }
  cntPoll = setInterval(pollCounts, 1500);
}
async function pollCounts() {
  const s = await loadStatus();
  if (!s) return;
  const r = s.counts_refresh || {};
  const p = r.progress || {};
  if (p.slot_total) {
    $("#cntBar").style.width = Math.round((p.slot_index / p.slot_total) * 100) + "%";
    $("#cntTxt").textContent = `${p.label || p.term} · ${p.slot_index}/${p.slot_total}`;
  } else if (p.phase) {
    $("#cntTxt").textContent = `${p.phase}: ${p.label || p.term || ""}`;
  }
  if (!r.running) {
    clearInterval(cntPoll); cntPoll = null;
    $("#cntBtn").disabled = $("#cntForceBtn").disabled = false;
    $("#cntBar").style.width = "100%";
    $("#cntTxt").textContent = r.error
      ? "실패: " + r.error
      : `완료 · 갱신 ${r.result?.updated ?? "?"} · 샘플 ${r.result?.samples ?? "?"}`;
  }
}

// ---------- export / import ----------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Export/import carry only the *connection* to a class (year|term|sbjt_cd|lt_no), never a
// frozen copy of its data. Re-importing rebuilds each entry from the CURRENT catalog, so a
// file exported before a class's time was set (or while it differed) reflects today's time
// on import instead of the stale state captured at export. Manual entries have no catalog
// row to resolve against, so they're carried in full.
function classRef(c) {
  return c.manual ? cleanManual(c)
    : { year: c.year, term: c.term, sbjt_cd: c.sbjt_cd, lt_no: c.lt_no };
}
function cleanManual(c) {
  return { year: c.year ?? "", term: c.term || "MANUAL", name: c.name,
    sbjt_cd: c.sbjt_cd, lt_no: c.lt_no, professor: c.professor,
    credits: c.credits ?? null, slots: c.slots || [], manual: true };
}
// shape a stored entry from a fresh catalog row (mirrors addToTT/toggleWish)
function entryFrom(c) {
  return { year: c.year, term: c.term, name: c.name, sbjt_cd: c.sbjt_cd, lt_no: c.lt_no,
    professor: c.professor, credits: c.credits, slots: c.slots || [] };
}
// label a dropped ref for the import notice. New (connection-only) files carry no name,
// so fall back to the course/section codes; old full-data files still show the name.
function dropLabel(c) { return c.name || `${c.sbjt_cd}-${c.lt_no}`; }
// Rebuild exported entries against today's catalog. Returns {entries, dropped}, where
// dropped lists refs no longer in the catalog (e.g. cancelled — nothing to rebuild from).
// Returns null if the catalog lookup fails (offline) so callers abort without wiping data.
async function resolveEntries(arr) {
  const valid = arr.filter((c) => c && c.sbjt_cd && c.lt_no);
  const refs = valid.filter((c) => !c.manual);
  let cur;
  try {
    cur = new Map((await lookupLocal(refs.map((c) => [c.year, c.term, c.sbjt_cd, c.lt_no])))
      .map((c) => [classKey(c), c]));
  } catch { alert("강좌 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."); return null; }
  const entries = [], dropped = [];
  for (const c of valid) {                  // preserve original order
    if (c.manual) { if (c.name) entries.push(cleanManual(c)); continue; }
    const now = cur.get(classKey(c));
    if (now) entries.push(entryFrom(now)); else dropped.push(c);   // ref gone from catalog
  }
  return { entries, dropped };
}

// loadable timetable file: our own JSON, re-imported by importTTJson below
function exportTTJson() {
  if (!timetable.length) { alert("시간표가 비어 있습니다."); return; }
  const blob = new Blob([JSON.stringify({ version: 2, timetable: timetable.map(classRef) }, null, 2)],
    { type: "application/json" });
  downloadBlob(blob, "timetable.json");
}
async function importTTJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { alert("불러올 수 없는 시간표 파일입니다."); return; }
  const arr = Array.isArray(data) ? data : data.timetable;
  if (!Array.isArray(arr)) { alert("불러올 수 없는 시간표 파일입니다."); return; }
  const res = await resolveEntries(arr);
  if (!res) return;                         // lookup failed — keep current timetable
  pushUndo();
  timetable = res.entries;
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
  if (detailClass) renderDetail();
  if (res.dropped.length)
    alert(`현재 강의 목록에 없어 제외된 강좌 ${res.dropped.length}개:\n${res.dropped.map(dropLabel).join(", ")}`);
}
function exportWishlist() {
  if (!wishlist.length) { alert("찜한 강좌가 없습니다."); return; }
  const blob = new Blob([JSON.stringify({ version: 2, wishlist: wishlist.map(classRef) }, null, 2)], { type: "application/json" });
  downloadBlob(blob, "wishlist.json");
}
// merge (dedupe by classKey) rather than replace, so importing on another device adds
// to — never wipes — the local list.
async function importWishlist(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { alert("불러올 수 없는 찜 목록 파일입니다."); return; }
  const arr = Array.isArray(data) ? data : data.wishlist;
  if (!Array.isArray(arr)) { alert("불러올 수 없는 찜 목록 파일입니다."); return; }
  const res = await resolveEntries(arr);
  if (!res) return;
  const have = new Set(wishlist.map(classKey));
  let added = 0;
  for (const c of res.entries) {
    const k = classKey(c);
    if (have.has(k)) continue;
    have.add(k); wishlist.push(c); added++;
  }
  saveWishlist(); renderWishlist(); refreshCardStates();
  const tail = res.dropped.length
    ? `\n현재 강의 목록에 없어 제외된 강좌 ${res.dropped.length}개: ${res.dropped.map(dropLabel).join(", ")}`
    : "";
  alert(`${added}개 추가됨 (총 ${wishlist.length}개).${tail}`);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// render the on-screen grid to PNG, reading live DOM geometry so it mirrors what's
// shown (positions, colors, conflict outlines).
// wrap text to fit maxW (char-level — works for Korean without spaces). measureText
// reads the ctx's CURRENT font, so set the font before calling.
function _wrapText(ctx, text, maxW) {
  const out = [];
  let line = "";
  for (const ch of String(text || "")) {
    if (ch === "\n") { out.push(line); line = ""; continue; }
    const t = line + ch;
    if (line && ctx.measureText(t).width > maxW) { out.push(line); line = ch; }
    else line = t;
  }
  if (line) out.push(line);
  return out;
}
function exportTTPng() {
  flushUI();                                  // grid may have a pending coalesced render
  const root = $("#ttGrid");
  const ttx = root && root.querySelector(".ttx");
  if (!ttx) { alert("시간표가 비어 있습니다."); return; }
  const base = root.getBoundingClientRect();   // includes the separate header row
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(base.width * scale);
  canvas.height = Math.ceil(base.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "middle";
  const box = (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
  };
  ctx.fillStyle = "#FBFBFA"; ctx.fillRect(0, 0, base.width, base.height);
  ctx.font = "700 11px 'Noto Sans KR', sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#1A1A19";
  root.querySelectorAll(".ttx-hd").forEach((e) => {
    const b = box(e); ctx.fillText(e.textContent, b.x + b.w / 2, b.y + b.h / 2);
  });
  ctx.font = "10px 'Noto Sans KR', sans-serif"; ctx.textAlign = "right"; ctx.fillStyle = "#A2A29C";
  root.querySelectorAll(".ttx-hour").forEach((e) => {
    const b = box(e); ctx.fillText(e.textContent, b.x + b.w, b.y + 3);
  });
  root.querySelectorAll(".ttx-block").forEach((e) => {
    if (e.classList.contains("preview")) return;   // skip the hover ghost
    const b = box(e);
    ctx.fillStyle = getComputedStyle(e).backgroundColor;
    roundRect(ctx, b.x, b.y, b.w, b.h, 4); ctx.fill();
    if (e.classList.contains("conflict")) {
      ctx.strokeStyle = "#C8485A"; ctx.lineWidth = 2;
      roundRect(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, 3); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    const padX = 6, innerW = b.w - padX * 2, bottom = b.y + b.h - 2;
    let ty = b.y + 11;
    ctx.font = "600 10px 'Noto Sans KR', sans-serif";
    for (const ln of _wrapText(ctx, e.childNodes[0] ? e.childNodes[0].textContent : "", innerW)) {
      if (ty > bottom) break;                 // ran out of vertical room in the block
      ctx.fillText(ln, b.x + padX, ty); ty += 11;
    }
    ctx.font = "9px 'Noto Sans KR', sans-serif";
    ty += 2;                                   // small gap before the meta lines
    outer: for (const s of e.querySelectorAll("small")) {
      for (const ln of _wrapText(ctx, s.textContent, innerW)) {
        if (ty > bottom) break outer;
        ctx.fillText(ln, b.x + padX, ty); ty += 10;
      }
    }
  });
  canvas.toBlob((blob) => downloadBlob(blob, "timetable.png"), "image/png");
}

// ---------- calendar (.ics) ----------
const ICS_DAY = [1, 2, 3, 4, 5, 6, 0];  // day_index (Mon=0..Sun=6) -> JS getDay (Sun=0)
function icsEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/[,;]/g, (m) => "\\" + m)
    .replace(/\n/g, "\\n");
}
const pad2 = (n) => String(n).padStart(2, "0");
const icsDate = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
// first calendar date >= start that falls on the given day_index
function firstOnWeekday(startStr, dayIndex) {
  const [y, m, d] = startStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0);   // noon avoids DST/tz edges
  const target = ICS_DAY[dayIndex];
  for (let i = 0; i < 7; i++) {
    if (dt.getDay() === target) return dt;
    dt.setDate(dt.getDate() + 1);
  }
  return dt;
}
// RFC5545 line fold at <=75 octets (UTF-8 aware; continuation lines start with a space)
function foldIcs(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = "", bytes = 0, first = true;
  for (const ch of line) {
    const cb = enc.encode(ch).length;
    if (bytes + cb > (first ? 75 : 74)) {
      out.push((first ? "" : " ") + cur); cur = ""; bytes = 0; first = false;
    }
    cur += ch; bytes += cb;
  }
  out.push((first ? "" : " ") + cur);
  return out.join("\r\n");
}
// one weekly recurring event per meeting block, Asia/Seoul, repeating until end date
function exportTTIcs() {
  if (!timetable.length) { alert("시간표가 비어 있습니다."); return; }
  const start = $("#icsStart").value, end = $("#icsEnd").value;
  if (!start || !end) { alert("시작일과 종료일을 선택하세요."); return; }
  if (end < start) { alert("종료일이 시작일보다 빠릅니다."); return; }
  const [ey, em, ed] = end.split("-").map(Number);
  const endYmd = `${ey}${pad2(em)}${pad2(ed)}`;
  // RRULE UNTIL must be UTC: 23:59:59 KST (UTC+9) on the end date == 14:59:59Z
  const until = `${endYmd}T145959Z`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//class-checker//timetable//KO",
    "CALSCALE:GREGORIAN",
    "BEGIN:VTIMEZONE", "TZID:Asia/Seoul",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900",
    "TZNAME:KST", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
  ];
  let n = 0;
  for (const c of timetable) {
    for (const s of (c.slots || [])) {
      if (s.day_index == null || !s.start_time || !s.end_time) continue;
      const first = firstOnWeekday(start, s.day_index);
      if (icsDate(first) > endYmd) continue;     // first occurrence past the range
      const day = icsDate(first);
      n++;
      L.push("BEGIN:VEVENT",
        `UID:${c.year}-${c.term}-${c.sbjt_cd}-${c.lt_no}-${s.day_index}-${n}@class-checker`,
        `DTSTAMP:${stamp}`,
        `SUMMARY:${icsEscape(c.name)}`,
        `DESCRIPTION:${icsEscape((c.professor || "미정") + " · " + c.sbjt_cd + "(" + c.lt_no + ")")}`,
        `DTSTART;TZID=Asia/Seoul:${day}T${s.start_time.replace(":", "")}00`,
        `DTEND;TZID=Asia/Seoul:${day}T${s.end_time.replace(":", "")}00`,
        `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
        "END:VEVENT");
    }
  }
  if (!n) { alert("내보낼 시간 정보가 있는 강좌가 없습니다 (시간미정 제외)."); return; }
  L.push("END:VCALENDAR");
  const text = L.map(foldIcs).join("\r\n") + "\r\n";
  downloadBlob(new Blob([text], { type: "text/calendar;charset=utf-8" }), "timetable.ics");
}

// ---------- Google Calendar (client-side GIS token + Calendar API) ----------
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GCAL_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
let _gisLoaded;
// load Google Identity Services on demand (no Google script unless used)
function loadGis() {
  if (_gisLoaded) return _gisLoaded;
  _gisLoaded = new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error("GIS 스크립트 로드 실패 (네트워크 확인)"));
    document.head.appendChild(s);
  });
  return _gisLoaded;
}
// OAuth client id is not a secret; keep it in localStorage, prompt once
function getGoogleClientId() {
  // production: baked into config.js (client_id is public, not a secret)
  if (window.GOOGLE_CLIENT_ID) return window.GOOGLE_CLIENT_ID;
  // dev fallback: prompt once and remember
  let id = localStorage.getItem("google_client_id") || "";
  if (!id) {
    id = (prompt("Google OAuth Client ID (…apps.googleusercontent.com):") || "").trim();
    if (id) localStorage.setItem("google_client_id", id);
  }
  return id;
}
function gcalToken(clientId) {
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: GCAL_SCOPE,
      callback: (r) => r && r.access_token ? res(r.access_token) : rej(new Error(r && r.error || "토큰 없음")),
      error_callback: (e) => rej(new Error((e && e.type) || "OAuth 취소/오류")),
    });
    tc.requestAccessToken();
  });
}
// reuse the ICS recurrence model: one weekly event per meeting block, Asia/Seoul
function buildCalEvents() {
  const start = $("#icsStart").value, end = $("#icsEnd").value;
  if (!start || !end || end < start) return null;
  const [ey, em, ed] = end.split("-").map(Number);
  const endYmd = `${ey}${pad2(em)}${pad2(ed)}`;
  const until = `${endYmd}T145959Z`;   // 23:59:59 KST == 14:59:59Z
  const events = [];
  for (const c of timetable) {
    for (const s of (c.slots || [])) {
      if (s.day_index == null || !s.start_time || !s.end_time) continue;
      const f = firstOnWeekday(start, s.day_index);
      if (icsDate(f) > endYmd) continue;
      const ymd = `${f.getFullYear()}-${pad2(f.getMonth() + 1)}-${pad2(f.getDate())}`;
      events.push({
        summary: c.name,
        description: (c.professor || "미정") + " · " + c.sbjt_cd + "(" + c.lt_no + ")",
        start: { dateTime: `${ymd}T${s.start_time}:00`, timeZone: "Asia/Seoul" },
        end: { dateTime: `${ymd}T${s.end_time}:00`, timeZone: "Asia/Seoul" },
        recurrence: [`RRULE:FREQ=WEEKLY;UNTIL=${until}`],
      });
    }
  }
  return events;
}
async function exportToGoogleCalendar() {
  if (!timetable.length) { alert("시간표가 비어 있습니다."); return; }
  const events = buildCalEvents();
  if (!events) { alert("시작일과 종료일을 확인하세요."); return; }
  if (!events.length) { alert("내보낼 시간 정보가 있는 강좌가 없습니다 (시간미정 제외)."); return; }
  const clientId = getGoogleClientId();
  if (!clientId) return;
  const btn = $("#ttGcal"); const label = btn.textContent; btn.disabled = true;
  btn.textContent = "연결 중…";
  try {
    await loadGis();
    const token = await gcalToken(clientId);
    let ok = 0, fail = 0, firstErr = "";
    for (const ev of events) {
      const r = await fetch(GCAL_EVENTS_URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(ev),
      });
      if (r.ok) { ok++; }
      else {
        fail++;
        if (!firstErr) {                       // surface why Google rejected it
          let msg = "";
          try { msg = (await r.json()).error?.message || ""; } catch { /* non-JSON */ }
          firstErr = `${r.status} ${msg}`.trim();
        }
      }
      btn.textContent = `추가 중… ${ok + fail}/${events.length}`;
    }
    alert(`Google Calendar 추가: 성공 ${ok}건` +
      (fail ? `, 실패 ${fail}건\n사유: ${firstErr}` : ""));
  } catch (e) {
    // a bad/rejected client id is the common cause — let the user re-enter it
    if (String(e.message || e).includes("client")) localStorage.removeItem("google_client_id");
    alert("Google Calendar 연동 실패: " + (e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// ---------- 인원 추이 (enrollment trend) ----------
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  for (const c of kids) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const TREND_SERIES = [
  { k: "a", name: "신청", color: "#8786D8" },
  { k: "c", name: "장바구니", color: "#C87A37" },
  { k: "e", name: "수강", color: "#2E9E6B" },
];
const TREND_FAINT = "#A2A29C", TREND_GRID = "#ECEBE7", TREND_LINE = "#DCDBD7";
let _trend = { key: null, data: null, ts: [], classes: [], byKey: new Map() };
let _trendInited = false;

// lazy: build the term picker + load the default term the first time the page shows
async function ensureTrend() {
  if (_trendInited) return;
  const sel = $("#trendTerm"); if (!sel) return;
  _trendInited = true;
  const idx = await dataIndex();
  sel.replaceChildren();
  idx.terms.forEach((t) => sel.append(el("option",
    { value: `${t.year}|${t.term}` }, `${t.year} ${SEMESTER_LABEL[t.term] || t.term}`)));
  const want = `${(window.SEARCH_DEFAULT_YEAR || "").toString().trim()}|${resolveTermDefault(window.SEARCH_DEFAULT_TERM)}`;
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
  sel.addEventListener("change", loadTrendTerm);
  const inp = $("#trendClass");
  inp.addEventListener("input", () => renderTrendResults(inp.value));
  inp.addEventListener("focus", () => renderTrendResults(inp.value));
  inp.addEventListener("keydown", trendResultsKey);
  $("#trendMetric").addEventListener("change", () => { if (_trend.key) drawTrendChart(); });
  document.addEventListener("click", (e) => {     // close the results list on outside click
    if (!e.target.closest(".trend-search")) $("#trendResults")?.classList.add("hidden");
  });
  await loadTrendTerm();
}

async function loadTrendTerm() {
  const sel = $("#trendTerm"); if (!sel || !sel.value) return;
  const [year, term] = sel.value.split("|");
  $("#trendClass").value = "";
  $("#trendResults").replaceChildren(); $("#trendResults").classList.add("hidden");
  const idx = await dataIndex();
  const meta = idx.terms.find((t) => t.year === year && t.term === term);
  if (!meta || !meta.trend) {
    _trend = { key: null, data: null, ts: [], classes: [], byKey: new Map() };
    setTrendPickerEnabled(false);
    showTrendMsg("이 학기는 아직 수집된 인원 데이터가 없습니다.");
    return;
  }
  showTrendMsg("불러오는 중…");
  let data;
  try { data = await fetch("data/trend/" + meta.trend).then((r) => r.json()); }
  catch { showTrendMsg("데이터를 불러오지 못했습니다."); return; }
  const rows = await termRows(year, term);   // names/prof for the picker
  const info = new Map(rows.map((c) =>
    [`${c.sbjt_cd}(${c.lt_no})`, { name: c.name, prof: c.professor || "" }]));
  const classes = Object.keys(data.series).map((key) => {
    const m = info.get(key) || {};
    return { key, name: m.name || key, prof: m.prof || "",
             label: `${m.name || key}${m.prof ? " · " + m.prof : ""}` };
  }).sort((a, b) => a.name.localeCompare(b.name));
  _trend = { key: null, data, ts: data.ts || [], classes,
             byKey: new Map(classes.map((c) => [c.key, c.label])), year, term };
  setTrendPickerEnabled(classes.length > 0);
  const closedNote = data.closed ? ` · 마감${data.closedAt ? " " + data.closedAt.slice(0, 10) : ""}` : "";
  showTrendMsg(classes.length
    ? `강좌를 검색해 선택하세요 (${classes.length.toLocaleString()}개 강좌 · ${(data.ts || []).length}개 시점)${closedNote}`
    : "이 학기는 아직 수집된 인원 데이터가 없습니다.");
}
function setTrendPickerEnabled(on) {
  const inp = $("#trendClass"), m = $("#trendMetric");
  if (inp) { inp.disabled = !on; inp.placeholder = on ? "강좌 검색 (이름)" : "수집된 데이터 없음"; if (!on) inp.value = ""; }
  if (m) m.disabled = !on;
}

// fuzzy class picker (same relevance ranking as the main search: nameScore over
// the classes that have a trend series), rendered as a clickable results list
function renderTrendResults(q) {
  const ul = $("#trendResults"); if (!ul) return;
  if (!_trend.classes || !_trend.classes.length) {   // no trend data for this term
    ul.classList.add("hidden"); return;
  }
  q = (q || "").trim();
  let items = _trend.classes;
  if (q) items = items
    .map((c) => ({ c, s: Math.max(nameScore(c.name, q), nameScore(c.label, q)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
  ul.replaceChildren();
  _trend._results = items.slice(0, 50);
  _trend._active = -1;
  if (!items.length) {
    ul.append(el("li", { className: "r-empty" }, "일치하는 강좌가 없습니다"));
    ul.classList.remove("hidden");
    return;
  }
  _trend._results.forEach((c) => {
    const li = el("li", {},
      el("div", { className: "r-name" }, c.name),
      el("div", { className: "r-sub" }, `${c.prof ? c.prof + " · " : ""}${c.key}`));
    li.addEventListener("mousedown", (e) => { e.preventDefault(); pickTrendClass(c); });
    ul.append(li);
  });
  ul.classList.remove("hidden");
}
// keyboard: ↓/↑ move the highlight, Enter picks (top result if none highlighted), Esc closes
function trendResultsKey(e) {
  const ul = $("#trendResults");
  const res = _trend._results || [];
  if (e.key === "Escape") { ul.classList.add("hidden"); return; }
  if (e.key === "Enter") {
    if (ul.classList.contains("hidden") || !res.length) {
      renderTrendResults($("#trendClass").value);   // open the list if it was closed
      return;
    }
    e.preventDefault();
    pickTrendClass(res[_trend._active >= 0 ? _trend._active : 0]);
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  if (!res.length) return;
  e.preventDefault();
  _trend._active = e.key === "ArrowDown"
    ? Math.min((_trend._active < 0 ? -1 : _trend._active) + 1, res.length - 1)
    : Math.max(_trend._active - 1, 0);
  [...ul.children].forEach((li, i) => li.classList.toggle("active", i === _trend._active));
  ul.children[_trend._active]?.scrollIntoView({ block: "nearest" });
}
function pickTrendClass(c) {
  if (!c) return;
  _trend.key = c.key;
  $("#trendClass").value = c.label;
  $("#trendResults").classList.add("hidden");
  drawTrendChart();
}

function showTrendMsg(t) {
  const m = $("#trendMsg"); if (m) { m.textContent = t; m.classList.remove("hidden"); }
  setTrendChartVisible(false);
}
function setTrendChartVisible(on) {
  $("#trendChartWrap")?.classList.toggle("hidden", !on);
  $("#trendLegend")?.classList.toggle("hidden", !on);
  if (on) $("#trendMsg")?.classList.add("hidden");
}
function niceCeil(v) {
  if (v <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
const _tsDate = (iso) => new Date(iso);
const fmtTs = (iso) => { const d = _tsDate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fmtTsFull = (iso) => { const d = _tsDate(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function _trendPath(svg, arr, X, Y, color, n, dashed) {
  if (!arr) return;
  let d = "", started = false;
  for (let i = 0; i < n; i++) {
    if (arr[i] == null) { started = false; continue; }   // break line over gaps
    d += (started ? "L" : "M") + X(i) + " " + Y(arr[i]) + " ";
    started = true;
  }
  if (d) svg.append(svgEl("path", { d: d.trim(), fill: "none", stroke: color,
    "stroke-width": dashed ? 1.5 : 2, "stroke-dasharray": dashed ? "4 4" : "",
    "stroke-linejoin": "round", "stroke-linecap": "round", opacity: dashed ? 0.7 : 1 }));
  if (!dashed) for (let i = 0; i < n; i++) if (arr[i] != null)
    svg.append(svgEl("circle", { cx: X(i), cy: Y(arr[i]), r: 2.5, fill: color }));
}

function drawTrendChart() {
  const { data, key, ts } = _trend;
  const s = data.series[key]; if (!s) return;
  const n = ts.length;
  // metric chooser: 전체(all) or one of 신청/장바구니/수강 (so the cart→enrolled drop is readable)
  const metric = $("#trendMetric")?.value || "all";
  const visible = metric === "all" ? TREND_SERIES : TREND_SERIES.filter((d) => d.k === metric);
  const W = 900, H = 360, padL = 44, padR = 16, padT = 14, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let max = 1;
  for (const def of visible) for (const v of (s[def.k] || [])) if (v != null && v > max) max = v;
  for (const v of (s.q || [])) if (v != null && v > max) max = v;
  const niceMax = niceCeil(max);
  const X = (i) => n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW;
  const Y = (v) => padT + plotH - (v / niceMax) * plotH;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  for (let g = 0; g <= 4; g++) {
    const val = niceMax * g / 4, y = Y(val);
    svg.append(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, stroke: TREND_GRID, "stroke-width": 1 }));
    svg.append(svgEl("text", { x: padL - 6, y: y + 3, "text-anchor": "end", "font-size": 10, fill: TREND_FAINT }, String(Math.round(val))));
  }
  const xticks = Math.min(n, 5);
  for (let t = 0; t < xticks; t++) {
    const i = xticks <= 1 ? 0 : Math.round(t * (n - 1) / (xticks - 1));
    svg.append(svgEl("text", { x: X(i), y: H - 10, "text-anchor": "middle", "font-size": 10, fill: TREND_FAINT }, fmtTs(ts[i])));
  }
  _trendPath(svg, s.q, X, Y, TREND_FAINT, n, true);                 // quota reference
  for (const def of visible) _trendPath(svg, s[def.k], X, Y, def.color, n, false);

  const guide = svgEl("line", { x1: 0, y1: padT, x2: 0, y2: padT + plotH, stroke: TREND_LINE, "stroke-width": 1, visibility: "hidden" });
  svg.append(guide);
  const overlay = svgEl("rect", { x: padL, y: padT, width: plotW, height: plotH, fill: "transparent" });
  svg.append(overlay);

  $("#trendChart").replaceChildren(svg);
  const disp = (_trend.byKey && _trend.byKey.get(key)) || key;
  $("#trendTitle").textContent = disp + (_trend.data && _trend.data.closed ? " · 마감" : "");
  renderTrendLegend(s, visible);
  setTrendChartVisible(true);

  const wrap = $("#trendChartWrap"), tip = $("#trendTip");
  overlay.addEventListener("mousemove", (ev) => {
    const r = svg.getBoundingClientRect();
    let i = n <= 1 ? 0 : Math.round(((ev.clientX - r.left) / r.width * W - padL) / plotW * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const gx = X(i);
    guide.setAttribute("x1", gx); guide.setAttribute("x2", gx); guide.setAttribute("visibility", "visible");
    const rows = visible.map((d) =>
      `<div class="tip-row"><span><span class="dot" style="background:${d.color}"></span>${d.name}</span><b>${s[d.k][i] ?? "—"}</b></div>`).join("");
    tip.innerHTML = `<div class="tip-t">${fmtTsFull(ts[i])}</div>${rows}` +
      (s.q && s.q[i] != null ? `<div class="tip-row"><span>정원</span><b>${s.q[i]}</b></div>` : "");
    const wr = wrap.getBoundingClientRect();
    const topVal = Math.max(0, ...visible.map((d) => s[d.k][i] ?? 0));
    tip.style.left = ((gx / W) * r.width + (r.left - wr.left)) + "px";
    tip.style.top = ((Y(topVal) / H) * r.height + (r.top - wr.top)) + "px";
    tip.classList.remove("hidden");
  });
  overlay.addEventListener("mouseleave", () => { tip.classList.add("hidden"); guide.setAttribute("visibility", "hidden"); });
}

function renderTrendLegend(s, visible) {
  const lg = $("#trendLegend"); lg.replaceChildren();
  const add = (color, name) => {
    const node = el("span", { className: "lg" }, el("span", { className: "dot" }), name);
    node.querySelector(".dot").style.background = color;
    lg.append(node);
  };
  (visible || TREND_SERIES).forEach((d) => add(d.color, d.name));
  if (s.q && s.q.some((v) => v != null)) add(TREND_FAINT, "정원");
}

// ---------- 졸업요건 (graduation audit) ----------
const GRAD_AREA_KEY = "snu_grad_gyarea";    // {sbjt_cd: areaKey} manual 교양-area overrides
const GRAD_STATE_KEY = "snu_grad_state";    // {picks:{semKey:sheetId}, list:[{type,major,year}], eng:{idx:bool}}
let _gradIndex = null;
const _gradSpecCache = {}, _gradReqCache = {};   // spec by file; 전필 set by batch-year
let _gradAreaOv = _gradLoad(GRAD_AREA_KEY, {});
let _gradState = _gradLoad(GRAD_STATE_KEY, { picks: {}, list: null, eng: {} });
if (!_gradState.picks || typeof _gradState.picks !== "object") _gradState.picks = {};
delete _gradState.sheets;   // drop legacy flat selection → blank start (spec §4)
function _gradLoad(k, dflt) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? dflt; } catch { return dflt; } }
function _gradSave(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); _quotaWarned = false; } catch (e) { _onQuota(e); } }
async function _loadGradIndex() {
  if (!_gradIndex) _gradIndex = await fetch("data/grad_req/index.json").then((r) => r.json());
  return _gradIndex;
}
async function _loadGradSpec(file) {
  if (!_gradSpecCache[file]) _gradSpecCache[file] = await fetch("data/grad_req/" + file).then((r) => r.json());
  return _gradSpecCache[file];
}
// 단일 소스(full granularity): 코드 접두사 규칙 + 예외 목록. 교양 강좌 → 세부영역.
let _gradAreaCodes = null;
async function _loadAreaCodes() {
  if (!_gradAreaCodes) {
    const d = await fetch("data/grad_req/gyo/area_codes.json").then((r) => r.json());
    _gradAreaCodes = { codes: d.codes || {}, exceptions: d.exceptions || {}, flex_recognition: d.flex_recognition || {}, gwonjang: d.gwonjang_codes || [], junggeup: d.junggeup_codes || [] };
  }
  return _gradAreaCodes;
}
// 전공 코드 개편(renumber) 대응: sbjt_cd → canonical(동일교과목). 전필 매칭 시 양쪽 정규화.
let _gradCodeEquiv = null;
async function _loadCodeEquiv() {
  if (!_gradCodeEquiv) {
    try { _gradCodeEquiv = (await fetch("data/grad_req/code_equiv.json").then((r) => r.json())).canon || {}; }
    catch { _gradCodeEquiv = {}; }
  }
  return _gradCodeEquiv;
}
// 단대/학부 교양 어댑터(self-contained): 세부영역 → 버킷 할당 + 최저학점.
const _gyoCache = {};
async function _loadGyo(id) {
  if (!id) return null;
  if (!_gyoCache[id]) _gyoCache[id] = await fetch("data/grad_req/gyo/" + id + ".json").then((r) => r.json());
  return _gyoCache[id];
}
// the chosen subset of timetables the audit runs against (NOT all sheets; managed on this
// page only — adding/removing here never touches the real sheet list).
function _gradSelectedIds() {
  // ids the audit runs against: one picked sheet per selected semester (spec §5).
  // Dangling picks (sheet deleted) are filtered out; no active-sheet fallback.
  return Object.values(_gradState.picks).filter((id) => meta.ids.includes(id));
}
function _gradTaken(ids) {                   // union of chosen sheets, deduped by classKey
  const seen = new Set(), out = [];
  for (const id of ids)
    for (const c of (id === activeId() ? timetable : _readSheet(id))) {
      const k = classKey(c); if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
  return out;
}
// the 전공필수 set: 통계 dept courses classified 전필 across the batch year's terms
async function _gradRequired(spec, year) {
  const ck = spec.id + "|" + year;            // key by dept-spec too: same year, different major
  if (_gradReqCache[ck]) return _gradReqCache[ck];
  const want = spec.major_required_match, map = new Map();
  try {
    const ix = await dataIndex();
    for (const t of (ix.terms || []).filter((t) => String(t.year) === String(year)))
      for (const c of await termRows(t.year, t.term)) {
        const dept = c.department || "", cls = c.classification || [];
        if (cls.includes("학사") && want.departments.some((d) => dept.includes(d)) && want.classifications.some((x) => cls.includes(x)))
          map.set(c.sbjt_cd, { name: c.name, code: c.sbjt_cd, credits: Number(c.credits) || 0 });
      }
  } catch { /* offline: fall back to the known list */ }
  if (!map.size) (spec.major_required_known || []).forEach((c) => map.set(c.code, c));
  _gradReqCache[ck] = [...map.values()];
  return _gradReqCache[ck];
}
function _gradBar(label, have, need, unit) {
  const ok = have >= need, pct = need ? Math.min(100, Math.round(have / need * 100)) : 100;
  return el("div", { className: "grad-card" + (ok ? " ok" : "") },
    el("div", { className: "gc-top" },
      el("span", { className: "gc-label" }, label),
      el("span", { className: "gc-num" }, `${have} / ${need}${unit || ""}`)),
    el("div", { className: "gc-track" }, el("div", { className: "gc-fill", style: `width:${pct}%` })));
}
// ----- 전공 구성(major list): entries typed 주전공/복수전공/부전공. Track auto-derived. -----
const GRAD_TYPE_LABEL = { main: "주전공", double: "복수전공", minor: "부전공", union: "연합·연계전공" };
const _GRAD_INTER_RE = /(연합전공|연계전공)$/;            // 연합·연계전공 식별: major 명 접미사
const _gradIsInter = (m) => _GRAD_INTER_RE.test(m || "");
function _gradYears(idx, major) {
  return idx.filter((e) => e.major === major).map((e) => String(e.batch)).sort().reverse();
}
function _gradTrackKey(entry, list) {           // entry type + composition -> track key
  if (entry.type === "double") return "double";
  if (entry.type === "minor") return "minor";
  if (entry.type === "union") return "double";   // 연합·연계 = 제2전공 → spec track key "double"
  // 주전공: 복수전공 또는 연합전공(제2전공급) 있으면 다전공(multi); 부전공·연계전공만이면 심화(single)
  const hasMajor2 = list.some((e) => e.type === "double" || (e.type === "union" && /연합전공$/.test(e.major)));
  return hasMajor2 ? "multi" : "single";
}
function _gradTrackOf(spec, entry, list) {
  const key = _gradTrackKey(entry, list);
  return (spec.tracks || []).find((t) => t.key === key)
    || (spec.tracks || []).find((t) => t.key === "single") || (spec.tracks || [])[0]
    || { key, name: "전공", major_min_credits: spec.major_min_credits, general: true, select_min: 0 };
}
function _gradResolveList(idx, majors) {
  const dept = majors.filter((m) => !_gradIsInter(m));     // 주/복수/부전공 = 일반학과만
  const inter = majors.filter((m) => _gradIsInter(m));     // 연합·연계전공 슬롯 = interdept만
  let list = Array.isArray(_gradState.list) ? _gradState.list.filter((e) => majors.includes(e.major)) : [];
  // 슬롯-풀 정합: union 항목은 반드시 interdept, 그 외(main/double/minor)는 일반학과
  list = list.filter((e) => e.type === "union" ? inter.includes(e.major) : dept.includes(e.major));
  if (!list.some((e) => e.type === "main"))
    list.unshift({ type: "main", major: dept[0], year: _gradYears(idx, dept[0])[0] });
  // exactly one main: extra mains -> drop
  let seenMain = false;
  list = list.filter((e) => e.type !== "main" || (!seenMain && (seenMain = true)));
  list.forEach((e) => { const ys = _gradYears(idx, e.major); if (!ys.includes(String(e.year))) e.year = ys[0]; });
  _gradState.list = list;
}
function _renderGradList(idx, majors, okByIdx) {
  const box = $("#gradMajorList"); if (!box) return;
  okByIdx = okByIdx || {};
  const dept = majors.filter((m) => !_gradIsInter(m));
  const inter = majors.filter((m) => _gradIsInter(m));
  const save = () => { _gradSave(GRAD_STATE_KEY, _gradState); renderGrad(); };
  const rows = _gradState.list.map((e, i) => {
    const pool = e.type === "union" ? inter : dept;       // 슬롯 유형별 선택 가능 전공 풀
    const years = _gradYears(idx, e.major);
    const mSel = el("select", { className: "gm-major",
      onchange: (ev) => { e.major = ev.target.value; e.year = _gradYears(idx, e.major)[0]; save(); } },
      ...pool.map((m) => el("option", { value: m }, m)));
    mSel.value = e.major;
    const ySel = el("select", { className: "gm-year",
      onchange: (ev) => { e.year = ev.target.value; save(); } },
      ...years.map((y) => el("option", { value: y }, `${y}학번`)));
    ySel.value = String(e.year);
    const met = okByIdx[i];
    const mark = el("span", { className: "gm-mark " + (met === true ? "ok" : met === false ? "no" : "") },
      met === true ? "✓" : met === false ? "✗" : "·");
    const label = e.type === "union"
      ? (e.major.endsWith("연합전공") ? "연합전공" : "연계전공")    // 슬롯 칩은 실제 분류 표기
      : (GRAD_TYPE_LABEL[e.type] || e.type);
    const kids = [mark, el("span", { className: "gm-type gm-" + e.type }, label), mSel, ySel];
    if (e.type !== "main")
      kids.push(el("button", { type: "button", className: "gm-del", title: "제외",
        onclick: () => { _gradState.list.splice(i, 1); save(); } }, "×"));
    return el("div", { className: "gm-row" }, ...kids);
  });
  const addBtn = (type, label, pool) => el("button", { type: "button", className: "gm-add",
    onclick: () => { _gradState.list.push({ type, major: pool[0], year: _gradYears(idx, pool[0])[0] }); save(); } }, label);
  box.replaceChildren(...rows, el("div", { className: "gm-adds" },
    addBtn("double", "+ 복수전공", dept), addBtn("minor", "+ 부전공", dept),
    inter.length ? addBtn("union", "+ 연합·연계전공", inter) : document.createTextNode("")));
}
// write one pick (semKey → sheetId), persist, re-audit
function _gradSetPick(sem, id) { _gradState.picks[sem] = id; _gradSave(GRAD_STATE_KEY, _gradState); renderGrad(); }
function _gradDropPick(sem) { delete _gradState.picks[sem]; _gradSave(GRAD_STATE_KEY, _gradState); renderGrad(); }
function _renderGradSheets() {
  const box = $("#gradSheetPick"); if (!box) return;
  const picks = _gradState.picks;
  // prune dangling picks (picked sheet deleted) so its semester is re-addable (spec §6, §8)
  for (const s of Object.keys(picks))
    if (!meta.ids.includes(picks[s])) delete picks[s];

  const byRank = (a, b) => semRankKey(b) - semRankKey(a);   // newest semester first
  const semsWithSheets = (excludePicked) => {
    const set = new Set();
    for (const id of meta.ids) { const s = meta.sems[id]; if (s) set.add(s); }
    let keys = [...set];
    if (excludePicked) keys = keys.filter((s) => !(s in picks));
    return keys.sort(byRank);
  };
  const label = (id) => `${meta.names[id] || "시간표"} (${meta.counts[id] ?? 0})`;

  const rows = Object.keys(picks).sort(byRank).map((sem) => {
    const inSem = meta.ids.filter((id) => meta.sems[id] === sem);
    const pick = el("select", { className: "gs-pick",
      onchange: (e) => _gradSetPick(sem, Number(e.target.value)) },
      ...inSem.map((id) => el("option", { value: String(id) }, label(id))));
    pick.value = String(picks[sem]);
    return el("div", { className: "gsheet-row" },
      el("span", { className: "gs-sem" }, semLabel(sem)),
      pick,
      el("button", { type: "button", className: "gs-del", title: "목록에서 제외",
        onclick: () => _gradDropPick(sem) }, "×"));
  });

  const addable = semsWithSheets(true);
  if (addable.length)
    rows.push(el("select", { className: "gsheet-add",
      onchange: (e) => { const s = e.target.value; if (s) _gradSetPick(s, meta.ids.find((id) => meta.sems[id] === s)); } },
      el("option", { value: "" }, "+ 학기 추가"),
      ...addable.map((s) => el("option", { value: s }, semLabel(s)))));
  else if (!semsWithSheets(false).length)
    rows.push(el("div", { className: "grad-note" }, "시간표를 먼저 만드세요"));

  box.replaceChildren(...rows);
}
async function renderGrad() {
  const host = $("#gradBody"); if (!host) return;
  const idx = await _loadGradIndex();
  const majors = [...new Set(idx.map((e) => e.major))].sort((a, b) => a.localeCompare(b, "ko"));
  _gradResolveList(idx, majors);
  _renderGradSheets();
  const taken = _gradTaken(_gradSelectedIds());
  let cat = new Map();
  try {
    const keys = taken.filter((c) => !c.manual).map((c) => [c.year, c.term, c.sbjt_cd, c.lt_no]);
    if (keys.length) cat = new Map((await lookupLocal(keys)).map((c) => [classKey(c), c]));
  } catch { /* offline: use stored fields */ }
  const rows = taken.map((c) => {
    const m = cat.get(classKey(c)) || {};
    return { name: c.name, sbjt_cd: c.sbjt_cd, credits: Number(m.credits ?? c.credits ?? 0) || 0,
      cls: m.classification || c.classification || [], dept: m.department || c.dept || c.department || "",
      college: m.college || c.college || "" };
  });
  const areaCodes = await _loadAreaCodes();
  const codeEquiv = await _loadCodeEquiv();
  const blocks = [], okByIdx = {};
  for (let i = 0; i < _gradState.list.length; i++) {
    const entry = _gradState.list[i];
    const ie = idx.find((x) => x.major === entry.major && String(x.batch) === String(entry.year));
    if (!ie) continue;
    const spec = await _loadGradSpec(ie.file);
    const track = _gradTrackOf(spec, entry, _gradState.list);
    const required = await _gradRequired(spec, entry.year);
    const ruleset = await _loadGyo(spec.general);
    const r = _gradAuditBlock(spec, track, rows, required, entry, i, ruleset, areaCodes, codeEquiv);
    okByIdx[i] = r.ok; blocks.push(r.node);
  }
  _renderGradList(idx, majors, okByIdx);
  host.replaceChildren(...(blocks.length ? blocks : [el("div", { className: "grad-note" }, "전공을 추가하세요.")]));
}
function _gradAuditBlock(spec, track, rows, required, entry, blkIdx, ruleset, areaCodes, codeEquiv) {
  const canon = (c) => (codeEquiv || {})[c] || c;   // 코드 개편 정규화: 동일교과목은 같은 canonical로
  const suri = spec.suri || { seq: [], combined: null };
  const suriCodes = new Set([...(suri.seq || []).map((x) => x.code), ...(suri.combined ? [suri.combined.code] : [])]);

  const isStat = (d) => [...(spec.major_required_match?.departments || []), ...(spec.major_select_match?.departments || [])].some((x) => (d || "").includes(x));
  const hasCls = (r, t) => (r.cls || []).includes(t);
  const er = spec.external_recognition || {};
  const recogCodes = new Set((er.courses || []).map((c) => canon(c.code)));
  const recogPrefix = er.code_prefixes || [];
  const recogColl = er.colleges || [];
  const recogDepts = er.depts || [];
  const recogAnyDept = er.any_dept === true;                          // 타과 전선/전필 전부 인정(상한은 track.recog_max)
  const isRecog = (r) => {
    if (isStat(r.dept)) return false;                                  // own major handled by isStat path (no double-count)
    const code = canon(r.sbjt_cd);
    if (recogCodes.has(code)) return true;                            // designated course — any classification
    if (recogPrefix.some((p) => code.startsWith(p))) return true;     // 공대공통 prefix — any classification
    const isMajorCourse = hasCls(r, "전선") || hasCls(r, "전필");
    if (recogAnyDept && isMajorCourse) return true;                   // any other dept's 전공 course
    if (recogColl.includes(r.college) && isMajorCourse) return true;  // college 전공 course
    if (recogDepts.some((x) => (r.dept || "").includes(x.replace(/부$/, ""))) && isMajorCourse) return true;
    return false;
  };
  const _takenCanon = new Set(rows.map((r) => canon(r.sbjt_cd)));   // 수강 코드 정규화
  const takenCodes = { has: (code) => _takenCanon.has(canon(code)) };   // 전필 매칭 시 required 코드도 canon → 개편 전/후 코드 호환

  // 수리통계: 주전공·복수전공은 1+2 필수(M1399 불가), 부전공만 M1399로 대체 가능
  const hasBothSeq = (suri.seq || []).length > 0 && (suri.seq || []).every((x) => takenCodes.has(x.code));
  const hasCombined = suri.combined ? takenCodes.has(suri.combined.code) : false;
  const suriDone = track.suri_sub ? (hasBothSeq || hasCombined) : hasBothSeq;
  const suriIllegal = !track.suri_sub && hasCombined;
  const hasSuriReq = (suri.seq || []).length > 0;

  const totalCr = rows.reduce((s, r) => s + r.credits, 0);
  const reqBase = required.filter((c) => c.code && !suriCodes.has(c.code));   // 코드 없는 항목(이름만) 제외; 수리통계는 아래에서 트랙별로 처리
  const reqBaseTaken = reqBase.filter((c) => takenCodes.has(c.code));
  // 부전공: 수리통계는 1과목(대체 가능). 주전공·복수전공: 수리통계 1·2 = 2과목 별도.
  const suriCount = track.suri_sub ? 1 : (suri.seq || []).length;
  const suriDoneN = track.suri_sub ? (suriDone ? 1 : 0) : (suri.seq || []).filter((x) => takenCodes.has(x.code)).length;

  const majorSelRows = rows.filter((r) => isStat(r.dept) && hasCls(r, "전선"));
  const majorReqCr = rows.filter((r) => isStat(r.dept) && hasCls(r, "전필")).reduce((s, r) => s + r.credits, 0);
  const recogRows = rows.filter((r) => isRecog(r));
  let recogCounted = recogRows;
  if (track.recog_max_courses != null)   // 과목 수 상한: 학점 높은 순 N과목만 인정(학생 유리)
    recogCounted = [...recogRows].sort((a, b) => b.credits - a.credits).slice(0, track.recog_max_courses);
  let recogCr = recogCounted.reduce((s, r) => s + r.credits, 0);
  if (track.recog_max != null) recogCr = Math.min(recogCr, track.recog_max);   // recog_max 학점 상한 (econ 12 / me 15 / stat 9; 부전공 0)
  const illegalCr = suriIllegal ? rows.filter((r) => r.sbjt_cd === suri.combined.code).reduce((s, r) => s + r.credits, 0) : 0;
  const majorCr = majorReqCr + majorSelRows.reduce((s, r) => s + r.credits, 0) + recogCr - illegalCr;

  // 전공선택 has TWO minimums: course count (track.select_min) AND credits.
  // credit-min = 전공 총 학점 − 전공필수 고정 학점 (e.g. 심화 60 − 15 = 45).
  const reqBaseCredits = reqBase.reduce((s, c) => s + (c.credits || 0), 0);
  const suriReqCredits = !hasSuriReq ? 0 : (track.suri_sub
    ? ((suri.combined && suri.combined.credits) || 3)
    : (suri.seq || []).reduce((s, x) => s + (x.credits || 3), 0));
  // 전공필수 set is TRACK-DEPENDENT. Prefer spec track.required (explicit list / N-of-M pool);
  // else fall back to catalog-derived set (+수리통계 rule). reqCreditsFixed = 전공필수 고정 학점.
  const chkItems = [];
  let reqTotalN, reqDoneN, reqCreditsFixed;
  const tr = track.required;
  // 전공필수 = 고정 이수(all) + 택N 그룹(groups[] | 단일 pool). 셋 다 합산해 한 전필 바로 집계.
  const fixedAll = (tr && tr.all) || [];
  const groupList = [];
  if (tr && tr.groups) groupList.push(...tr.groups);
  if (tr && tr.choose) groupList.push(...tr.choose);   // 'choose' = 기존 biz 스키마의 택N 그룹(동의어)
  if (tr && tr.pool) groupList.push({ label: tr.label, min_courses: tr.min_courses, min_credits: tr.min_credits, pool: tr.pool });
  if (fixedAll.length || groupList.length) {
    fixedAll.forEach((c) => chkItems.push({ label: c.name, code: c.code, done: takenCodes.has(c.code) }));
    let gN = 0, gDone = 0, gCred = 0;
    groupList.forEach((g, gi) => {
      const pool = g.pool || [];
      const n = g.min_courses != null ? g.min_courses : pool.length;
      const doneN = pool.filter((c) => c.code && takenCodes.has(c.code)).length;
      pool.forEach((c) => chkItems.push({ label: c.name, code: c.code, done: !!(c.code && takenCodes.has(c.code)),
        gkey: "g" + gi, group: g.label || `택${n}`, groupSize: pool.length, groupN: n }));   // gkey = 그룹별 고유키(라벨 없어도 분리)
      gN += n; gDone += Math.min(doneN, n); gCred += (g.min_credits || 0);
    });
    reqTotalN = fixedAll.length + gN;
    reqDoneN = fixedAll.filter((c) => takenCodes.has(c.code)).length + gDone;
    reqCreditsFixed = track.required_credits != null ? track.required_credits
      : (fixedAll.reduce((s, c) => s + (c.credits || 0), 0) + gCred);
  } else if (track.required_credits != null && !hasSuriReq) {
    // 전필 학점만 권위값(required_credits로 차감). 카탈로그/known 전필 과목은 참고용(ref, 비게이팅)으로 표시 — 학과별 택N/초과태깅 가능성 때문에 과목 수로 졸업 판정하지 않음
    reqTotalN = 0; reqDoneN = 0;
    reqCreditsFixed = track.required_credits;
    if (track.required_credits > 0)   // rc===0("없음")일 땐 참고 과목도 표시하지 않음
      reqBase.forEach((c) => chkItems.push({ label: c.name, code: c.code, done: takenCodes.has(c.code), ref: true }));
  } else {
    reqBase.forEach((c) => chkItems.push({ label: c.name, code: c.code, done: takenCodes.has(c.code) }));
    if (hasSuriReq) {
      if (track.suri_sub) chkItems.push({ label: "수리통계 1·2 또는 수리통계(대체)", code: suri.combined && suri.combined.code, done: suriDone });
      else (suri.seq || []).forEach((x) => chkItems.push({ label: x.name, code: x.code, done: takenCodes.has(x.code) }));
    }
    reqTotalN = reqBase.length + (hasSuriReq ? suriCount : 0);
    reqDoneN = reqBaseTaken.length + (hasSuriReq ? suriDoneN : 0);
    reqCreditsFixed = reqBaseCredits + suriReqCredits;
    // 카탈로그 파생 전필이 트랙 전공학점 초과(초과태깅·부전공 축소 등) → 게이팅 해제, 과목은 참고로만 표시
    if (reqCreditsFixed > track.major_min_credits) {
      chkItems.forEach((it) => { it.ref = true; });
      reqTotalN = 0; reqDoneN = 0;
    }
  }
  const selectMinCredits = Math.max(0, track.major_min_credits - reqCreditsFixed);
  // 수리과학부·컴퓨터공학부 인정과목은 전공선택 '학점'에 포함(과목 수에는 미포함)
  const selectCredits = majorSelRows.reduce((s, r) => s + r.credits, 0) + recogCr;

  const gyRows = rows.filter((r) => hasCls(r, "교양"));
  const gyBuckets = (ruleset && ruleset.buckets) || [];
  const byKey = {}; gyBuckets.forEach((b) => { byKey[b.key] = b; });
  const flexRecog = (areaCodes && areaCodes.flex_recognition) || {};
  const fineOf = (sb) => {            // 예외목록 우선, 없으면 코드 접두사 → 세부영역
    const s = String(sb || "");
    return ((areaCodes && areaCodes.exceptions) || {})[s] || ((areaCodes && areaCodes.codes) || {})[s.split(".")[0]] || "";
  };
  // 과목이 들어갈 수 있는 버킷 키 목록(버킷 순서 유지). 통계처럼 교차인정(flex_recognition) 규칙이 있으면 여러 버킷에 적격.
  const eligOf = (r) => {
    const ov = _gradAreaOv[r.sbjt_cd];
    if (ov) return ov in byKey ? [ov] : [];          // 수동 override → 해당 버킷 단일 배정
    const f = fineOf(r.sbjt_cd);
    if (!f) return [];
    const markers = flexRecog[f] || [];
    return gyBuckets.filter((b) => (b.areas || []).includes(f) || markers.some((m) => (b.areas || []).includes(m))).map((b) => b.key);
  };
  const bucketCr = {}, bucketAreas = {}, bucketFineCr = {};
  gyBuckets.forEach((b) => { bucketCr[b.key] = 0; bucketAreas[b.key] = new Set(); bucketFineCr[b.key] = {}; });
  const addTo = (bk, r) => {
    bucketCr[bk] += r.credits;
    const f = fineOf(r.sbjt_cd), bdef = byKey[bk];
    if (f && bdef && (bdef.areas || []).includes(f)) {   // 영역 카운트·하위영역 학점은 해당 버킷 소속 세부영역만 (override·flex 오염 방지)
      bucketAreas[bk].add(f);
      bucketFineCr[bk][f] = (bucketFineCr[bk][f] || 0) + r.credits;
    }
  };
  // 1패스: 적격 버킷 1개인 과목 즉시 배정. 2패스: 다중적격(flex) 과목은 부족분 큰 버킷부터 그리디 배정 → 최소충족 최대화(오탈락 방지).
  const assign = new Map(), flexRows = [];
  let gyTotal = 0;
  for (const r of gyRows) {
    gyTotal += r.credits;
    const elig = eligOf(r);
    if (elig.length === 1) { assign.set(r, elig[0]); addTo(elig[0], r); }
    else if (elig.length > 1) flexRows.push([r, elig]);
  }
  for (const [r, elig] of flexRows) {
    let best = elig[0], bestDef = byKey[best].min - bucketCr[best];
    for (const k of elig) {
      const def = byKey[k].min - bucketCr[k];
      if (def > bestDef) { best = k; bestDef = def; }
    }
    assign.set(r, best); addTo(best, r);
  }
  // 학문의 세계 교차배분(pre-25): 하위영역 학점 하한 — 인문·사회계는 자연계 영역 ≥N, 자연·공계는 인문계 영역 ≥N
  const areaMinCr = (b, am) => (am.areas || []).reduce((s, a) => s + ((bucketFineCr[b.key] || {})[a] || 0), 0);

  const sections = [];
  // 1) summary — 졸업/교양 only for tracks that earn the degree (심화전공·다전공 주전공)
  const cards = [];
  if (track.general) cards.push(_gradBar("졸업 학점", totalCr, spec.total_credits, "학점"));
  cards.push(_gradBar(`전공 학점 · ${track.name}`, majorCr, track.major_min_credits, "학점"));
  if (track.general) cards.push(_gradBar("교양 학점", gyTotal, (ruleset && ruleset.total_min) || 0, "학점"));
  sections.push(el("div", { className: "grad-cards" }, ...cards));

  // 2) 전공
  const chkItem = (label, done, code) => el("div", { className: "chk" + (done ? " done" : " miss") },
    el("span", { className: "chk-i" }, done ? "✓" : "○"),
    el("span", {}, `${label} `), code ? el("span", { className: "chk-code" }, code) : document.createTextNode(""));
  const major = el("section", { className: "grad-sec" }, el("h3", {}, "전공"));
  // 전필 과목 목록이 있으면 과목 바, 없고 학점만 알면 안내 노트(0/0 거짓 충족 방지)
  if (reqTotalN > 0)
    major.append(_gradBar(`전공필수 (${reqDoneN}/${reqTotalN}과목)`, reqDoneN, reqTotalN, "과목"));
  else if ((track.required_credits || 0) > 0)
    major.append(el("div", { className: "grad-note" }, chkItems.some((it) => it.ref)
      ? `전공필수 ${track.required_credits}학점 (졸업 판정 기준) — 아래는 카탈로그 전필 과목(참고), 학과 택N·초과태깅 가능 → 직접 확인`
      : `전공필수 ${track.required_credits}학점 — 개별 과목 코드 미수집, 직접 확인 (전공선택 학점은 차감 반영)`));
  else if (track.required_credits === 0)
    major.append(el("div", { className: "grad-note" }, "전공필수 없음 — 전공선택으로 전공학점 충족"));
  else if (chkItems.some((it) => it.ref))
    major.append(el("div", { className: "grad-note" }, "전공필수 — 카탈로그 파생 과목(참고). 전필 학점이 전공 총학점을 초과(초과태깅 가능) → 실제 전필은 학과 확인"));
  const chk = el("div", { className: "grad-chklist" });
  // 무조건 이수(고정) 먼저, 그다음 택N 그룹별 안내문 + 후보 과목
  chkItems.filter((it) => !it.gkey).forEach((it) => chk.append(chkItem(it.label, it.done, it.code)));
  [...new Set(chkItems.filter((it) => it.gkey).map((it) => it.gkey))].forEach((gk) => {
    const gi = chkItems.filter((it) => it.gkey === gk);
    chk.append(el("div", { className: "grad-note grp" }, `${gi[0].group} — 아래 ${gi[0].groupSize}과목 중 ${gi[0].groupN}과목 이상`));
    gi.forEach((it) => chk.append(chkItem(it.label, it.done, it.code)));
  });
  major.append(chk);
  if (suriIllegal)
    major.append(el("div", { className: "grad-flag warn" },
      el("span", {}, `⚠ ${track.name}은 수리통계(${suri.combined.code}) 이수 불가 — 수리통계 1·2로 이수해야 하며 전공학점에서 제외됨`)));
  if (track.select_min > 0) major.append(_gradBar("전공선택 (과목 수)", majorSelRows.length, track.select_min, "과목"));
  if (selectMinCredits > 0) major.append(_gradBar("전공선택 (학점)", selectCredits, selectMinCredits, "학점"));
  if (recogCr) major.append(el("div", { className: "grad-note" }, `전공선택인정: ${recogCr}학점 반영`));
  if (majorSelRows.length || recogRows.length) {
    const fold = el("details", { className: "grad-fold" });
    fold.append(el("summary", {}, `전공선택 인정 과목 ${majorSelRows.length + recogRows.length}개 · ${selectCredits}학점`));
    const courseLine = (r) => el("div", { className: "gfold-row" },
      el("span", { className: "gfr-name" }, r.name),
      el("span", { className: "gfr-code" }, r.sbjt_cd),
      el("span", { className: "gfr-cr" }, `${r.credits}학점`),
      el("span", { className: "gfr-dept" }, r.dept || "—"));
    if (majorSelRows.length) {
      fold.append(el("div", { className: "gfold-grp" }, "전공 (전선)"));
      majorSelRows.forEach((r) => fold.append(courseLine(r)));
    }
    if (recogRows.length) {
      const capParts = [];
      if (track.recog_max_courses != null) capParts.push(`최대 ${track.recog_max_courses}과목`);
      if (track.recog_max != null) capParts.push(`최대 ${track.recog_max}학점`);
      const cap = capParts.length ? ` (${capParts.join(", ")}, 반영 ${recogCr})` : "";
      fold.append(el("div", { className: "gfold-grp" }, "타과 인정" + cap));
      recogRows.forEach((r) => fold.append(courseLine(r)));
    }
    major.append(fold);
  }
  sections.push(major);

  // 3) 교양 (degree tracks only)
  if (track.general && ruleset) {
    const gen = el("section", { className: "grad-sec" }, el("h3", {}, `교양 · ${ruleset.college || "공통교육과정"}`));
    gyBuckets.forEach((b) => {
      const nm = b.pick_min_areas ? `${b.name} · ${bucketAreas[b.key].size}/${b.pick_min_areas}영역` : b.name;
      gen.append(_gradBar(nm, bucketCr[b.key], b.min, "학점"));
      (b.area_min || []).forEach((am) => {
        if (am.ref) gen.append(el("div", { className: "grad-note" }, `└ ${am.label || "참고 하위영역"}: ${areaMinCr(b, am)}/${am.min}학점 (참고·비강제)`));
        else gen.append(_gradBar(`└ ${am.label || "필수 하위영역"}`, areaMinCr(b, am), am.min, "학점"));
      });
    });
    (ruleset.notes || []).forEach((n) => gen.append(el("div", { className: "grad-note" }, "· " + n)));
    // 권장과목(*)·중급이상 같은 '코드 목록 중 N과목' 요건 — 자문(advisory), 졸업 판정(ok)에는 미반영(오탈락 방지)
    (ruleset.required_one_of || []).forEach((req) => {
      const poolSet = new Set((areaCodes && areaCodes[req.list]) || []);
      const matched = gyRows.filter((r) => poolSet.has(r.sbjt_cd) || poolSet.has(canon(r.sbjt_cd)));
      const need = req.min_courses || 1;
      const met = matched.length >= need;
      gen.append(el("div", { className: "grad-flag adv" + (met ? " ok" : "") },
        el("span", {}, `${met ? "✓" : "○"} ${req.label} (${matched.length}/${need}과목) · 참고·비강제`)));
      if (req.note) gen.append(el("div", { className: "grad-note" }, "· " + req.note));
      if (matched.length) {
        const fold = el("details", { className: "grad-fold" });
        fold.append(el("summary", {}, `인정 과목 ${matched.length}개`));
        matched.forEach((r) => fold.append(el("div", { className: "gfold-row" },
          el("span", { className: "gfr-name" }, r.name),
          el("span", { className: "gfr-code" }, r.sbjt_cd),
          el("span", { className: "gfr-cr" }, `${r.credits}학점`))));
        gen.append(fold);
      }
    });
    gen.append(el("div", { className: "grad-subh" }, "교양 강좌 영역 (코드 자동분류 · 필요 시 수정)"));
    if (!gyRows.length) gen.append(el("div", { className: "grad-note" }, "선택한 시간표에 교양 강좌가 없습니다."));
    gyRows.forEach((r) => {
      const cur = assign.has(r) ? assign.get(r) : "";
      const sel = el("select", { className: "gy-area" + (cur ? "" : " unset"),
        onchange: (e) => { _gradAreaOv[r.sbjt_cd] = e.target.value; _gradSave(GRAD_AREA_KEY, _gradAreaOv); renderGrad(); } },
        el("option", { value: "" }, "미분류"),
        ...gyBuckets.map((b) => el("option", { value: b.key }, b.name)));
      sel.value = cur;
      gen.append(el("div", { className: "gy-row" }, el("span", { className: "gy-name" }, `${r.name} (${r.credits})`), sel));
    });
    sections.push(gen);
  }

  // 4) 기타 요건
  const extra = el("section", { className: "grad-sec" }, el("h3", {}, "기타 요건"));
  if (track.general) {
    (spec.dept_required_general || []).forEach((g) => {
      const ok = rows.some((r) => r.name === g.name) || gyRows.some((r) => r.name.includes(g.name));
      extra.append(el("div", { className: "grad-flag" + (ok ? " ok" : "") }, el("span", {}, (ok ? "✓ " : "○ ") + `${g.name} 필수`)));
    });
    const engOk = !!(_gradState.eng || {})[blkIdx];
    extra.append(el("label", { className: "grad-flag eng" + (engOk ? " ok" : "") },
      el("input", { type: "checkbox", checked: engOk,
        onchange: (e) => { (_gradState.eng || (_gradState.eng = {}))[blkIdx] = e.target.checked; _gradSave(GRAD_STATE_KEY, _gradState); renderGrad(); } }),
      el("span", {}, ` 영어진행강좌 ${spec.english_min_courses || 1}과목 이상 이수 (직접 확인 — 강의언어 데이터 미수집)`)));
  }
  (spec.notes || []).forEach((n) => extra.append(el("div", { className: "grad-note" }, "· " + n)));
  sections.push(extra);

  // overall met/unmet for this entry (mirrors the bars shown)
  let ok = majorCr >= track.major_min_credits && reqDoneN >= reqTotalN && !suriIllegal;
  if (track.select_min > 0) ok = ok && majorSelRows.length >= track.select_min;
  if (selectMinCredits > 0) ok = ok && selectCredits >= selectMinCredits;
  if (track.general) {
    ok = ok && totalCr >= spec.total_credits && gyTotal >= ((ruleset && ruleset.total_min) || 0)
      && gyBuckets.every((b) => bucketCr[b.key] >= b.min
          && (!b.pick_min_areas || bucketAreas[b.key].size >= b.pick_min_areas)
          && (b.area_min || []).every((am) => am.ref || areaMinCr(b, am) >= am.min))
      && (spec.dept_required_general || []).every((g) => rows.some((r) => r.name === g.name) || gyRows.some((r) => r.name.includes(g.name)))
      && !!(_gradState.eng || {})[blkIdx];
  }

  const node = el("section", { className: "grad-block" },
    el("h2", { className: "grad-block-h" },
      el("span", { className: "gbh-mark " + (ok ? "ok" : "no") }, ok ? "✓" : "✗"),
      ` ${GRAD_TYPE_LABEL[entry.type] || ""} · ${spec.major} ${entry.year}학번 · ${track.name}`),
    ...sections);
  return { node, ok };
}

// ---------- wire up ----------
// ---------- pages (top-nav router) ----------
function showPage(name) {
  const pages = [...$$(".page")];
  if (!pages.length) return;
  if (!pages.some((p) => p.dataset.page === name)) name = pages[0].dataset.page;
  pages.forEach((p) => p.classList.toggle("active", p.dataset.page === name));
  $$("#topnav .nav-link").forEach((n) => n.classList.toggle("active", n.dataset.page === name));
  if (name === "trend") ensureTrend();   // lazy-init the trend page on first view
  if (name === "grad") renderGrad();     // recompute the audit each view
  window.scrollTo(0, 0);
}
function setupNav() {
  const nav = $("#topnav"); if (!nav) return;
  nav.replaceChildren();
  $$(".page").forEach((p) => {
    if (p.dataset.nav === "false") return;   // legal pages: footer-only, not in top nav
    const link = el("a", { className: "nav-link", href: "#" + p.dataset.page },
      p.dataset.title || p.dataset.page);
    link.dataset.page = p.dataset.page;
    link.onclick = (e) => { e.preventDefault(); location.hash = p.dataset.page; };
    nav.append(link);
  });
  window.addEventListener("hashchange", () => showPage((location.hash || "").slice(1)));
  showPage((location.hash || "").slice(1) || ($$(".page")[0] || {}).dataset?.page);
}

function init() {
  setupNav();        // build the nav from every .page partial that mounted
  buildFilters();   // construct the filter fields/dropdowns before anything fills them
  fillSelects();
  loadTerms();
  loadDepartments();
  loadClassifications();
  loadGrades();
  loadTimeStats();
  loadStatus().then((s) => {
    // if a refresh is already running (e.g. page reload), resume polling
    // ($("#refreshProgress") is absent on a production page without the admin panel)
    if (s && s.refresh && s.refresh.running && $("#refreshProgress")) {
      $("#refreshProgress").classList.remove("hidden");
      $("#refreshBtn").disabled = true;
      pollTimer = setInterval(pollRefresh, 1500);
    }
  });
  _seedActiveChanges();                       // instant banner from stored flags
  renderSheetsNow();                          // first paint synchronous (rAF may be parked if loaded hidden)
  renderTTNow();
  reconcileAll();                             // async: refresh all sheets vs latest catalog
  $("#searchForm").addEventListener("submit", doSearch);
  $("#filterToggle").addEventListener("click", () =>
    setAdvancedOpen(!$("#advFilters").classList.contains("open")));
  $("#year").addEventListener("change", updateScope);
  $("#term").addEventListener("change", updateScope);
  $("#clearTT").addEventListener("click", clearTT);
  $("#undoBtn").addEventListener("click", undo);
  $("#redoBtn").addEventListener("click", redo);
  $("#wishToggle").addEventListener("click", toggleWishPanel);
  $("#wishExport").addEventListener("click", exportWishlist);
  $("#wishImport").addEventListener("click", () => $("#wishImportFile").click());
  $("#wishImportFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importWishlist(e.target.files[0]);
    e.target.value = "";                     // allow re-importing the same file
  });
  renderWishlist();                          // seed the count
  $("#detailOverlay").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
  });
  const refreshBtn = $("#refreshBtn");   // admin panel — absent in production
  if (refreshBtn) refreshBtn.addEventListener("click", refreshDB);
  const cntBtn = $("#cntBtn");           // 인원 추이 collection (admin only)
  if (cntBtn) {
    cntBtn.addEventListener("click", () => runCounts(false));
    $("#cntForceBtn").addEventListener("click", () => runCounts(true));
  }
  $("#loadMore").addEventListener("click", loadMore);
  $("#expXlsx").addEventListener("click", () => exportSearch("xlsx"));
  $("#expCsv").addEventListener("click", () => exportSearch("csv"));
  $("#ttPng").addEventListener("click", exportTTPng);
  $("#ttExport").addEventListener("click", exportTTJson);
  $("#ttImport").addEventListener("click", () => $("#ttImportFile").click());
  $("#ttImportFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importTTJson(e.target.files[0]);
    e.target.value = "";   // allow re-importing the same file
  });
  $("#ttIcs").addEventListener("click", exportTTIcs);
  $("#ttGcal").addEventListener("click", exportToGoogleCalendar);
  $("#ttAddManual").addEventListener("click", () => $("#manualForm").classList.toggle("hidden"));
  $("#manualForm").addEventListener("submit", addManual);
  // default ICS range: config.js values, else today through ~16 weeks
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const today = new Date();
  const semEnd = new Date(today); semEnd.setDate(semEnd.getDate() + 112);
  const setDate = (el, val, fallback) => {
    el.value = (val || "").toString().trim();   // a malformed value is rejected -> ""
    if (!el.value) el.value = fallback;
  };
  setDate($("#icsStart"), window.ICS_DEFAULT_START, iso(today));
  setDate($("#icsEnd"), window.ICS_DEFAULT_END, iso(semEnd));
}
// force all coalesced renders + the deferred meta write to run NOW. Used by PNG export
// (reads live DOM geometry) and on page hide (so a pending meta write isn't lost).
function flushUI() {
  if (_sheetsRaf) { cancelAnimationFrame(_sheetsRaf); _sheetsRaf = 0; renderSheetsNow(); }
  if (_ttRaf) { cancelAnimationFrame(_ttRaf); _ttRaf = 0; renderTTNow(); }
  if (_cardsRaf) { cancelAnimationFrame(_cardsRaf); _cardsRaf = 0; refreshCardStatesNow(); }
  flushMeta();
}
addEventListener("pagehide", flushMeta);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushMeta(); });

// loader.js injects the partials and then appends this script, so the DOM is
// already parsed by now — run init immediately (don't wait for DOMContentLoaded).
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
