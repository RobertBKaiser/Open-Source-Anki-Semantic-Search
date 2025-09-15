# App Overview

Open Anki Semantic Search is an Electron app that indexes Anki notes and lets you search, rerank, semantically explore, and organize them. It also includes an EPUB reader and a PDF reader that surface related notes while you read.

This document summarizes the app’s components, features, data flow, and layout. It reflects the current behavior of the repository as-is.

## Recent Changes (current)

- Header
  - Moved Reranking and Classify Badges buttons to the post‑search filtering row next to the cosine slider and badge/grouping controls.
  - Kept primary search buttons (Fuzzy, Semantic, Hybrid) in the main action row for clarity.
- Note list (NoteList)
  - Added hierarchical Tag Groups with expand/collapse per group; thinner, more curved headers; right‑aligned count badge.
  - Removed inner virtualization for sub‑groups to avoid nested scroll containers. The list remains a single smooth scroll area; overscan reduced for memory efficiency.
  - Tag navigation (breadcrumbs + sibling/child dropdowns) now shows above the main list when a tag is selected from the hamburger menu.
- Note details (NoteDetails)
  - Responsive metadata: ID / Note Type / Last Modified use responsive grid; Last Modified shows full timestamp via tooltip.
  - “Open in Anki” placed alongside Copy where space allows.
  - KaTeX: `strict: false`, Unicode filtering for problematic chars, and guarded rendering to avoid runtime errors.
- Preload bridge (src/preload/index.ts)
  - Embedding search made robust: if HNSW index is missing/uninitialized, we fall back to scanning `embeddings.db`; also handle dimension mismatches by using the overlapping dims and recomputing norms.
  - Added clearer warnings/errors for missing DeepInfra key, empty queries, and API failures.
  - Hybrid search continues to use HNSW when available but degrades gracefully without it; also uses cached query embeddings for BM25 cosine backfill (cache TTL ~10m).
  - Simplified note details cache (shorter TTL, bounded size). Removed prefetch API and the renderer’s loading spinner to reduce overhead.
- Types
  - Rewrote `src/preload/index.d.ts` with reusable row types and consistent formatting; lints are clean and declarations match the actual API.

## Outdated / Ghost Code and Cleanup Notes

- EPUB/PDF components
  - Several EPUB/PDF files were removed from the renderer (`EpubLibrary.tsx`, `EpubViewer.tsx`, `EpubNotesPanel.tsx`, `PDFReader.tsx`), but this document previously described them as active. Treat EPUB/PDF sections below as historical until re‑enabled.
- Query embedding cache helper
  - `makeEmbKey(q, model, dims)` should return a stable string key. Verify implementation in `src/preload/index.ts` is non‑empty and consistent; otherwise queries may share the same cache bucket.
- Generated bundles and artifacts
  - `out/` and `dist/` contain build outputs; avoid checking for source here when auditing features.
- Legacy references
  - Remove references in docs/UI to deprecated APIs like `prefetchNoteDetails` (now removed) and ensure no stale imports remain in the renderer.
- KaTeX warnings
  - With `strict: false` and Unicode filtering in place, the prior warning spam should be gone; if any custom renderers still set `strict: 'warn'`, align them.

---

## Top-Level Architecture
- Electron renderer (React/TypeScript) for UI.
- Electron preload (`src/preload/index.ts`) exposes a typed `window.api` bridge for all data access, search, LLM calls, and embeddings.
- SQLite databases in `database/`:
  - `anki_cache.db` — notes, fields, tags, FTS5 index.
  - `embeddings.db` — per-note embeddings; keyword embedding cache.
  - Ingest scripts synchronize notes via AnkiConnect.

## Core Features
- Note browsing with first-field previews and details panel.
- Multiple search modes:
  - Exact (substring AND across fields).
  - Fuzzy/BM25 (FTS5) with RRF support.
  - Embedding search (DeepInfra) and Semantic Rerank (DeepInfra reranker).
  - Hybrid scoring: semantic score modulated by BM25 strength.
