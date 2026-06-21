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

let sheets = [], active = 0;
let timetable = initSheets();   // sets sheets/active; timetable = active sheet's classes
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
// Catalog comes from prebuilt JSON in /data (index.json + one file per term), so
// the page needs no backend. The same files are served by the Python server too,
// so search/vocab work identically with or without it.
let _dataIndex = null;
const _termData = new Map();   // "year|term" -> [class rows]
async function dataIndex() {
  if (!_dataIndex) _dataIndex = await fetch("data/index.json").then((r) => r.json());
  return _dataIndex;
}
async function termRows(year, term) {
  const key = `${year}|${term}`;
  if (!_termData.has(key)) {
    const meta = (await dataIndex()).terms.find((t) => t.year === year && t.term === term);
    _termData.set(key, meta ? await fetch("data/" + meta.file).then((r) => r.json()) : []);
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
  if (f.grades?.length && !f.grades.includes(c.grade)) return false;
  const cls = c.classification || [];
  if (f.classifications?.length && !f.classifications.some((x) => cls.includes(x))) return false;
  if (f.levels?.length && !f.levels.some((x) => cls.includes(x))) return false;
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
  adv.append(grid);

  adv.append(el("div", { className: "adv-label" }, "과정"));
  adv.append(el("div", { className: "chips", id: "levelChips" }));
  adv.append(el("div", { className: "adv-label" }, "이수구분"));
  adv.append(el("div", { className: "chips", id: "typeChips" }));
  adv.append(el("div", { className: "adv-label" }, "학년"));
  adv.append(el("div", { className: "chips", id: "gradeChips" }));

  const empty = el("input", { type: "checkbox", id: "emptyOnly" });   // only classes that fit the free slots
  const timed = el("input", { type: "checkbox", id: "timedOnly" });   // only classes with a scheduled time
  adv.append(el("div", { className: "adv-checks" },
    el("label", {}, empty, " 빈 시간만"),
    el("label", {}, timed, " 시간 배정만")));
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
  updateScope();
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
const gradeLabel = (g) => (g === "0" ? "전학년 All-yr" : g);
async function loadGrades() {
  try {
    const { grades } = await dataIndex();
    fillChips("gradeChips", grades, gradeLabel);
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
    card.append(bar,
      el("div", { className: "rbody" },
        el("div", { className: "rname" }, c.name),
        el("div", { className: "rmeta" },
          `${sem ? sem + " · " : ""}${c.professor || "미정"} · ${c.department || "-"} · ${c.credits ?? "?"}학점${seats}`),
        el("div", { className: "rtime" }, times.length ? times.join("  ·  ") : "시간미정")),
      addBtn);
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
function initSheets() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHEETS_KEY));
    if (raw && Array.isArray(raw.sheets) && raw.sheets.length) {
      sheets = raw.sheets.map((s) => ({ name: s.name || "시간표", classes: s.classes || [] }));
      active = Math.min(Math.max(0, raw.active | 0), sheets.length - 1);
      return sheets[active].classes;
    }
  } catch { /* fall through to migrate */ }
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem(TT_KEY)) || []; } catch { /* none */ }
  sheets = [{ name: "시간표 1", classes: legacy }];
  active = 0;
  return sheets[active].classes;
}
function saveTT() {
  sheets[active].classes = timetable;   // keep the active sheet in sync
  localStorage.setItem(SHEETS_KEY, JSON.stringify({ version: 1, sheets, active }));
}
function switchSheet(i) {
  if (i === active || i < 0 || i >= sheets.length) return;
  saveTT();
  active = i; timetable = sheets[active].classes;
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
}
function addSheet() {
  saveTT();
  sheets.push({ name: `시간표 ${sheets.length + 1}`, classes: [] });
  active = sheets.length - 1; timetable = sheets[active].classes;
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
}
function deleteSheet(i) {
  if (sheets.length <= 1) { alert("마지막 시간표는 삭제할 수 없습니다."); return; }
  if (!confirm(`'${sheets[i].name}' 시간표를 삭제할까요?`)) return;
  sheets.splice(i, 1);
  if (active >= sheets.length) active = sheets.length - 1;
  else if (i < active) active--;
  timetable = sheets[active].classes;
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
}
function renameSheet(i) {
  const name = (prompt("시간표 이름:", sheets[i].name) || "").trim();
  if (!name) return;
  sheets[i].name = name; saveTT(); renderSheets();
}
function renderSheets() {
  const box = $("#ttSheets"); if (!box) return;
  box.replaceChildren();
  sheets.forEach((s, i) => {
    // click the active tab to rename it; click another to switch
    const tab = el("div", {
      className: "tt-sheet" + (i === active ? " active" : ""),
      title: i === active ? "클릭하여 이름 변경" : "클릭하여 전환",
      onclick: () => (i === active ? renameSheet(i) : switchSheet(i)),
    },
      el("span", {}, s.name),
      el("span", { className: "sheet-count" }, String(s.classes.length)));
    if (i === active) tab.append(el("span", { className: "sheet-pen", title: "이름 변경" }, "✎"));
    if (sheets.length > 1) tab.append(el("span", {
      className: "sheet-x", title: "삭제",
      onclick: (e) => { e.stopPropagation(); deleteSheet(i); },
    }, "×"));
    box.append(tab);
  });
  box.append(el("div", { className: "tt-sheet add", title: "시간표 추가", onclick: addSheet }, "＋ 시간표 추가"));
  updateHero();
}

// hero header: active sheet name + class count (credit total is set in renderTT)
function updateHero() {
  const a = sheets[active] || { name: "시간표", classes: [] };
  const n = a.classes.length;
  if ($("#activeName")) $("#activeName").textContent = a.name;
  if ($("#activeSub")) $("#activeSub").textContent = n ? `${n}개 강좌` : "비어 있음";
}

