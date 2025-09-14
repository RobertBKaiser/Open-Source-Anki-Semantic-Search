# Open-Source Anki Semantic Search

An Electron desktop app that brings fast fuzzy search, semantic reranking, and embedding-based search to your Anki notes. Built with Electron, React, TypeScript, and SQLite.

<img width="1710" height="1068" alt="Screenshot 2025-09-14 at 12 46 50 PM" src="https://github.com/user-attachments/assets/73bee340-2ed6-435c-876f-d3ef3d2c8f38" />

Features
- Exact search (boolean AND across fields)
- Fuzzy search (BM25 per-keyword + RRF)
- Semantic reranking (DeepInfra Qwen3 Reranker)
- Embedding search (Qwen3 Embedding 8B, cosine similarity)
- Incremental sync and embedding indexing
- UI: live keyword pills, cosine threshold slider, infinite scroll, unsuspend

Requirements
- Anki with AnkiConnect enabled (default `http://127.0.0.1:8765`)
- DeepInfra API key for reranker/embeddings

## Quick start tutorial

1) Requirements
- Install and open Anki. Install/enable the AnkiConnect add‑on (default at `http://127.0.0.1:8765`).
- Create a DeepInfra API key for Qwen models.

2) First launch
- Open the app. Click the Settings cog → API tab.
- Paste your DeepInfra API key. Optionally adjust the reranker instruction.

3) Sync and browse
- Click Sync in Settings to import your Anki notes into the local cache.
- The left pane lists notes (infinite scroll); the right pane shows details.

4) Search modes
- Exact search: type in the top search bar and press Enter. Returns notes that contain all terms (boolean AND).
- Fuzzy Search: click “Fuzzy Search” for weighted-BM25 per-keyword search with RRF across keywords.
  - Keyword chips appear under the search bar. Remove chips to refine (removals are debounced for 2s so you can delete several at once).
  - If there are >13 keywords, extra ones collapse under an expander.
- Reranking: click “Reranking” to re‑order fuzzy results using DeepInfra Qwen3 Reranker. Use the “Cos similarity %” slider to threshold.
- Semantic Search: click “Semantic Search” to run embedding search (Qwen3 Embedding 8B). Use the slider to filter by cosine.

5) Embeddings (optional but recommended)
- Settings → Embeddings tab → Start. This indexes your notes with embeddings in the background. Progress and ETA display live.

6) Actions
- Multi‑select notes with the checkboxes. Click “Unsuspend (N)” to unsuspend via AnkiConnect.

Configuration
- Open Settings in the app to set the DeepInfra API key and reranker instruction.
- Embedding indexer runs as a background worker; progress is visible in Settings.

## Troubleshooting
- AnkiConnect not found: Ensure Anki is running and AnkiConnect is installed; verify by POSTing `{ action: "version" }` to `http://127.0.0.1:8765`.
- Reranker/Embeddings return empty: Confirm DeepInfra API key in Settings. Check the app’s console for HTTP errors.
- macOS blocked app: see “Gatekeeper (unsigned builds)” above.

Security & Privacy
- No keys are hardcoded. Keys are stored locally in `app_settings` (SQLite).
- Local databases (`database/*.db`) are ignored by git.

Contributing
- PRs welcome!

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