- Badge classification via OpenAI (visible result set, one-by-one classification).
- Grouping tools:
  - Group by badge (0..3) in-place ordering.
  - Group by AI: calls an OpenAI cached prompt to partition visible notes into labeled groups; groups sorted lexicographically, notes sorted numerically.
- Related-notes exploration from a note (BM25 / embedding / hybrid) with optional concept filters.
- EPUB reader with semantic suggestions for current selection and visible text.
- PDF reader with per-page "Related notes" gutter based on page text.
- Embeddings management: build, pause, rebuild; progress indicator.
- Settings to configure API keys, prompt IDs, embeddings model/dimensions.
- Anki sync (ingest) runner; unsuspend selected notes via AnkiConnect.

## Data Flow Overview
- Ingest (`database/anki_ingest.mjs`) pulls notes from AnkiConnect `notesInfo`, writes `notes`, `note_fields`, `note_tags`, and FTS (`note_fts`).
- Preload API reads and searches from SQLite, manages embedding generation (via separate process) and uses DeepInfra/OpenAI for model calls.
- Renderer calls `window.api.*` for all data operations, renders lists, details, and auxiliary views.

---

# UI and Components

## Layout and Navigation
- App frame (`src/renderer/src/App.tsx`) is a grid with Header, main content (route-dependent), FooterBar.
- Routes:
  - `notes` — notes browser (default).
  - `epub` — EPUB library/reader.
  - `pdf` — PDF reader.
- Header contains search controls, mode toggles, thresholds, grouping toggles, and menu to switch routes.

## Header (`src/renderer/src/components/Header.tsx`)
- Search box: debounced updates propagate query to global (`__current_query`) and onSearch handler.
- Mode actions:
  - Exact/Fuzzy/Hyrbid/Semantic/Rerank triggers are wired in `App.tsx` via callbacks (`onFuzzy`, `onHybrid`, `onSemantic`, etc.).
- Threshold slider: controls cosine threshold for semantic/rerank/hybrid filtering.
- Badge tools: shows counts (0..3) and supports selecting/deselecting notes by badge.
- Group toggles:
  - Group (by badge): reorders list by badge group.
  - Group by AI: calls AI grouping and shows grouped sections; button text toggles between Group and Ungroup.
- Reader route menu: switches between Notes, EPUB reader, and PDF reader.

## NoteList (`src/renderer/src/components/NoteList.tsx`)
- Renders either:
  - Flat list of note rows (with select checkbox, cloze-colored preview, score badges for the active mode), or
  - Grouped sections when `groups` prop provided (section header with label and optional score badges; notes sorted within group).
- Score badges per row (if available): BM25, RRF, rerank cosine, overlap chips for keyword grouping (not shown under AI groups).

## NoteDetails (`src/renderer/src/components/NoteDetails.tsx`)
- Shows full note fields with media rewrites to local `file://` paths and KaTeX rendering for math.
- Displays metadata (ID, model, modified time, tags).
- Related notes panel (below fields): three modes
  - BM25 from concepts (top keywords or selected filters).
  - Semantic nearest notes to this note’s embedding.
  - Hybrid: builds a query from selected concepts or front text and runs hybrid ranking.

## SettingsSheet (`src/renderer/src/components/SettingsSheet.tsx`)
- Tabs: General, Sync, API, Embeddings.
- Sync tab: run ingest for a query (calls `window.api.runIngest`).
- API tab:
  - DeepInfra key and rerank instructions.
  - OpenAI API key and cached prompt IDs (badge prompt and keyword/ideas prompt).
- Embeddings tab:
  - Model and dimensions.
  - Controls: Start, Pause, Rebuild All (spawns `database/embed_index.mjs`).
  - Progress panel (total, embedded, pending, errors, rate, ETA).

## EPUB Reader
- Library view (`EpubLibrary`): basic bookshelf with cover extraction/persistence.
- Reader (`EpubViewer`): continuous scroll, custom theme, visible text tracking.
- Actions:
  - “Semantic search” on selected text (calls `semanticRerankSmall`).
  - Related notes auto-updates based on visible text after relocation.
  - Right panel (`EpubNotesPanel`) lists related notes; selecting moves focus to NoteDetails in the main app when applicable.