function addToTT(c) {
  if (timetable.some((x) => classKey(x) === classKey(c))) return;
  if ($("#blockOverlap")?.checked && overlapsBusy(c, timetableBusy())) {
    alert("이미 추가된 강좌와 시간이 겹쳐 추가하지 않았습니다.");
    return;
  }
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
  timetable = timetable.filter((x) => classKey(x) !== classKey(c));
  saveTT(); renderSheets(); renderTT(); refreshCardStates();
  if (detailClass) renderDetail();
}
function clearTT() {
  if (!timetable.length) return;
  if (!confirm("이 시간표를 비울까요?")) return;
  timetable = []; saveTT(); renderSheets(); renderTT(); refreshCardStates();
  if (detailClass) renderDetail();
}
function refreshCardStates() {
  if (lastResults.length) renderResults(lastResults);
}

// signature of a class's meeting times, for detecting catalog changes
function slotSig(slots) {
  return (slots || []).map((s) => `${s.day_index}-${s.start_time}`).sort().join("|");
}

// reconcile the saved timetable against the latest catalog: refresh changed
// times, flag time-changed / cancelled classes. Best-effort (skips if offline).
async function reconcileTT() {
  if (!timetable.length) return;
  let changed = false;
  try {
    const catalog = timetable.filter((c) => !c.manual);   // manual entries aren't in the catalog
    if (!catalog.length) return;
    const keys = catalog.map((c) => [c.year, c.term, c.sbjt_cd, c.lt_no]);
    const classes = await lookupLocal(keys);
    const cur = new Map(classes.map((c) => [classKey(c), c]));
    for (const c of catalog) {
      const now = cur.get(classKey(c));
      if (!now) {                       // gone from catalog -> cancelled
        if (!c.removed) { c.removed = true; changed = true; }
        continue;
      }
      if (c.removed) { delete c.removed; changed = true; }
      if (slotSig(c.slots) !== slotSig(now.slots)) {
        c.slots = now.slots; c.timeChanged = true; changed = true;
      } else if (c.timeChanged) {
        delete c.timeChanged; changed = true;
      }
    }
    if (changed) { saveTT(); renderTT(); refreshCardStates(); }
  } catch { /* server down: keep the saved copy as-is */ }
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

function renderTT() {
  const grid = $("#ttGrid"); grid.replaceChildren();
  // credits are stored as plain numbers, so the total is a direct sum (null = 0)
  const creditSum = timetable.reduce((s, c) => s + (Number(c.credits) || 0), 0);
  $("#creditSum").textContent = `총 ${creditSum}학점`;

  const nChanged = timetable.filter((c) => c.timeChanged).length;
  const nRemoved = timetable.filter((c) => c.removed).length;
  const notice = $("#ttNotice");
  if (notice) {
    if (nChanged || nRemoved) {
      const parts = [];
      if (nChanged) parts.push(`시간 변경 ${nChanged}`);
      if (nRemoved) parts.push(`폐강 ${nRemoved}`);
      notice.textContent = "최근 갱신 반영: " + parts.join(" · ");
      notice.classList.remove("hidden");
    } else {
      notice.classList.add("hidden");
    }
  }

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
    if (!r.error) { reconcileTT(); loadTimeStats(); }  // catalog changed
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

// loadable timetable file: our own JSON, re-imported by importTTJson below
function exportTTJson() {
  if (!timetable.length) { alert("시간표가 비어 있습니다."); return; }
  const blob = new Blob([JSON.stringify({ version: 1, timetable }, null, 2)],
    { type: "application/json" });
  downloadBlob(blob, "timetable.json");
}
function importTTJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const arr = Array.isArray(data) ? data : data.timetable;
      if (!Array.isArray(arr)) throw new Error("bad shape");
      timetable = arr.filter((c) => c && c.sbjt_cd && c.lt_no && c.name);
      saveTT(); renderSheets(); renderTT(); refreshCardStates();
    } catch { alert("불러올 수 없는 시간표 파일입니다."); }
  };
  reader.readAsText(file);
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
function exportTTPng() {
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
    ctx.font = "600 10px 'Noto Sans KR', sans-serif";
    ctx.fillText(e.childNodes[0] ? e.childNodes[0].textContent : "", b.x + 6, b.y + 11, b.w - 10);
    ctx.font = "9px 'Noto Sans KR', sans-serif";
    e.querySelectorAll("small").forEach((s, i) =>
      ctx.fillText(s.textContent, b.x + 6, b.y + 24 + i * 11, b.w - 10));
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
  try { data = await fetch("data/" + meta.trend).then((r) => r.json()); }
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

// ---------- wire up ----------
// ---------- pages (top-nav router) ----------
function showPage(name) {
  const pages = [...$$(".page")];
  if (!pages.length) return;
  if (!pages.some((p) => p.dataset.page === name)) name = pages[0].dataset.page;
  pages.forEach((p) => p.classList.toggle("active", p.dataset.page === name));
  $$("#topnav .nav-link").forEach((n) => n.classList.toggle("active", n.dataset.page === name));
  if (name === "trend") ensureTrend();   // lazy-init the trend page on first view
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
  renderSheets();
  renderTT();
  reconcileTT();
  $("#searchForm").addEventListener("submit", doSearch);
  $("#filterToggle").addEventListener("click", () =>
    setAdvancedOpen(!$("#advFilters").classList.contains("open")));
  $("#year").addEventListener("change", updateScope);
  $("#term").addEventListener("change", updateScope);
  $("#clearTT").addEventListener("click", clearTT);
  $("#detailOverlay").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
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
// loader.js injects the partials and then appends this script, so the DOM is
// already parsed by now — run init immediately (don't wait for DOMContentLoaded).
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
