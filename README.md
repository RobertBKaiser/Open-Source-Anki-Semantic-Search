# Open-Source Anki Semantic Search

An Electron desktop app that brings fast fuzzy search, semantic reranking, and embedding-based search to your Anki notes. Built with Electron, React, TypeScript, and SQLite.

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

Setup
```bash
npm install
npm run dev
```

Build
```bash
# macOS
npm run build:mac
# Windows
npm run build:win
# Linux
npm run build:linux
```

Configuration
- Open Settings in the app to set the DeepInfra API key and reranker instruction.
- Embedding indexer runs as a background worker; progress is visible in Settings.

Security & Privacy
- No keys are hardcoded. Keys are stored locally in `app_settings` (SQLite).
- Local databases (`database/*.db`) are ignored by git.

License
MIT — see `LICENSE`.

Contributing
- PRs welcome! Please run `npm run lint` and `npm run typecheck` before submitting.


## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

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