## PDF Reader (`src/renderer/src/components/PDFReader.tsx`)
- Uses pdf.js. Adds per-page “gutter” to the right of each page displaying related notes.
- Pipeline per page:
  - Extract text, send to `embedSearch` with timeout → fallback `semanticRerankSmall`.
  - Render small items with rerank percentage.
- Controls: Fit width, Next/Prev (via viewer), hidden input for future import wiring.

## FooterBar
- Minimal status text: route indicator and whether in Search or Browse mode.

---

# Preload API (Bridge)

All methods are exposed on `window.api` (see `src/preload/index.d.ts`). Highlights:

## Notes and Ingest
- `listNotes(limit, offset)` — first-field for browsing.
- `countNotes()` — total notes.
- `getNoteDetails(noteId)` — fields and tags for details view.
- `runIngest(query)` — run `database/anki_ingest.mjs` (AnkiConnect → SQLite sync).
- `pingAnkiConnect()` — check AnkiConnect availability.

## Search / Ranking
- Exact: `searchNotes(query, limit, offset)` — AND of substrings across fields.
- Fuzzy (BM25): `fuzzySearch(query, limit, exclude?)` — uses FTS5 and optional trigram scoring; returns BM25 score and RRF.
- Embedding search: `embedSearch(query, topK)` — DeepInfra embeddings, cosine against per-note vectors.
- Semantic rerank: `semanticRerank(query, limit)` — DeepInfra reranker scores top candidates.
- Hybrid: `hybridSemanticModulated(query, limit)` — semantic cosine modulated by BM25 with smooth penalties/boosts.
- Rerank small: `semanticRerankSmall(query)` — conservative (5 BM25 + 5 Embedding) for EPUB/PDF sidebar.

## Grouping and Classification
- Group by badge — implemented in renderer by sorting rows by `badge_num`.
- Group by AI: `groupNotesByAI(noteIds, queryText)` — OpenAI Responses call to cached prompt, sending:
  - Search query, and
  - Numbered list of the first-field plain text for each visible note (lines prefixed by note_id).
  - Returns JSON groups `{ label, notes }`; post-processed to remove duplicates, add “Other” if needed, and sort groups/notes.
- Badge classification: `classifyBadges(noteIds, queryText)` — OpenAI prompt returning numeric badge (0..3) per note (one-by-one with concurrency).

## Embeddings / Similarity Utilities
- `startEmbedding(rebuild?)`, `stopEmbedding()`, `getEmbeddingProgress()` — control and monitor embed indexer.
- `getRelatedByEmbedding(noteId, minCos, topK)` — nearest neighbors by cosine.
- `getRelatedByEmbeddingTerms(terms, topK)` — embed terms and find similar notes.
- `getTopKeywordsForNote(noteId, maxItems)` / `extractFrontKeyIdeas(noteId, maxItems)` — keyword/phrase extraction from front field.
- `extractFrontKeyIdeasLLM(noteId, maxItems)` — LLM-based ideas extraction via OpenAI Responses.
- Keyword embeddings cache/cluster/cosine functions for keyword-based flows.

## BM25 Tools
- `searchByBm25Terms(terms, limit)` — BM25 given selected terms.
- `bm25ForNotesByTerms(terms, noteIds)` — BM25 for specific note IDs and terms (used for group sorting in keyword mode).
- `getRelatedByBm25(noteId, limit, terms?)` — related notes by BM25.

## Files/Helpers
- `readFileBinary(filePath)` — load file contents (used by EPUB library).
- `setSetting/getSetting(key)` — app settings persistence (API keys, prompts, model config, etc.).

---

# Notes on Layout and Behavior
- Notes Browser view (`route='notes'`):
  - Left: NoteList (infinite scroll with `loadMoreDefault`).
  - Right: NoteDetails.
  - Group by AI replaces in-list order with grouped sections; ungroup reverts to the active mode’s order.
- EPUB/PDF routes mount specialized viewers; related notes are derived from visible text/selection and shown adjacent.

