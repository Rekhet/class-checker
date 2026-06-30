# 졸업요건 데이터 출처 & 추출값 (grad-req sourcing notes)

Where each major's graduation-requirement data lives + the extracted numbers, so authoring
`<dept>_<batch>.json` specs (or extending `scraper/grad_req.py`) skips the page/PDF discovery.

See also memory `feedback_grad_req_modeling.md` for the modeling rules (track-conditional,
credit-vs-count minimums, course substitution).

## Retrieval method (general)
- SNU dept pages are **static HTML** — plain `fetch()` works (WebFetch blocked here; ctx_fetch_and_index crashes on DNS, so use `ctx_execute` JS `fetch` + strip tags / parse `<table>`).
- Numbers are sometimes **in the page tables**, sometimes **in attached PDFs** linked as `/api/v1/file/<ts>_<name>.pdf`. Download the PDF (ctx_execute fetch → /tmp) and **Read** it (Read renders PDF; ctx can't parse PDF).
- PDF file URLs carry a timestamp prefix that can rotate — re-derive from the listing page, don't hardcode.
- Korean paths need `urllib.parse.quote(url, safe="%/:?=&#")` (python) — raw Korean breaks urllib.

---

## 통계학과 (stat) — DONE (specs exist)
- Pages: `https://stat.snu.ac.kr/교과과정/학사과정/교과목-이수규정/<batch>학번/` (index page lists per-batch links; slugs vary → read links, don't guess).
- 교양: each batch links a 자연과학대학 공통교육과정/교양 PDF. Two rulesets: **A** (학문의 토대/지성의 열쇠/베리타스) for 2025·2026; **B** (학문의 기초/학문의 세계 12) for 2021–2024.
- Encoded in `stat_2026 / stat_2025 / stat_2023_2024 / stat_2021_2022 .json`. 졸업130·전공60·교양46; 전선 ≥5과목 AND ≥(60−전필) 학점; 수리통계 M1399 대체 = 부전공만.

---

## 컴퓨터공학부 (cse) — RETRIEVED, spec NOT yet built (2026-06-22)
Pages (en):
- `…/academics/undergraduate/curriculum` — 전공 이수표준형태(course plan, `*`=전필) + 전공선택 인정과목.
- `…/academics/undergraduate/general-studies-requirements` — 교양 49 (table).
- `…/academics/undergraduate/degree-requirements` — 졸업 130 + links the 4 track PDFs below.

Track PDFs (linked from degree-requirements; 졸업규정 ▸ 주전공/복수/부전공):
주전공(단일전공).pdf, 주전공(다전공 병행).pdf, 복수전공.pdf, 부전공.pdf.

### 졸업 (공통)
- 졸업 **130학점** 이상. 전체 평점 ≥2.0, 전공 평점 ≥2.0.
- **외국어진행강좌 ≥3과목** (전공 1과목 이상 포함; 2008~, 2012~ 대학영어 제외) — stat은 1과목, CSE는 3과목.
- 생명존중(자살예방) 교육 졸업필수 (2016 이후 학번).
- 공대 공통과목 전 영역 **3학점** 필수(전필 인정) — 인정 리스트 PDF 별첨.
- 전공선택 인정과목: 전기·정보공학부 / 수리과학부 / 통계학과 / 연합전공 인공지능·AI반도체 중 학부장 인정 → **주전공 12학점, 복수전공 6학점**까지 (2026~ 산업공학과 제외). `400.XXX`·`M2177.*` 최대 9학점.

### 교양 49학점 이상 (CSE = 공대 ruleset, ≠ 자연대 46)
| 영역 | 학점 |
|---|---|
| 학문의 토대 · 글쓰기와 말하기 | 4 |
| · 외국어 | 6 |
| · 수학·과학·컴퓨팅 [수학] | 16 (미적분1·2+연습, 통계학+실험, 공학수학1·2) |
| · [과학] | 8 (물리/화학/생물 중) |
| · [컴퓨팅] | 3 (컴퓨터의 개념 및 실습) |
| 지성의 열쇠 | 9 (4개 영역 중 3개 영역 ≥9) |
| 베리타스 | 3 |
합 = 49.

### 전공 by track (2025~2026학번)
전필 8과목(단일): 이산수학·논리설계·컴퓨터프로그래밍·자료구조·컴퓨터구조·시스템프로그래밍·알고리즘 (각 3) + **공대 공통과목(3)** = 24학점.

| track | 전공 총학점 | 구성 |
|---|---|---|
| 주전공(단일전공)=심화 | **63** | 전필 24 + 전선내규필수 5 + 전선(나머지) — 전선 ≥39 |
| 주전공(다전공 병행) | **45** (복수·연합 병행) / **48** (부·연계 병행) | 전필 24 + 전선내규필수 5 + 전선 16(또는 19)↑ |
| 복수전공 | **39** | 전필 **21** (7과목, 공대공통 제외) + 전선 ≥18. 전선내규필수 없음 |
| 부전공 | **21** | 전필 9 (자료구조·컴퓨터구조·시스템프로그래밍·알고리즘 4과목 중 3) + 나머지 |

전선 내규필수(단일·다전공): 소프트웨어 개발의 원리와 실습(4) + [컴퓨터공학세미나(1) 또는 컴퓨팅 살펴보기(1)] 중 1.

### CSE vs stat 모델링 차이 (주의)
- 교양 = **49** (공대), 자연대 46과 다름 + [컴퓨팅] 영역(3) 존재.
- 전공 총학점 **63**(단일), stat 60과 다름.
- 전선 최소: CSE는 **학점 기반(63−24=39)**, stat처럼 "≥N과목" 카운트 min은 없음 (대신 전선내규필수 특정과목).
- 다전공 주전공은 **2차 전공 유형(복수/연합 vs 부/연계)에 따라 45/48로 분기**.
- 영어강의 ≥3과목 (stat 1).
- 복수/부전공 전필 집합이 단일전공과 다름 (공대공통 제외 등).

---

## 수리과학부 (math) — specs built 2021~2026 (math_2026/2025/2023_2024/2021_2022.json)
모든 학번 졸업표 동일(130/46/60/39/39/21, ctx 확인). 교양 struct: A(지성의 열쇠)=2025·2026, B(학문의 세계)=2021~2024 — stat과 동일한 2025 reform 경계. 졸업이수규정 wr_id: 2026=46, 2025=42, 2024=40, 2023=7, 2022=39, 2021=38.

- 페이지: `https://www.math.snu.ac.kr/bbs/page.php?hid=criteria` = GNUBOARD 메뉴(콘텐츠 JS 로드). 실제 규정 = `page.php?hid=criteria&wr_id=<N>` 게시물 (정적 HTML에 표 포함).
- wr_id 매핑: **46=2026 졸업이수규정**, 42=2025, 40=2024, 7=2023, 39=2022, 38=2021, 37=2019~2020, 43=교양과목 이수규정, 45=공통교육과정 영역·교과목 비교표.
- 2026 졸업이수학점표(통계학과와 동일): 졸업 **130** / 교양 **46** / 주전공 단일 **60** · 다전공 병행 **39** / 복수전공 **39** / 부전공·연계 **21**.
- 교양 = 자연대 46. (math 표는 수학 6-8 + 과학·컴퓨팅 16로 세분; spec은 수과컴 24 통합.)
- 전공필수(*, HTML 표준형태표): 해석개론 및 연습 1(M1407.000600)·2(M1407.000700), 현대대수학 1(881.301). spec은 카탈로그(수리과학부·전필)에서 전필 파생(현재 2과목 매칭: 해석개론및연습1·현대대수학1).
- 수리통계 대체 규칙 없음(통계학과 전용). 영어강의 ≥1(자연대).
- **전공선택 타학부 인정 (CORRECTED 2026-06-30):** wr_id=46/40/39/38 **본문 HTML 표**에 명시 = "타학부 인정과목: 자연과학대학 및 공과대학 개설 전공교과목 중 **최대 12학점까지 전공 인정(부전공 제외)**" — 2021~2026 전 학번 동일. (유의사항: 중복인정 9학점 + 타학부과목 포함 **총 12 초과불가**.) ⚠️ **이전 메모 "미게시·recog 없음"은 오류** — wr_id=46 *첨부 이미지 3장*(자연대 공통교육과정 reference: 교양 46표/진단면제/미적분 원칙)만 보고 **게시물 본문의 이수규정 표를 놓침**. 4개 spec = `external_recognition.colleges:["자연과학대학","공과대학"]` + recog_max `[12,12,12,0]`(부전공 0). 수리과학부 자체 과목은 own-dept(isStat L2441)로 인정 제외 → 중복계산 없음. 트랙 학점(60/39/39/21)·전필 차이는 카탈로그 파생.

---

## 교양(공통교육과정) 단과대학·학부별 이수규정 — 기초교양 수강편람 2026-1 (authoritative)
출처: SNU 「2026학년도 1학기 기초교양 수강편람」 PDF (공통교육과정 안내). 단과대학·학부(과)별
교양 이수규정 = 본문 p48~94. 공통교육과정 **교과목→영역 목록** = p24~39 (교양 자동 분류용 코드↔영역 맵 — 현재 client는 이름 패턴 매칭, 이 목록으로 대체 가능). 부록6 = 학사과정 영어진행강좌 목록(강의언어 데이터 보완원), 부록7 = 대학별 외국어진행강좌 수강의무(영어강의 최소 과목수).

### 교양 schema (구현됨) — 단일 소스 + 어댑터
- **소스 of truth (full granularity)**: **`gyo/area_codes.json`** = `{codes:{접두사→세부영역}, exceptions:{sbjt_cd→세부영역}}`. SNU 코드가 영역 인코딩이므로 접두사 규칙이 완전+세분; 규칙을 벗어나는 과목만 `exceptions`에 명시(현재 없음). 세부영역은 전부 분리 보관(math≠stat≠physics… , culture/history/human/scisense, x_*). 단 한 곳에만 저장.
- **어댑터 (단대/학부별, self-contained)**: **`gyo/<college>.json`** = `{total_min, buckets:[{key,name,min,areas:[세부영역],pick_min_areas?}]}`. 각 어댑터가 소스의 세부영역을 자기 버킷에 **할당(allocate)** + 최저학점 설정. 할당이 단대마다 다르므로(자연대 수과컴 통합 / 공대·전문대학원 수학·과학·컴퓨팅 분리) 어댑터가 소유.
- **공과대학·사범대학은 학부(과)별로 교양요건이 달라 어댑터를 학부(과)마다 분리** (eng_* 12개, edu_* 9개). 공통 `eng_2025` 같은 묶음 어댑터는 두지 않음.
- 한 세부영역은 **버킷 1개에만** 속해야 함(클라이언트 `bucketOf`가 첫 매칭 버킷 반환). 어댑터 버킷의 areas는 상호 배타적이어야 함. 어느 버킷에도 없는 세부영역 = total_min 자유선택분으로만 계상.
- spec은 `"general":"<rulesetId>"`로 어댑터 참조. 클라이언트: 교양 강좌 → (exceptions||접두사) 세부영역 → 어댑터 버킷.

- **`gyo/area_codes.json`** — sbjt_cd 접두사(`.` 앞)→세부영역 맵. **실제 class 데이터 sbjt_cd = 카탈로그 번호와 동일** (예: `E52.103`, `F31.201` — 검증 완료). 2025~ 코드 체계(수강편람 p24~39): 글쓰기 **F11/F12**, 외국어 **F21~F29**, **F31**=수학·**F32**=통계·**F33**=물리·**F34**=화학·**F35**=생물·**F36**=지구·**F37**=컴퓨팅, 지성의열쇠 **C10**문화/**C20**역사/**C30**인간/**C40**과학적사고, 베리타스 **V10/V20/V30**, 지성의확장 **E11/12**=지식(x_knowledge)·**E20**=공감과공존/사회봉사(x_engage)·**E31/32**=자율과창의(x_creative)·**E41/42/43**=예술과체육(x_arts)·**E51/52**=학부생세미나(x_seminar). 레거시 L04xx(2014~24)·0xx(2014이전)도 포함.
- **exceptions(접두사 규칙 예외)**: `E52.103`/`E52.104` 소그룹 고전원전읽기 → `x_classics` (학부생세미나 중 고전원전읽기만 분리; 인문대 지성의확장 정확 매칭용).
- **`gyo/<college>.json`** — 단대 ruleset: `{total_min, buckets:[{key,name,min,areas:[fine],pick_min_areas?}]}`. **2025·2026 적용 전 단과대학·학부(과) 어댑터 작성 완료(43개)** — 아래 인덱스 표 참조.
- spec은 `"general":"<rulesetId>"`로 참조 (인라인 general_areas 대체). 클라이언트가 교양 강좌를 코드 접두사→세부영역→버킷으로 자동 분류(수동 override 유지). 현재 `cse_2026.json`만 `eng_cse_2025` 참조; 나머지 어댑터는 전공 spec 작성 시 연결.
- stat/math/cse 9개 spec 마이그레이션 완료. (구 `general_areas`/`general_min_credits` 필드는 사용 안 함 — 추후 정리 가능.)

**교양 영역 set (2025~ 공통):** 학문의 토대[글쓰기와 말하기 / 외국어 / 수학·과학·컴퓨팅(공대·자연대는 [수학]·[과학]·[컴퓨팅]로 세분)] · 지성의 열쇠[문화 해석과 상상 / 역사적 탐구와 철학적 사유 / 인간의 이해와 사회 분석 / 과학적 사고와 응용 → **4개 중 3개 영역 9학점**] · 베리타스 3 · (일부 단대) 지성의 확장[공감과 공존(사회봉사) / 예술과 체육 / 진로설계] · 전체 교양(자유선택).

**어댑터 인덱스 (2025·2026, 43개).** `key+min` 표기, `/pN` = pick_min_areas. 모든 학번 공통 floor: 글쓰기·외국어·지성열쇠 9(4중3)·베리타스 3. `msc` = 수·과·컴 통합 / `math`+`science`(+`computing`) = 분리. `extension`=지성의 확장(공감·창의·예술체육·세미나·고전), `arts`=예술과 체육(x_arts), `classics`=고전원전읽기(x_classics), `world`=학문의 세계(2021~24 레거시).

| id | 단대/학부 | 총 | 버킷 |
|---|---|---|---|
| `hum_2025` | 인문대학 | 36 | writing4 foreign12(제2외9+영어3) msc3 claves9/p3 veritas3 classics2 |
| `soc_2025` | 사회과학대학 | 36 | writing4 foreign6 msc3 claves9/p3 veritas3 |
| `ub_wide_2025` | 학부대학(광역) | 36 | writing4 foreign6 msc3 claves9/p3 veritas3 |
| `ub_free_2025` | 학부대학(자유전공) | 36 | writing4 foreign6 msc6 claves9/p3 veritas3 engage1 |
| `natsci_2025` | 자연과학대학 (2025·26) | 46 | writing4 foreign6 msc24 claves9/p3 veritas3 |
| `natsci_2022` | 자연과학대학 (2021~24) | 46 | writing4 foreign6 msc24 world12 |
| `nursing_2025` | 간호대학 | 36 | writing4 foreign6 science8 claves12/p3 veritas3 |
| `biz_2025` | 경영대학 | 36 | writing4 foreign6 msc10 claves9/p3 veritas3 arts1 |
| `eng_cse_2025` | 공대 컴퓨터공학부 | 49 | math16 science8 computing3 |
| `eng_mech_2025` | 공대 기계공학부 | 49 | math12 science12 computing3 |
| `eng_civil_2025` | 공대 건설환경공학부 | 50 | math12 science12 computing3 engage1 |
| `eng_arch_2025` | 공대 건축학과 | 40 | math6 science12 (컴 버킷 없음) |
| `eng_ie_2025` | 공대 산업공학과 | 52 | writing7 math16 science8 computing3 |
| `eng_nuclear_2025` | 공대 원자핵공학과 | 53 | math12 science16 computing3 |
| `eng_energy_2025` | 공대 에너지자원공학과 | 49 | math12 science12 computing3 |
| `eng_mse_2025` | 공대 재료공학부 | 49 | math12 science12 computing3 |
| `eng_ee_2025` | 공대 전기·정보공학부 | 53 | math12 science16 computing3 |
| `eng_naoe_2025` | 공대 조선해양공학과 | 49 | math12 science12 computing3 |
| `eng_aero_2025` | 공대 항공우주공학과 | 49 | math12 science12 computing3 |
| `eng_cbe_2025` | 공대 화학생물공학부 | 53 | math12 science16 computing3 |
| `agri_econ_2025` | 농생 인문계(농경제사회학부) | 36 | msc3 |
| `agri_smartsys_2025` | 농생 자연계(스마트시스템과학과) | 42 | math6 science8 computing6 |
| `agri_sci_2025` | 농생 자연계(스마트시스템 제외) | 36 | math6 science8 |
| `art_2025` | 미술대학 | 36 | msc3 |
| `edu_hum_2025` | 사범대 교육·국어·영어·불어·독어·사회·지리·윤리교육과 | 36 | msc3 arts2 |
| `edu_pe_2025` | 사범대 체육교육과 | 36 | msc3 (arts 면제) |
| `edu_history_2025` | 사범대 역사교육과 | 36 | msc3 arts1 |
| `edu_math_2025` | 사범대 수학교육과 | 41 | math6 science8 computing3 arts2 |
| `edu_physics_2025` | 사범대 물리교육과 | 39 | science16 arts1 |
| `edu_chem_2025` | 사범대 화학교육과 | 45 | science16 mathcomp6 arts1 |
| `edu_bio_2025` | 사범대 생물교육과 | 45 | science16 mathcomp6 arts1 |
| `edu_earth_2025` | 사범대 지구과학교육과 | 44 | msc21 arts1 |
| `edu_fusion_2025` | 사범대 융합학습과학전공 | 36 | msc6 arts2 |
| `human_consumer_2025` | 생활대 소비자학전공 | 40 | msc4 claves12/p4 |
| `human_child_2025` | 생활대 아동가족학전공 | 36 | msc3 claves12/p4 |
| `human_food_2025` | 생활대 식품영양학과 | 40 | writing7 msc15 |
| `human_textile_2025` | 생활대 의류학과 | 40 | writing7 msc6 |
| `music_2025` | 음악대학 | 36 | msc3 |
| `pharm_2025` | 약학대학 | 36 | math3 science8 computing3(+stat) |
| `vet_2025` | 수의과대학(수의예과) | 42 | math3 science4 extension7 |
| `med_2025` | 의과대학(의예과) | 41 | writing7 math3 science8 |
| `ace_2025` | 첨단융합학부 | 48 | msc20 claves12/p4 veritas6 |
| `dent_2025` | 치의학대학원 학사과정 | 44 | math3 science12 computing3 |

- 출처 페이지: 단대·학부별 표 = 수강편람 p48~93 (p94 = 수강신청 유의사항). `cse_2026.json`만 어댑터 연결됨; 나머지는 전공 spec 작성 시 `"general"`로 연결.
- ⚠ **공대·사범대는 학부(과)별 총학점/수과컴 상이** (공대 40~53, 사범 36~45). 신규 학부(과) 인코딩 시 수강편람 해당 표 재확인.
- 지성열쇠 `pick_min_areas` 근사: `/p3`이 "특정 3영역"인 단대(자연대·공대 대부분·식품영양·의예 = 문화·역사·인간, 과학적사고 제외)도 "아무 3영역"으로 처리 / `/p4`(소비자·아동·첨단융합) = 전 4영역 각 3 / `nursing /p3`은 "인간 필수 + 문/역/과 중 2영역" ≈ 3영역. min(학점)은 정확, 영역 *지정*은 스키마 미표현.
- 예술과 체육(`arts`)·체육(`extension`)은 area_codes에서 모두 `x_arts`로 매핑(예술 vs 체육 미분리) — 단대가 '체육만' 요구해도 예술로 충족 처리됨(소스 granularity 한계, 허용).
- **검증 완료(2026-06-22)**: 전 43개 어댑터를 수강편람 p48~93 원문과 교차검증 + 클라이언트/배선 3-way 리뷰 + live preview(natsci·cse 어댑터 렌더 확인). 수정 = hum 외국어 9→12(제2외9+영어3, 전체3 reconcile 확인), nursing science 영역에서 math/stat/computing 제거·지성 /p2→/p3, 고전원전읽기 `x_knowledge`→`x_classics`(E52.103/104 = 학부생세미나, 코드목록 p39 확인), **eng_arch science 영역에서 computing 제거**(건축 p60 = 수6~9+과12, 컴퓨팅 요건 없음 → computing은 자유선택). 클라이언트(app.js): 수동 override 시 영역 카운트 오염 방지 guard 추가, dead `_gradAutoArea` 제거.
- 영어강의 최소 과목수: 부록7(대학별 외국어진행강좌 수강의무) 기준 — 자연대 stat 1과목, 공대 cse 3과목.
- ⚠ **`total_min_diagnostic`(natsci_2025·natsci_2022 = 36)**: 자연대 「기초수학과학 진단평가」 면제자의 감면 floor(교양 46→36, 수과컴 24→최저8, 수강편람 p53~54). **현재 client(app.js)는 미적용** — 면제자도 46/24로 표시. 적용하려면 진단평가 면제 토글 + 버킷별 diagnostic min 필요. 데이터는 future-ready로 보존.
- 레거시 코드맵 출처 = 수강편람 p24 「공통교육과정 교과목 목록」 (F/C/V/E ↔ L04xx ↔ 0xx 크로스워크, authoritative). 검증: 043(pre-2014)→human 정정(2026-06-22). L0548(2014~24 인간의이해) 미매핑은 의도적 보류.

### 과거 학번 (PDF에 함께 표기 — 미추출 상세)
단일전공: 2021~2024 전공63(전필30+내규8), 2020 전공63(전필31+내규8), 2019 전공63(전필35+내규4) — 전필 과목/학점 구성이 해마다 다름. 복수/부전공도 학번별 표 존재. 새 batch 인코딩 시 해당 PDF의 해당 학번 행 확인.

---

## 전공(major) 졸업요건 발굴 — 단과대학별 학과 사이트 (2026-06-23 스크레이프)
출처 진입점: https://www.snu.ac.kr/academics/undergraduate/colleges (학과별 `*.snu.ac.kr` 링크, static HTML, curl OK). 학과 95개 인벤토리. 학과 사이트는 졸업요건을 **HTML 표 / PDF / 이미지 / JS-SPA**로 제각각 노출 — 아래는 페이지 위치 + HTML로 뽑힌 숫자. **PDF/이미지/SPA = URL만 기록, 미파싱**(spec 작성 시 해당 PDF 직접 Read). 공통 baseline(검증 전 가정): 졸업 130 / 자연·공대 영어강의 ≥1~3과목 / 교양은 단대 어댑터 이미 존재.

### 공과대학 (eng_*, 교양 어댑터 완비; 전공 = 대부분 PDF/SPA)
공통 공대 모델(cse 기준, SOURCES 상단): 졸업130 · 주전공단일(심화)63 · 다전공 주전공45/48 · 복수39 · 부전공21 · 영어강의≥3 · 공대공통3(전필인정) · 생명존중(2016~).
| 학부 | 졸업규정 페이지 | 형태 | 비고 |
|---|---|---|---|
| 기계 me | me.snu.ac.kr/학부-졸업규정/ | **PDF/학번** (2019~2026 + 다전공 별도 2020~2026) | 전필: 고체역학 M2794.001000·열역학 .001100·동역학 .001200·유체역학 .001300·역학과설계 .001400. 트랙(로보틱스/모빌리티/스마트제조/에너지환경) |
| 항공우주 aerospace | /undergraduate/requirements (+/rule,/curriculum) | **PDF/학번** 2016~2026 + 복수·부전공 PDF | 다운 `/download?ac=<hash>` |
| 재료 mse | /snumse-main/education/undergraduate/undergraduate-course-offerings/ | 교과목표=HTML, **졸업총학점=PNG 이미지** | 전공표 코드·학점 HTML, totals 이미지 |
| 전기정보 ece | /academics/undergraduate/requirements (+/curriculum) | **PDF/연도** ~2001~2026(seqidx1~26) + 복수부전공 PDF + 자유전공 PDF | 교양 53 |
| 산업 ie | ie.snu.ac.kr/undergrad_regulation/ (+/undergrad_course/) | **PDF 내규** | 「학부생 교과목 이수 및 졸업 학과내규 2026.04」.pdf = authoritative. cse 전선 인정과목서 2026~ ie 제외. 교양 52(글7) |
| 에너지자원 ere | ere.snu.ac.kr/sub4_3_a.php (교과=sub4_1_a.php) | HTML/php (미추출) | board sub4_1_d wr_id 1,3~7 |
| 원자핵 nucleng | /undergraduate/rule (+/curriculum) | **PDF/학번** 2015~**2025**(2026 미게시) | 교양53 |
| 조선해양 ship | /department/rule (졸업 PDF bbsidx13320) · /department/curriculum | **PDF** + 전공표 **AJAX** | curriculum 학점 API-fed |
| 건설환경 cee | cee.snu.ac.kr (GoPage SPA) | **SPA-blocked** | 브라우저 렌더 필요. 교양 eng_civil_2025=50(+engage 사회봉사) |
| 화학생물 cbe | /cbe/main/contents.do?menuNo= | **SPA-blocked** | 이수체계도/교육과정자료실 메뉴. 교양53 |
| 건축 architecture | React/Vite SPA | **SPA-blocked** | ⚠ 5년제 건축학+건축공학 = **비표준**(130/63/39 미적용 가능). 교양 eng_arch_2025=40(컴 버킷 없음) |
| 컴퓨터 cse | (spec 완료) | — | 130/63/45/39/21 기준 모델 |
- 공대 교양 총학점이 학부별 40~53로 갈림 = 전공 weighting도 다름 신호. **건축 = 별도 구조 우선 확인**.
- curl-blocked(SPA): cee·cbe·architecture → 브라우저(Claude_Preview snapshot/eval) 필요.

### ⭐ 전공 track-credit 모델 = 단과대학별 상이 (핵심 발굴, 2026-06-23)
spec의 트랙 학점은 **단대마다 다른 baseline** 따름 (cse 130/63/45/39/21이 universal 아님). 학과 사이트 HTML/PDF에서 교차검증:
| 단대 | 졸업 | 주전공 단일(심화) | 다전공 주전공/병행 | 복수 | 부전공 | 영어강의 | 비고 |
|---|---|---|---|---|---|---|---|
| 인문 | 130 | 60 | — | 39 | 21 | ≥3 + 제2외국어9 | 노문·서문 다전공=42 |
| 사회 | 130 | 60 | — | 39 | 21 | 폐지~varies | 2026 전필 축소·폐지 다수(지리·언론) |
| 경영 | 130 | 60(심화=전필27+전선33) | — | 39(23+16) | 21 | 5(저TEPS) /3 | |
| 자연 | 130 | 60 | 39 | 39 | 21 | ≥1 (물리 5권장·생명 3필수) | stat/math와 동일 |
| 공대 | 130 | **63/62/59**(아래) | 45/48 | 39 | 21 | ≥3 + 공대공통3 | 건축=비표준(5년제) |
| 첨단융합 | 130 | 60 | 48(병행) | 39 | 24 | — | 5개 전공 per-전공 전필 |
| **농생(CALS)** | 130 | **48** | 48 | 48 | 24 | 3 | **교양36**, 단대 uniform |
| 사범 | 130 | 60(교육학 62) | 52(다전공) | 52 | 21~36(과별) | 9(체육 10) | **+교직 ~22(2024~ 23, 디지털교육1)** |
| 생활 | 130 | ~? | 48(병행) | 39 | 24 | 3 | |
| 간호 | 130 | **track 없음·전공 85**(전필76+자유9) | — | — | — | — | 2019이전=140/96 |
| 약학 | **211(6년제)** | 교양36+전필110+전선64 | — | — | — | — | 등록 12회+ |
| 수의·의 | **6년제 예과+본과** | (학부 학점 미추출) | — | — | — | — | image/SPA-blocked |

### 단대별 전공 발굴 상세 → `_scrape/<college>.md` (학과별 졸업/전공/전필코드/SOURCE URL)
- **`_scrape/hum.md`** (인문, 12과): 10과 HTML 완전(국문·중문·영문·독문·노문·서문·언어·역사·미학·종교 — 130/60/39/21 + 전필 코드, 역사 track-conditional). 아시아 partial(총학점 JS). 철학 SPA(euc-kr frameset).
- **`_scrape/soc.md`** (사회+경영+자유전공+첨단융합, 10): 全 10 숫자 확보. HTML 6(정외 전선51·심리 60/39·지리 130/36/60/39·언론·사복·사회). PDF読 4(경영 4트랙·경제 전필15·자유전공 자체전공15·첨단융합 5전공). gotcha: cba/econ `/download` = **Referer 헤더 필요**.
- **`_scrape/natsci.md`** (자연대, 5): 5/5 HTML, 全 130/60/39/39/21. chem `/academics/undergraduate/degree`, biosci `/academics/curriculum/undergraduate`, sees `/academics/undergraduate/curriculum-major`. 전필 물리15·생명13 코드.
- **`_scrape/agri.md`** (농생, 8학부/12전공): CALS uniform 130/36/48/48/24. 12전공 HTML(`*`전필 코드). blocked 4(작물생명·산림 2과 WP-JS·농경제). smsys = 사이트 broken(외부 404). ⚠ 전공 renamed: 산림과학부→산림환경학+환경재료과학, 농경제사회→농업자원경제+지역정보.
- **`_scrape/edu.md`** (사범, 15): 11 HTML(단일60/교육62, 다전공52, 전필 코드, 교직22). blocked 3(영교 DOCX만·불교 kBoard JS·지구과교 WAF). gotcha: socialedu·ethics = `curl -4 -k`(IPv6/cert), engedu = EUC-KR.
- **`_scrape/misc.md`** (생활·미술·음악·수의·약·의·간호, ~20과): HTML 6(생활대 4 + 간호 + 약학). 미술 5과 = 전필코드만(총학점 off-site). **SPA-blocked: 음악 6과 + 의예/의학**(egov AJAX). **image-only: 수의**(JPG 교과과정). 비표준: 간호 85·약학 211·수의/의 6년제.

### 스크레이프 gotcha (재사용)
- `/download?ac=<hash>` /`/download/<hash>` 첨부 = **`-H "Referer: <listing-page>"`** 없으면 404 (cba·econ·aerospace).
- 일부 학과 = `curl -4 -k` 필요 (IPv6 라우팅/인증서 실패 → code 000): socialedu·ethics.
- 인코딩: engedu(영어교육) = EUC-KR. euc-kr frameset stub: philosophy.
- 완전 미추출(브라우저/OCR 필요): cee·cbe·architecture·music(6과)·medicine·vet(JPG)·철학·smsys. → **2차 브라우저 발굴로 대부분 해소(아래).**
- 커버리지: 95 major 중 학과사이트 53개 섹션 + 공대 12 = **~65 전공 숫자/위치 확보**, 잔여 = SPA·이미지·6년제 임상.

### 2차 발굴 — 브라우저 렌더(headless chromium) 2026-06-23
도구: `web/data/grad_req/_scrape/ext.js` (cached chromium, MCP 우회) + `_scrape/METHOD.md` 플레이북. 상세 = `_scrape/{eng,music,medvet,partial}_browser.md`.
- **공대 SPA 해소**: cbe 졸업130/교양53/**전공62**/영어3(전선 학부4과목 필수) · cee 130/**전공62**(학부54)/병행48/공대공통3/영어3 (GoPage→`/sub3_1_b.php` inline) · **건축 = 비표준**: 건축학(5년제) 졸업**160**(교양40+전공110/전필102), 건축공학(4년제) 졸업**130**(교양40+전공73/전필60), 영어3 (REST `getPosts`→**HWP 첨부**, olefile 파싱).
- **음악대학 6과 해소**: 졸업130·교양36 공통, "전공학점"=전필 only(실기 반복이수 heavy) — 성악 전필68→70, 작곡 전필65(지휘74), 음악학 전필46(복수46/부전30), 피아노 전필47+전선10(복수45/부전26), 관현악 관악 전필68~74·현악72(복수62), 국악 주전공계60~61(복수38/부전31). 영어강의 명시 = 관현악(전공2+4학점)·국악(26~ 1강좌)뿐. src=`/rule` GNUBOARD nonce 첨부(pdf/hwp).
- **의·치·수의 = 학부 졸업학점 사이트 미게시**(교양 어댑터 med41/dent44/vet42가 예과/학사 교양분 cover): 의과 교과과정=PNG차트 1장(`img-curriculum2026.png`)·의학과 board=대학원전용. **치의학 host=`dentistry.snu.ac.kr` 확정**(nttId=14, 학사3년+전문석사4년=7년, 교양 legacy B; 학사 졸업학점 미게시, 전문석사=165/8학기). 수의=연차별 JPG(prevet1/2·vet1-4)+졸업성과JPG, graduate_rules=대학원전용. → **정확 학부 졸업학점은 SNU 학칙/요람 필요**(dept 사이트엔 없음).
- **partial 해소 3 + 전필 1**: 아시아언어문명 130/주전공39(전필6+전선33)/복수39/부전공21/제2외9/영어3 (kBoard uid=319) · **농업자원경제전공** 130/단일60/다전공39(경제학위 인문계 모델, are.snu.ac.kr) · **지역정보학전공** 130/단일48/복수48/부전공24(CALS, ris.snu.ac.kr) · 불어교육 전필8과목 codes. ⚠ **농경제사회학부 = 전공별 track 상이**(농경제 60/39 vs 지역정보 48/48) — CALS uniform 48 가정은 부분만.
- **잔존 off-site/blocked(6, 단대 baseline 추론·학칙 필요)**: 영어교육(교과=2017 이미지만)·지구과학교육(admin-ajax→`snucert/waf/error.html` WAF 확정)·미술 5과(졸업총학점·track 사이트 全無)·철학(졸업규정 페이지 부재)·smsys(교과메뉴 없음, `http://` 80포트만 200)·산림과학부 2과(전공소개 prose only).
- **METHOD.md 신규 패턴**: GNUBOARD 인증서무효 = `http://`(80) 재시도 / 학부가 전공별 WP+학사 program PDF(raw href)로 분리(aerd→are+ris) / `admin-ajax→snucert/waf/error.html`=WAF / HWP 첨부 = olefile OLE5 파싱(LibreOffice HWP필터·pyhwp 불가).
- **2차 net**: 공대 SPA 3 + 음악 6 + partial 3+1 = **~13 major 신규 확보**; 의·치·수의·미술·영교·지구과교·철학·smsys·산림 = dept 사이트에 학부 졸업학점 부재 확정(학칙/요람 소관) — 교양 어댑터는 전부 완비.

### 3차 발굴 — 리뷰 루프 gap-fill (review_r1~r4, 2 consecutive CLEAN으로 종료)
1차 발굴서 "공대 12 covered"는 false-positive였음 — cse/cbe/cee/architecture만 숫자 있었고 8개는 page-location만. 리뷰 루프가 PDF/HWP/nonce-board에서 실수치 확보:
- **공대 단일전공 = 3-way split (확정, PDF 검증)**: **63** = cse·전기정보(ece)·조선해양(ship) / **62** = 기계(me)·에너지자원(ere)·원자핵(nucleng,2025최신)·항공우주(ae)·화학생물(cbe)·건설환경(cee) / **59** = 산업(ie, 학과내규 2014~). 재료(mse)=totals 사이트 부재(PNG)→baseline. 건축=비표준 5년제160/4년제130.
- **공대 병행/복수/부전공**: 항공 병행42 · 전기정보 복수45/부48 · 기계 복수45/부48 · 조선 병행48 · 산업 전필28+전선21 · cee 병행48. 전필 학점·코드 = 각 PDF.
- **독어교육과**(edu.md서 누락) 추가: 전필 6과목 codes, 학부 totals 사이트부재→사범 baseline.
- **화학부** 복수39/부21 = xlsx 졸업요건으로 추정→확정.
- **농경제사회학부 = 전공별 track 상이 확정**: 농업자원경제 60/39(are.snu.ac.kr) vs 지역정보 48/48(ris, CALS). 학부 uniform 가정 폐기.
- 루프 결과 = **review_r4.md 종료**: 66 major 전수 addressed(silent absence 0), 확정 13 blocked(의·수의·치의·미술5·철학·영교·지구과교·smsys·작물생명·산림2·mse·nucleng-2026미게시)는 dept-page exhausted+documented attempt. r4서 농경제60/39·아시아39·항공62/42·전기정보63 primary PDF 재검증(hallucination 0).

### 산출물 (`_scrape/`)
- `METHOD.md` = 추출 플레이북(ext.js 사용법·사이트 패턴·gotcha) ; `ext.js` = headless chromium 렌더러(`node ext.js <url> [waitMs] [__links__]`).
- 1차 학과사이트 발굴: `hum/soc/natsci/agri/edu/misc.md`. 2차 브라우저: `eng/music/medvet/partial_browser.md`. 리뷰: `review_r1~r4.md`(major→status map + fills + 검증).
- **커버리지 최종**: 학부 졸업/전공학점 확보 = 인문10·사회10·자연7·농생13·사범13·생활4·간호·약·경영·자유전공·첨단융합·음악6·공대11(mse제외)·아시아·농경제2 ≈ **80+ major**. 미확보(=dept site에 부재, 학칙/요람 필요) = 의·수의·치의 학부학점·미술5·철학·영교·지구과교·smsys·산림2·mse·기계계열 일부 전필 = 교양은 전부 완비.

---

## 전공 spec(`<id>_2026.json`) 작성 완료 (2026-06-23) — 81 major
발굴 데이터(`_scrape/*.md`)로 per-major spec 작성 + `index.json` 등록 + 브라우저 검증(no JS error). 총 **87 spec 파일 / 81 major / index 170 entries**. 전부 `cse_2026` 모델(per-track `required.all` + `required_credits`) 채택 — 노이즈 많은 catalog 전필 match를 우회.

### 핵심 설계 결정 (재현용)
- **전필 = `track.required.all` (코드+credits) 우선** (app.js:2245). catalog `major_required_match` 자동 derivation은 **노이즈 큼**(화학부 14과목 over-pull, 물리·천문 전공union, 지구환경 0) — 검증으로 확인. 따라서 _scrape에 전필 코드 있으면 `required.all`에 명시, `required_credits`로 전필 학점 고정. 코드 없으면 omit + notes 기록(전필은 catalog/none, 학점 bar는 정상).
- **공유 dept 전공**(물리/천문 = `물리·천문학부`): `required.all`이 explicit이라 전공별 분리 spec 정상 작동(전선만 학부 dept 공유, 학생 실수강 기준이라 무방). 검증: physics 전필 0/4(천문 union 아님), 전공선택 0/45(=60−15). ✓
- **catalog dept 문자열**(`major_select_match.departments`)은 `data/classes/index.json` departments(187개)와 정확 일치 필요(client `dept.includes()`). 중점(·) 보존: `물리·천문학부`·`식품·동물생명공학부`·`바이오시스템·소재학부`·`조경·지역시스템공학부`·`전기·정보공학부`. 학과명 그대로(소비자학과·아동가족학과 등 학부 아닌 과 문자열 사용).
- **track 모델 = 단대별** (위 ⭐표): 인문·사회·자연 60/39/21 · 경영 60/39/21(심화 전필27) · 공대 63/62/59 + 병행45/48 · 농생 CALS 48/48/24(농경제 60/39) · 사범 60(교육62)/52/과별부전공 + 교직 note · 생활 60/병행48/복수39/부24 · 음악 전공=전필 실기(46~74, 과·세부전공별) · 간호 단일85(no track) · 약학 6년제 211/전공174 · 건축 5년제 160/전공110(+건축공학 130/73 note).
- **교양** = `general:"<gyo adapter>"` (이미 완비된 43개 중 해당 단대/학부). 검증서 졸업/전공/교양/전필 bar 전부 정상 렌더.

### spec별 정확도 (notes에 기록)
- **전필 코드 완비**(required.all): chem4·biosci6·physics4·astron6·asia2·econ5·psych2·comm4·socwelf1·biz7·cee6·me6·koredu9·socedu9·bioedu14·chemedu15·physedu9·earthedu8·orient4·western10·consumer2 등.
- **전필 학점만**(required_credits, 코드 미게시): arch102·ie28·ere33·naoe30·ece32·pedagogy6·histedu18·geoedu15·mathedu15·음악 6과·nursing76·pharm110·cls8·ace6·socio15·sees(none).
- **baseline-assumed**(사이트 부재, ⚠ notes flag): 미술5과(orient/western 전필만, 나머지 totals 추정)·mse(재료)·영/불/독교육·철학·smsys·forestsci. 학칙/요람 또는 표준형태 PDF로 보강 가능.
- **미생성**(dept site 학부 졸업학점 부재): 의예/의학·수의예/수의학·치의학(교양 어댑터만 존재).
- **잔여 정밀화 TODO**: 농생 학부 spec은 전공별(작물생명/원예 등) 미분리(학부-level union); 물리/생명 등 batch별 전필 변천 미반영(현행만); 음악 세부전공(작곡 지휘74 등)·건축공학 분기 = notes만.

### 전필 표현 client 수정 (app.js, 2026-06-23)
spec 검증 중 발견·수정 (81 major 전수 sweep 통과: false 0/0 전필 0, JS error 0):
- **`required_credits`만 있고 과목 코드 없을 때**: 기존엔 `전공필수 (0/0과목)` 거짓-충족(녹색) 바 + required_credits 무시(전공선택 미차감). → 수정: 과목 목록 없으면 `전공필수 N학점 — 개별 과목 코드 미수집` **안내 노트** + 전공선택 학점에서 차감(`reqCreditsFixed = track.required_credits`). app.js `_gradAuditBlock` else-if 분기.
- **이름만 있는 전필(코드 없음)** 제외: `reqBase = required.filter(c => c.code && ...)` — 인문 등 name-only known이 쓰레기 1-항목 체크리스트로 뜨던 것 제거.
- **`select_min` 오용 정정**: 9개 spec(arch·cbe·cee·ece·ere·ie·naoe·psir·socio)이 전선 **학점**값을 select_min(과목 수)에 잘못 넣어 `전공선택 0/51과목`처럼 표시 → 0으로 정정(학점 min은 selectMinCredits가 이미 처리). stat의 select_min 5(≥5과목)만 정상 유지.
- 전필 표현 규칙: **코드 있으면 `track.required.all`(과목 바)** / **학점만 알면 `required_credits`(안내 노트+차감)** / **둘 다 없으면 카탈로그 `major_required_match` 또는 무표시**. 카탈로그 derivation은 노이즈(화학부 14·ie 11) — 가급적 curated 우선.

### 결손 보강 라운드 (2026-06-23) — 사용자 제공 소스 + HWP/이미지 파싱
89 spec / 83 major. 사용자가 준 학과 소스로 결손 채움:
- **신규 spec 2개**: **`med_2026`(의예과)** = HWP 파싱(`의과대학 규정집 2026.6.19` olefile→BodyText zlib→PARA_TEXT). 수료 74 = 교양41 + 전공23(필수14+선택9). 전필 5과목 코드(801P.101A·801P.102·M2605.001200·M2605.000600·801P.108). 본과(의학과)·복수부전공 없음. / **`vet_2026`(수의예과)** = 교과과정 JPG **vision 판독**(prevet1/2). 예과 2년 전공 26 전부 필수 + 교양 vet_2025(42), total 72. 6 전공코드(M2180.*) known.
- **전필 코드 주입 7 spec**: pharm **45과목=110학점**(M2175.*, 이수표준형태 PDF) · ece **10과목 32**(430.*·M2608.*) · ie **10과목 28**(406.*·M1505.002000) · korean **4(12)**(100.100·101.301A·101.221·101.222) · cll(중문) **3(9)**(M1234.001700·102.321·M1234.000700) · germanlit **3+특강**(105.300B·M1241.000400·105.228·M1241.000200) · englit **분포 3코드**(100.109·M1236.000600·M1236.000900, 고정아닌 분포요건) · sees **논문연구 1**(M1411.002600, 학부 유일 필수).
- **추출 toolchain 추가**: HWP = `olefile`(pip --break-system-packages) + zlib(-15) + record parse(tag67=PARA_TEXT, utf-16le). 이미지 표 = Read tool **vision OCR**(vet 예과 JPG, pdftotext 불가분). 다운로드 = kBoard nonce/Referer(snupharm·ie·ece). 검증: 브라우저 sweep 약학 0/45과목·ece 0/10·의예 0/5·수의 전공26 노트, JS error 0.
- **`vetmed_2026`(수의학과 본과 4년)** 추가 = vet1~4 교과과정 PNG **vision 판독(2x 업스케일)**. 본과 전공 149 = 전필 76과목 126학점(M1744.*·552.*, 임상 중심) + 전선 소수. `general:false`(교양은 예과서 이수) → 졸업/교양 바 없이 전공+전필만 표시. 90 spec / 84 major.
- **여전히 결손(소스 자체 부재)**: 의학과 **본과**(임상 4년, pass 위주·별도; 의예과는 확보) · 치의학(전문석사만) · english 분포 구명칭↔현행 정확매핑(학과확인) · 미술 5과·철학·영불독교육·mse·smsys·forestsci track totals(dept site 부재 → 학칙/요람). sees 전필 학점표(설계상 단일학부, mySNU 소관).

### 과거 학번(2023·2024) batch 확장 (2026-06-23)
2025 = 학부대학/공통교육과정 reform 경계. 2025·2026 = 신교양(_2025 어댑터), **2021~2024 = 구교양(학문의 기초 + 학문의 세계)**. 전공은 batch 무관 stable(recon 확인: ECE 2024 PDF = ece_2026 1:1) → **clone 방식**.
- **OLD 교양 출처 = `liberaledu_<year>.pdf`** (학부대학 이수규정, `https://snuc.snu.ac.kr/이수규정/`; Referer 필요). 2024=2023 동일. 2026 수강편람의 구버전 격. dept 학번별 PDF도 동일 표 포함.
- **OLD 교양 어댑터 36개** `gyo/<x>_2022.json` (applies "2021~2024", natsci_2022 template): 학문의 기초[사고와 표현(writing)/외국어/수량적·과학(msc 또는 공대·사범자연 split math/science/computing)] + **학문의 세계(`world`, 7영역 lump → areas culture/history/human/scisense/x_*)** + extras(인문 고전원전 classics2·건설 사회봉사 engage1·경영/사범 arts·첨단융합 veritas9). OLD 코드 L04xx는 area_codes에 기매핑. 단대별 변형 37개(신교양과 동일 granularity). 공대 학부별 split, 사범 lump(윤리·국어·외국어·사회·체육 / 물리·화학·생물), 농생 자연계 1개 lump.
- **spec clone 84개** `<x>_2023_2024.json` = `_2026` 전공 byte-동일 + `general`→`_2022` 어댑터 + batch["2023","2024"]. new→old general 매핑(natsci_2025→natsci_2022 등; edu_history/edu_pe→edu_hum_2022, edu_physics/chem/bio→edu_natsci_2022, agri_smartsys→agri_sci_2022 lump). edu_fusion = 2026 전입 전용 → 2023/2024 spec 없음(정상).
- **검증 루프 2연속 CLEAN**(verify_oldbatch_r1/r2.md): 전공 zero-diff·OLD 어댑터 liberaledu bucket-for-bucket 일치·index 340 entries(2023/24/25/26 각 84)·orphan/dangling 0·252/252 JSON parse·brower 화학부 2024학번=자연대 구교양(수량적분석·과학적사고24) 확인.
- 잔여: 전필 *과목 구성*은 학번별 drift 가능(SOURCES: CSE 전필 2021~24=30 vs 2019=35) — 2023/24는 2026과 1~2년차라 low risk, 현행 코드 clone(notes 기록). 2021·2022 batch = math·stat만(요청 외).

### 학번별 per-year 정밀 audit + reconcile (2026-06-23) — clone 가정 폐기
⚠ "전공 batch 무관 stable" 가정은 **틀림**(사용자 지적). 학과마다 요건 갱신 주기 독립 → 84 major × 4년(2023/24/25/26) 전수 audit(7 cluster subagent, `_scrape/peryear_*.md`). 2025 reform은 교양 차원이고, **전공/전필은 학과별로 다른 학번 경계서 변동**.
- **변동 학과 = 약 19개** (나머지 stable, clone 유지). 경계 분포:
  - **@2025** (2023/24 ≠ 2025/26, `_2023_2024` 값 수정): physics 전필 25→15 · biosci 19→13 · astron hard 4→6 · cse 30학점/9과목→24/7 · naoe 단일66/병행45→63/48 · socio 4→5과목 · cls 자체전공18→15 · vocal 68→70 · piano 60/50→57/47.
  - **@2024** (2023 ≠ 2024+, `_2023_2024` → `_2023`+`_2024` split): geog 2과목→1 · socwelf 6과목→1 · biz 전필30→27 · sees 전필無→논문연구 · musicology 52→46 · abc 48→60(2전공 60/53).
  - **@2026** (2025 ≠ 2026, `_2026` → `_2025`+`_2026` split): comm 전필16/6→12/4 · germanlit 독문번역연습1→독문학이란무엇인가(M1241.000400).
  - **value error(전 학번)**: orchestra major_min 74(07~18판)→**68**(23~), 양 파일 수정.
  - **첨단융합(ace)**: 2024 신설 → 2023 batch 없음(`ace_2024`).
  - **사범 교직 22→23 @2024**(디지털교육1) = note만(졸업학점 무영향).
- **spec 파일 구조**: id==filename, batch=정확 연도 list. 세분 split = `<id>_2023/2024/2025.json`. 범위 파일(`_2023_2024`, `_2026`=2025·26)은 경계 없을 때만. **per (major,year) = 정확히 1 spec**.
- **검증 2연속 CLEAN**(verify_peryear_r1/r2.md): 84 major × {2023,24,25,26} 각 1회(ace 2023 제외) · index bijection 339 entries=339 file-year · orphan/gap/overlap 0 · 2592 코드 fake 0 · general = 2023/24→`_2022`구교양·2025/26→`_2025`신교양 위반 0 · reconcile 학과 전수 peryear와 일치. 브라우저: cse 2023=8과목 vs 2026=7·물리 2024=11 vs 2026=4 등 연도별 distinct 렌더, JS error 0.
- **잔여 BLOCKED**(소스 부재, baseline·연도검증 불가): mse·forestsci·smsys·미술5·치의·영불독교육 전필 · 수의/의 이미지·규정집(현행본만, 학번경계 무표기) · abc 2023 구규정 48(추정).

### 코드 개편(course renumber) 대응 — 전필 code-equivalence crosswalk (2026-06-23)
⚠ SNU sbjt_cd는 학번/개편 따라 바뀜 — 2023/24 카탈로그 vs 2026 카탈로그 사이 **516과목 코드 변경**. 교양은 prefix area(F/C/V/E·L04xx·0xx, `area_codes.json`)로 era-robust 매칭 → 무영향. **전필은 exact-code 매칭**이라 구코드로 수강한 과목이 신코드 spec과 unmatch되는 gap 존재.
- **해법 = crosswalk + 직접수정**(사용자 선택 "Crosswalk + fixes (robust)"):
  - **`code_equiv.json`** (NEW): `{note, canon:{code→canonical}}` **75 entries**(70 auto + 5 manual補). 생성 = grad_req 전필 referenced 코드 + classes 카탈로그 cross-era name-mate를 name-group 동치로 묶고 canonical=sorted(group)[0]. GENERIC blocklist(졸업논문·신입생세미나·세미나·현장실습·교육봉사·논문연구 등 학과공통명)은 false-merge 방지로 제외. manual pairs: `[['M1505.000300','M1505.002000'],['406.426','406.426B']]`.
  - **client wiring** (`app.js`): `_loadCodeEquiv()` fetch → `canon(c)=equiv[c]||c`. `takenCodes`를 canon-aware로 래핑(`_takenCanon=Set(rows.map(r=>canon(r.sbjt_cd)))`, `has=(code)=>_takenCanon.has(canon(code))`). 전필/suri 매칭 9개 호출부 모두 `.has()` 경유 → 단일 래핑으로 전부 커버. 양변 canon → 구/신 코드 무관 동치.
- **placeholder 코드 적발·수정**: cse_2023_2024 `4190.201`·chemedu2_2023_2024 `718.314`는 **어느 카탈로그에도 없는 가공 placeholder**(crosswalk 연결 불가) → 실코드 `4190.206A`(전기전자회로)·`718.456`(무기화학실험)로 직접 교체.
- **missed reconcile 補完**: socedu_2023_2024 통합사회교육론(M1855.001200) 제거(25학번~ 추가분)→8과목 · geoedu2_2023_2024 required_credits 15→12.
- **전수 sweep — spec 코드 vs 13499 카탈로그 코드**(누락 placeholder 적출):
  - chemedu2_**2026** 무기화학실험 `718.314`(placeholder) 잔존분 → `718.456` 직접교체(2023_2024은 기수정, 2026 누락분 補).
  - **renumber 5쌍 crosswalk 追加**(auto name-group 누락; 카탈로그 실코드를 canonical로): biosys 바이오시스템공학개론 `5261.223`→`M1704.000900`(2023 미개설·24~ M-prefix)·바이오소재공학개론 `5262.261`→`5262.261A`·바이오소재세미나 `5261.476`→`5262.478` · pharm 실무실습3 `M2175.011300`→`370.3108`·실무실습4 `M2175.011400`→`370.3111`(둘 다 약학대학 전필 동명).
  - **pharm crosswalk = load-bearing**: pharm은 `major_required_match` 없음 → `_gradRequired`가 known-list(M2175) 그대로 required로 사용(app.js:2137 offline-fallback 아님, pharm은 항상 fallback). 따라서 transcript의 370.xxxx 개설코드와 M2175 spec코드를 crosswalk가 이어줘야 매칭. biosys는 `major_required_match`(바이오시스템·소재학부·전필) 보유 → online은 카탈로그 derivation(실코드)로 직접매칭, crosswalk는 offline-fallback 보강용.
  - **잔여 unmatched 10코드 = 수정불가/무영향**(카탈로그 全era 부재): biosys known-list 미개설 전공선택(공학수학1 400.001=공통이라 dept-derivation 비대상·생체운동역학 5261.421·천연고분자/섬유고분자/표면/단백질소재 등) · bioedu 교육봉사1/2(700.019A/700.024, 특별등록) · pharm 심화약학실습1/2(M2175.012000/012100, 6년제 capstone — spec note 기수록). online audit은 catalog-derivation 사용이라 known-list 코드 불일치는 무영향, 미개설과목은 transcript에도 없어 false-fail 없음.
- **검증**: 181 spec·84 major·index 339 bijection·0 dup/gap/dangling 유지. 브라우저: code_equiv **75 entries** 로드, JS error 0, canon이 renumber pair 동일 resolve(700.212≡M1855.001600, 5261.223≡M1704.000900, M2175.011300≡370.3108 등), in-page logic replica로 구↔신 매칭 DONE✓ + false-positive 0 확인.

---

## 전공선택 cross-dept 인정(external_recognition) 누락 sweep (2026-06-30)
⚠ 5개 spec이 `external_recognition`을 누락(또는 빈 dept)해 **타과 전공선택 인정과목을 0개로 처리 → 정당한 cross-dept 학점 보유 학생을 false-FAIL**. 각 학과 **실제 소스 페이지를 직접 fetch**(ctx_execute pure-JS https.get: redirect/gzip/deflate, HTML strip, 키워드 윈도)해 **인정 기준/지정목록을 verbatim 추출**해 인코딩. 요약 스크레이프 노트(_scrape)는 신뢰하지 않고 1차 소스 우선(asia에서 노트가 틀린 것 확인됨).

**모델링 규칙 재확인(app.js `_gradAuditBlock` L2427~):** `isStat`(자과 전공) = `major_required_match.departments ∪ major_select_match.departments`에 dept 포함 → recog보다 먼저 평가(중복인정 차단). `isRecog` OR 필드 = `courses`(canon-code 정확매칭, **분류 무관** L2443) · `code_prefixes`(startsWith) · `colleges`(course.college∈목록 + 전선/전필) · `depts`(부분일치 + 전선/전필) · `any_dept`(타과 전선/전필 전부). `recog_max`(트랙 학점상한, L2475 Math.min, **undefined면 무상한=안전**) · `recog_max_courses`(과목수상한, L2472 학점 높은 순 top-N=학생유리). `approval_max_credits` = **DOC-only**(엔진 미사용). **codeEquiv canon은 exact-string 매칭**(대소문자/공백 정규화 X) → spec 코드는 카탈로그 sbjt_cd 케이싱 그대로(예: `205.322c` 소문자, `216B.345`·`100.146A` 대문자).

| spec | 소스(verbatim 2026-06-30) | 규칙 | 인코딩 |
|---|---|---|---|
| **psych_2026** | psych.snu.ac.kr/sub04/sub02.php | 지정 24과목(언어/철학/종교/미학/사회/인류/언론/사복/경영/컴공/통계 등) 최대 **9학점**, **심리 주전공·복수전공만**(부전공 제외), S/U 인정불가 | `courses`(24) + recog_max [단일9/주9/복9/부0] |
| **ling_2026** | linguist.snu.ac.kr/교육/학부/이수규정/ | "타과 이수 교과목을 절차 거쳐 **최대 6학점**까지 언어학과 전공과목 인정"(복수6·부전공3) — **지정목록 없음, 위원회재량** | `any_dept:true` + recog_max [6,6,6,3] |
| **foodnut_2026** | foodnutrition.snu.ac.kr/전공-이수-규정/ | "기초유기화학(886.031) 전선 3학점 인정(325.209 유기화학 중복불가). 그 외 유전학·물리화학·미생물학 등 타학과 학과장 인정 시 **9학점 이내** 전선 인정" | `courses`[886.031] + `any_dept:true` + recog_max 12(3+9 보유자 보호) |
| **asia_2026** | asia.snu.ac.kr/{서아시아,인도,동남아시아,일본}언어문명전공-교과목/ | per-전공 **지정목록**(서5·인5·동6·일16) + "이 중 **3과목 이내로만** 전공인정"(과목수 상한). ⚠ _scrape 노트는 any_dept로 오인 → 1차 fetch가 정정 | `courses`(4전공 합본 40 + 폐지/구코드) + `recog_max_courses` 3(전 트랙) |
| **aiunion** | imai.snu.ac.kr/academics/{requirements,courses}/ | 연합전공 = 카탈로그 자체 학과태그 없음 → `major_select_match.departments:[]` 이면 **isStat 항상 false → 전공선택 0학점 버그**. 지정 curriculum(전필7+전선22) + 섹션4 타과인정 50과목(≤6학점) | `courses`(80, 4190.416 구코드 포함), **recog_max 미설정**(recog가 전공 전체라 상한=catastrophic false-fail) |

**aiunion 특이사항:** recogCodes는 분류 무관 매칭이라 전필 학점도 `majorCr`에 산입됨(isStat=0이므로 `majorCr=recogCr`). 섹션4의 6학점 상한·유사과목 중복인정불가(컴퓨터구조4190.308↔컴퓨터조직론430.322 등 6쌍)는 over-count 축소규칙이라 미인코딩(student-favorable·cardinal-safe). requirements 페이지의 "타과 교과목을…언어학과 전공과목으로 인정" 블록은 **CMS 공통템플릿 누수**라 무시 — 실규칙은 섹션4 지정목록.

**검증(preview_eval, 실제 `_gradAuditBlock`):** aiunion 합성 transcript(지정 13과목 40학점) → ok=true·전공 40/39·전공선택 40/29·인정 14개·console error 0. allow-list 확인: 비지정 타과(경영학원론 251.201)는 recog 제외(2개만 인정). psych 2개·6학점/ling any_dept 1개·3학점/foodnut 886.031 1개·3학점/asia 2개·6학점 전부 인정 정상, error 0. 5개 spec json.tool 통과.

---

## deptless 연합·연계전공 18개 external_recognition 일괄 인코딩 (2026-06-30)
⚠ aiunion에서 발견한 **deptless-union 버그**가 19개 interdept spec 중 **18개에 공통**(aiunion 제외). `major_select_match.departments:[]` → `isStat` 항상 false → `majorReqCr`·`majorSelRows` 모두 0 → `majorCr`가 **전적으로 `recogCr`에서 산출**. `external_recognition` 없으면 majorCr=0 → ok 영구 false → **전 학생 false-FAIL**. 카탈로그에 본 전공 태그 과목이 없으므로(연합/연계전공은 참여학과 과목을 빌려 씀) recog가 유일한 전공학점 집계 경로.

**해법(사용자 선택 "Fetch all 18 real lists"):** 각 프로그램 이수규정 페이지에서 **실제 지정 전공인정 목록**(전필 + 전선 pool + 참여학과 인정)을 1차 소스로 확보해 `external_recognition`으로 인코딩. `any_dept` 미사용(메모 규칙 — 게시된 allow-list 우선). `recog_max`/`recog_max_courses` **미설정**(recog가 전공 전체라 상한=catastrophic false-fail, cardinal-safe). depts/colleges는 blanket이 아니라 **게시된 참여학과/단과대 범위**.

| spec | min | 인코딩 | mech |
|---|---|---|---|
| **calcsci** | 39 | courses 6전필(3349.201A·203·204·M1421.000100·3349.309·404) | prefix 3349.·M1421. |
| **gem** | 39 | courses 5전필+12전선(538.*·M1729.*·M3713.000400) | prefix 538.·M1729.·M3713. |
| **mediaart** | 39 | courses[613.302] | prefix 613. |
| **infocult** | 39 | courses 7(2114.*·211.320B·M1312.001000) | prefix 2114. + depts 언론정보학과 |
| **aisemicon** | 39 | courses 9(M3238.*·430.*·M1522.000800) | prefix M3238. + depts 전기·정보공학부·컴퓨터공학부 |
| **intellicomm** | 39 | courses 11(430.*·M1522.002100·M2608.001200·4190.411·300.203A·881.007·M3495.*) | prefix M3495. + depts 전기·정보·컴퓨터공학부 |
| **humandata** | 21 | courses 3(M2911.000100/200/300) | prefix M2911. + depts 9(언어·심리·국사·인류·사회·지리·고고미술사·통계·독문) |
| **bmb** | 21 | courses 3(2071.301/302/401) | prefix 2071. + depts 7(심리·언어·생명과학·철학·컴퓨터·통계·화학) |
| **filmstudies** | 21 | courses 10(M3699.*·M1262.*·M1236.*·M3500.000700) | prefix M3699. |
| **mot** | 39 | courses 47(6영역 pool 전체) | depts 경영대학·경제학부·산업공학과 (NO prefix) |
| **venture** | 39 | courses 22(113.*·251.*·M1338.*·M1522.*·4190.*·5251.*·5252.*·500.169·M1702.000600) | prefix 5251.·5252. + depts 철학·경영·컴퓨터·식품동물생명 |
| **finecon** | 21 | courses 5(212.201/202/301/338A·251.301) | depts 경제·경영·수리과학·통계 (NO prefix; 미시거시 주전공중복 미인코딩=over-accept safe) |
| **finmath** | 21 | courses 23(3341.*·M1407.*·881.*·326.*·251.*·406.*·M1505.001300·M1522.001400·M2177.004300) | prefix 3341.·M1407. + depts 수리과학부 |
| **sts** | 21 | courses 22(탐색7+심화13+관련2) | prefix M2888.·M2173.·300. |
| **ppe** | 21 | courses 11(216B.223·216A.405/325·200.105/106·113.343/345·M3659.*·M2908.000100) | prefix M3659. + depts 정치외교·경제·철학 (multi-line anchor) |
| **easiahum** | 39 | courses 2전필(M3563.000100/000300) | prefix M3563. + colleges 인문대학 |
| **cnp** | 21 | (공통필수 코드 카탈로그 부재 → courses 없음) | colleges 인문대학 ONLY |
| **latam** | 21 | courses 2전필(107.328A·327A) | prefix 107. + depts 서어서문학과 |

각 spec에 notes 1줄 추가("deptless 연합/연계전공: 카탈로그에 본 전공 태그 과목 없음 → 전공학점은 external_recognition으로만 집계 … 상한 없음(cardinal-safe). any_dept 미사용.").

**검증(preview_eval, 실제 `_gradAuditBlock`, 2026-06-30):** 18 spec 전수 — 각 mech(prefix/depts/colleges)로 major_min+30학점까지 padding한 합성 transcript → **18/18 ok=true** (calcsci 23행69학점·cnp colleges 17행51학점·mot depts 47행141학점 등). **음성 대조**(빈 transcript): calcsci·cnp·mot 모두 ok=false → ok가 majorCr에 반응함을 확인(vacuous-pass 아님). 18 spec 전부 json.tool 통과. wrong/fabricated 코드는 무매칭이라 무해(over-count·false-fail 불가) — under-coverage만 위험인데 depts/prefixes/colleges가 cardinal-safe 폭 제공.
