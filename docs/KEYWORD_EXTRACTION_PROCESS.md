 # Keyword/Phrase Extraction: Change Management Process

Owner: Search/Extraction lead

Scope: Production keyword/phrase extraction used by BM25 search and the Note Details keyword chips.

- Production extractor: `src/preload/search/kw.ts`
- API surfaces: `getTopKeywordsForNote`, `extractFrontKeyIdeas` (delegates to extractor)
- Search integration: `fuzzySearch` term selection and weighting, `getRelatedByBm25`

We iterate on generalizable rules. All validation uses the production extractor only — no LLM fallback.

---

## 1) Accepting A Desired Outcome (DO)

When a user submits a Desired Outcome, capture it as a test case with:

- Input text: the note’s front (plain text; include cloze markup if present, e.g., `{{c1::term}}`).
- Expected keywords: ordered list of terms or phrases to return (case/diacritics preserved).
- Optional context: why these terms matter (e.g., facets, expected retrieval behavior).

Record the DO in your working notes and add it to our ad‑hoc suite (below).

---

## 2) Reproduce With Production Extractor

Compile and run only the production extractor against the DO text.

Commands:

1) Compile the production extractor to a temporary JS target

```
./node_modules/.bin/tsc --target ES2020 --module commonjs src/preload/search/kw.ts --outDir tests/tmp_kw
```

2) Run the quick harness on a bundle of cases (includes canonical examples):

```
node tests/tmp_kw/run.js
```

To test a single text ad‑hoc:

```
node -e "const {extractKeywords}=require('./tests/tmp_kw/kw.js'); console.log(extractKeywords('<PASTE TEXT>', 10))"
```

Acceptance gate: Output exactly matches the expected keywords (order can be score-driven unless DO specifies strict order).

---

## 3) Diagnose Gaps

Pinpoint why a term is missing or extra. Common causes and checks:

- Tokenization
  - Hyphens, apostrophes, Greek letters, Unicode dashes
  - Cloze markup adds tokens like `c1`, `c2` between words
  - Action: adjust tokenizer or pattern rules to skip non-semantic tokens

- Pattern coverage
  - Lists: `include/includes/including`, `such as`, `like` (with commas)
  - Coordination/approval: `X and Y ... approved/indicated`
  - Between‑lists: `between X and Y`
  - Proper‑name rules: `X’s rule`, `X rule`
  - Syndrome/disease: `Cushing syndrome`, `Parkinson disease`
  - Greek letter phrases: `pi electrons`, `σ bonds`
  - Action: add/adjust targeted boosts with tight guards and short lookahead windows

- Scoring heuristics
  - Suffixes: medical noun endings (e.g., `-pnea`, `-rrhea`, `-itis`)
  - Hyphenated eponyms: `Cheyne‑Stokes`
  - Avoid over‑penalizing plural `-s` on nounish tokens (keep verb penalties for `-ing/-ed`)

- STOPWORDS overflow
  - Very common terms accidentally filtered or not filtered
  - Action: adjust STOPWORDS list conservatively

---

## 4) Implement Minimal, Generalizable Changes

Edit `src/preload/search/kw.ts` only. Guidelines:

- Prefer small additive boosts gated by clear patterns.
- Restrict windows (e.g., search ahead ≤ 6 tokens for an `and` cue).
- Skip non-semantic tokens (STOPWORDS, cloze tokens `^c\d+$`).
- Avoid one‑off special casing; ensure new logic won’t explode recall on unrelated notes.

Run typecheck after edits:

```
./node_modules/.bin/tsc --noEmit -p tsconfig.node.json && \
./node_modules/.bin/tsc --noEmit -p tsconfig.web.json
```

---

## 5) Extend/Run Validation Suite

We maintain a small ad‑hoc suite that mirrors real patterns. Update and run it after any change.

- Harness: `tests/tmp_kw/run.js`
- It compiles `kw.ts` and prints outputs for canonical texts.

Run:

```
./node_modules/.bin/tsc --target ES2020 --module commonjs src/preload/search/kw.ts --outDir tests/tmp_kw
node tests/tmp_kw/run.js
```

Canonical cases currently included:

- Finasteride (drug/condition/enzyme): expects `5α‑reductase`, `Finasteride`, `androgenetic alopecia`
- Hückel (possessive + Greek): expects `Hückel’s rule`, `aromatic molecules`, `pi electrons`
- AIS (trigram disease + bigram): expects `androgen insensitivity syndrome`, `undescended testes`
- Include lists (comma lists): expects `diarrhea`, `dehydration`, `nausea`, `osmotic laxatives`
- Cheyne‑Stokes (hyphenated eponym + between): expects `Cheyne‑Stokes`, `apnea`, `hyperpnea` (robust to cloze)
- Minoxidil approval coordination: expects `minoxidil`, `finasteride`, `androgenetic alopecia`
- Cushing syndrome/disease: expects `Cushing syndrome`, `Glucocorticoids`, `androgens`, `steroid hormones`

Definition of Done (DoD):

1) New DO passes with exact expected terms.
2) No regressions across canonical cases.
3) Typechecks pass for node/web.

---

## 6) Iterative Loop (if validation fails)

1) Inspect the failing case’s printed output and compare to expected.
2) Hypothesize root cause (tokenization? missing pattern? bad STOPWORD? insufficient boost?).
3) Implement the smallest fix in `kw.ts` that addresses the cause.
4) Recompile and re‑run the suite.
5) Repeat until DoD is met.

When in doubt, prefer recall‑safe boosts with strong guards over broad token penalties.

---

## 7) Integration Notes

- The extractor is used in:
  - `getTopKeywordsForNote` (chips in `NoteDetails`)
  - `fuzzySearch` (keyword/phrase selection + weighting)
  - `getRelatedByBm25` (terms from current note’s front)
- We do not use any LLM for extraction in production.
- Phrase IDF for FTS5 is estimated via phrase `MATCH` doc counts; unigrams use `fts5vocab`.

After changes to `kw.ts`, the app picks them up on next build/run. No further wiring is required.

---

## 8) Submitting A New Desired Outcome

Please provide:

- Text (exact front content; include cloze markup if present)
- Expected keyword list (ordered, 3–6 items)
- Optional: rationale or pattern notes

We will add it to `tests/tmp_kw/run.js`, iterate per the loop above, and report back with the patch and observed outputs.

---

## 9) Troubleshooting Checklist

- Missing keyword that’s inside `{{c1::...}}`? Ensure pattern rules skip cloze tokens.
- Phrase not detected? Check bigram/trigram score thresholds and head‑noun sets.
- Eponym not surfaced? Verify hyphenated proper‑name boost and no unintended `-s` penalty.
- Greek letter terms not lifted? Confirm Greek name/symbol sets and head nouns (electrons/bonds/orbitals).
- Too many generic tokens? Review STOPWORDS and weighting caps for IDF/length boosts.