---

# Proposed Streamlining and Optimization

## 1) Simplify Grouping UX and Execution
- Trigger scope: Keep grouping strictly on-demand (already immediate on toggle). Consider disabling the auto-recompute-on-query-change effect while grouped to avoid redundant LLM calls; add a small "refresh groups" button.
- Caching: Cache groupings keyed by (query hash + visible note id set) for quick restore on toggle.
- UI clarity: Rename internal `keywordGrouping` state to `aiGrouping` for intent clarity; reflect in props.

## 2) Consolidate Search Modes with a Single Results Pipeline
- Unify exact, fuzzy, semantic, rerank, hybrid under one orchestrator that builds candidates and applies a selected scoring strategy, yielding a single result shape with optional fields (bm25, rrf, cos). This reduces conditional branching in `App.tsx` and NoteList.

## 3) Embed Index Health and Self-Healing
- On startup, verify `embeddings.db` consistency vs note count and schedule incremental updates for missing embeddings. Expose a small status icon in Header with a “Rebuild missing” action.

## 4) API Rate/Cost Controls
- Batch OpenAI calls whenever possible (Responses supports multiple inputs). The classifier is already one-by-one with concurrency; consider an aggregated prompt if stable.
- Add per-session caps: max groupings per minute, with UI feedback when throttled.

## 5) Settings Discoverability
- Move essential API keys and toggles into a compact “Quick Settings” popover from the Header (OpenAI key presence, model/dims summary, prompt IDs). Keep advanced options in the full SettingsSheet.

## 6) Performance and Memory
- Virtualize grouped NoteList sections (e.g., react-window) when groups are large.
- Precompute and cache first-field plain text (stripped) alongside HTML during ingest to avoid repeated strip work at runtime.

## 7) Robust LLM Parsing
- Harden JSON extraction helpers into a shared utility (handle `output_text`, `output[].content[].text{, .value}`, and fallback JSON substring extraction). Centralizing reduces duplication and failure modes.

## 8) Error Visibility
- Add a small toast/banner when external calls fail (OpenAI/DeepInfra/AnkiConnect) instead of silent console logs, with a “details” expander to keep the UI tidy.

## 9) Test Fixtures for Extractors
- Keep a tiny corpus in `tests/` with expected extractor outputs and BM25 matches to guard regressions for keyword-based utilities and FTS changes.

## 10) Security and Secrets
- Add a quick “mask/unmask” toggle for API keys in Settings.
- Optional: support environment-variable-only mode (read-only UI for keys) for shared machines.

---

# Appendix: Notable Files
- Renderer
  - `src/renderer/src/App.tsx` — root UI, routes, search handlers, grouping.
  - `src/renderer/src/components/Header.tsx` — search, mode/threshold & group toggles, route menu.
  - `src/renderer/src/components/NoteList.tsx` — render notes/groups, score badges.
  - `src/renderer/src/components/NoteDetails.tsx` — full note view, related notes panel.
  - `src/renderer/src/components/EpubViewer.tsx`, `EpubLibrary.tsx`, `EpubNotesPanel.tsx` — EPUB features.
  - `src/renderer/src/components/PDFReader.tsx` — PDF per-page related notes gutter.
  - `src/renderer/src/components/SettingsSheet.tsx` — ingest, API, embeddings config.
- Preload
  - `src/preload/index.ts` — all bridge APIs for search, embeddings, OpenAI/DeepInfra, ingest, AnkiConnect.
  - `src/preload/search/bm25.ts` — FTS5 search helpers.
  - `src/preload/index.d.ts` — typed window.api contract.
- Database / Scripts
  - `database/anki_ingest.mjs` — sync notes from Anki.
  - `database/embed_index.mjs` — embeddings builder process.

This document is descriptive only; it does not change any code.


---

## Modularity Audit and Refactor Recommendations (current)

This section analyzes the current structure with an eye toward smaller, discrete modules and highlights large/entangled files to refactor. Inline bullets call out concrete extraction targets and suggested file/module names. Per user rule, these comments document the desired modular design alongside the relevant implementation areas.

### Renderer (React)

- App shell — `src/renderer/src/App.tsx`
  - Size/role: medium-large monolith coordinating search modes, selection, grouping, tags overlay, and route to PDF.
  - Issues: contains multiple domains (search orchestration, threshold filtering, AI grouping wiring, tag prefix navigation, selection state, and layout).
  - Refactor targets:
    - Extract search orchestration to `src/renderer/src/modules/search/ResultsController.ts` (pure functions + hooks for exact/fuzzy/rerank/semantic/hybrid pipelines; unifies result shape and filtering).
    - Extract selection/clipboard/unsuspend handlers to `src/renderer/src/modules/selection/selectionState.ts` + `useSelection` hook.
    - Extract AI grouping glue to `src/renderer/src/modules/grouping/aiGrouping.ts` and a `useAiGrouping` hook.
    - Move route switching to a tiny `src/renderer/src/routes/Routes.tsx` to keep `App.tsx` lean.

- Header — `src/renderer/src/components/Header.tsx`
  - Size/role: medium; mixes search input, action buttons, thresholds, badges, keyword chips, AI grouping and tag launcher.
  - Refactor targets:
    - Split into discrete UI components under `components/header/`:
      - `SearchInput.tsx` (single/multiline input + debounce state propagation).
      - `PrimaryActions.tsx` (Fuzzy, Semantic, Hybrid buttons).
      - `PostSearchBar.tsx` (threshold slider with label “Similarity 00.0%”, Reranking, Classify Badges).
      - `BadgeToggleRow.tsx` (counts and group/ungroup + select/clear callbacks).
      - `KeywordChips.tsx` (selectable chips + Clear; isolated from Header state via props).
    - Keep `Header.tsx` as a composition wrapper, wiring callbacks only.

- Note list — `src/renderer/src/components/NoteList.tsx`
  - Size/role: large; includes virtualization logic, preview rendering with KaTeX, badges, overlap chips, tag navigation, hierarchical tag groups UI, and nested overlays.
  - Issues: very broad responsibilities and several memoized inner components in one file.
  - Refactor targets:
    - Move cloze/KaTeX preview to `components/note/PreviewText.tsx` (pure presentational component) and a small util `lib/renderMath.ts` that guards KaTeX.
    - Move score badge rendering to `components/note/ScoreBadges.tsx`.
    - Extract virtualized row to `components/note/VirtualizedRow.tsx` (receives item, selection state, and callbacks).
    - Extract hierarchical Tag Groups to `components/tags/TagGroup.tsx` and `components/tags/TagNavigation.tsx`.
    - Keep `NoteList.tsx` as a thin orchestrator choosing between flat vs grouped renderers.

- Note details — `src/renderer/src/components/NoteDetails.tsx`
  - Size/role: large; contains HTML media rewrite, math rendering, field cards, metadata panel, related-notes panel (BM25/semantic/hybrid), tag overlay with embedded `NoteList`, and unsuspend.
  - Issues: mixing rendering helpers and multiple subfeatures in one file; local overlays/related logic increase scope.
  - Refactor targets:
    - Extract media/maths helpers to `src/renderer/src/lib/html/`:
      - `rewriteMediaHtml.ts` (parametrize media dir; avoid hard-coded path; read from `window.api.getSetting('anki_media_dir')`).
      - `renderMath.ts` (shared KaTeX runner with strict: false and Unicode filter).
      - `htmlText.ts` (strip/clean helpers used across list/details).
    - Extract field card to `components/details/FieldCard.tsx`.
    - Extract metadata panel to `components/details/MetaPanel.tsx`.
    - Extract related-notes to `components/details/RelatedNotes.tsx` with mode tabs and caching.
    - Extract tag overlay to `components/tags/TagNotesOverlay.tsx` and reuse `NoteList` via props.

- UI primitives — `src/renderer/src/components/ui/*`
  - Generally modular and clean; no action needed.

### Preload (Bridge)

- Bridge monolith — `src/preload/index.ts`
  - Size/role: very large; owns DB setup, settings, tags utilities, FTS/BM25, embeddings, HNSW build, hybrid scoring, caching, classification/grouping calls, note details cache, and more.
  - Refactor targets (directory-first split; keep types in `index.d.ts`):
    - `src/preload/db/`:
      - `mainDb.ts` (`getDb`, PRAGMAs, ensure FTS infra).
      - `embDb.ts` (`getEmbDb`, keyword embeddings cache schema).
      - `settings.ts` (get/setSetting helpers).
      - `notes.ts` (list/count/getNoteDetails helpers; first/back field batchers).
      - `tags.ts` (listAllTags, getChildTags, tag caches).
    - `src/preload/search/`:
      - `bm25.ts` (already exists) and keep FTS helpers there.
      - `hybrid.ts` (hybridSemanticModulated, penalty/boost curves, normalization utilities).
      - `embedding.ts` (query embedding cache, DeepInfra calls, embedSearch, related by embedding/terms, HNSW build/status and read/write index).
      - `rerank.ts` (semanticRerank, semanticRerankSmall; DeepInfra reranker).
      - `keywords.ts` (extractQueryKeywords, per-note keyword extraction, clustering, cosine for terms; unify with `src/lib/keywordExtractor.ts`).
    - `src/preload/ai/`:
      - `grouping.ts` (groupNotesByAI, robust JSON parsing util).
      - `classification.ts` (classifyBadges with concurrency limits and cost guards).
    - `src/preload/cache/`:
      - `noteDetailsCache.ts` (TTL and map management).
      - `queryEmbCache.ts` (TTL constants, key generation; ensure stable `makeEmbKey`).
    - Keep `src/preload/index.ts` as a thin export surface that composes and bridges functions onto `contextBridge.exposeInMainWorld('api', ...)`.

- Type declarations — `src/preload/index.d.ts`
  - Good shape; keep as the single source of truth for `window.api`. After refactor, ensure barrel exports feed into bridge and declarations stay aligned.

### Scripts and Database

- Ingest and embed scripts — `database/*.mjs`
  - Keep as-is. Consider moving shared utilities (HTML strip, first-field extraction) to a shared `src/shared/` module consumed by both scripts and preload.

### Quick Wins (low risk)

- Replace hard-coded Anki media path in `NoteDetails.tsx` with a setting: add `anki_media_dir` to Settings, reference via `window.api.getSetting('anki_media_dir')`.
- Centralize HTML strip/clean functions (renderer and preload currently implement similar logic).
- Create `src/renderer/src/lib/types.ts` for shared UI-facing row types to reduce local inline types.

### Large File Hotspots (to split)

- `src/preload/index.ts` — split across db/search/ai/cache modules as outlined.
- `src/renderer/src/components/NoteList.tsx` — split preview, badges, virtualization row, tag groups, tag navigation.
- `src/renderer/src/components/NoteDetails.tsx` — split html helpers, field card, meta panel, related notes, tag overlay.
- `src/renderer/src/components/Header.tsx` — split search input, primary actions, post-search bar, badges row, keyword chips.

### Module Naming Conventions

- Feature-first folders under `components/` (e.g., `components/details/*`, `components/note/*`, `components/header/*`, `components/tags/*`).
- In preload, domain-first folders (`db`, `search`, `ai`, `cache`) with narrow files.
- Shared utils in `src/shared/` or `src/renderer/src/lib/` with single-responsibility exports.

### Sequence to Implement Safely

1) Extract renderer helpers that have no side effects (PreviewText, ScoreBadges, htmlText, renderMath, rewriteMediaHtml).
2) Split `NoteList` and `NoteDetails` into subcomponents while keeping props stable.
3) Introduce `ResultsController` in renderer and migrate search handlers in `App.tsx` to it.
4) Split preload into `db/*` and `search/*` modules; re-export through `index.ts` so `window.api` stays stable.
5) Finally, split AI grouping/classification and caches; align `index.d.ts` and run a type check.

These changes preserve behavior while making each unit focused and testable, easing future maintenance and performance work.
