import { contextBridge } from 'electron'
import { searchBm25 } from './search/bm25'
import { rrfCombinePerKeywordWeighted } from './search/combine'
import { extractKeywords as kwExtract } from './search/kw'
import Database from 'better-sqlite3'
import { spawn } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
import { electronAPI } from '@electron-toolkit/preload'
import { spawn as spawnChild } from 'node:child_process'

// Custom APIs for renderer
const dbPath = path.resolve(process.cwd(), 'database/anki_cache.db')
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
} catch {
  // ignore mkdir race condition or permission issues during init
}

let db: Database.Database | null = null
let dbInitialized = false
function tuneDb(handle: Database.Database): void {
  try {
    handle.pragma('journal_mode = WAL')
    handle.pragma('synchronous = NORMAL')
    handle.pragma('temp_store = MEMORY')
    // Negative cache_size sets KiB; e.g., -262144 => 256MB
    handle.pragma('cache_size = -262144')
    // 256MB mmap
    handle.pragma('mmap_size = 268435456')
  } catch {}
}
function ensureSearchInfra(handle: Database.Database): void {
  if (dbInitialized) return
  try {
    // Core tables / indexes used in hot paths
    handle.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(content, note_id UNINDEXED, tokenize='unicode61');
       CREATE INDEX IF NOT EXISTS idx_note_fields_note_ord ON note_fields(note_id, ord);`
    )
    // Build fts5vocab once so IDF reads are instantaneous later
    try { handle.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts_vocab USING fts5vocab(note_fts, 'row')`) } catch {}
  } catch {}
  dbInitialized = true
}
function getDb(): Database.Database {
  if (!db) {
    db = new Database(dbPath)
    tuneDb(db)
    ensureSearchInfra(db)
  }
  return db
}

// Keep a process-wide embeddings DB connection and tune it
const embPathGlobal = path.resolve(process.cwd(), 'database/embeddings.db')
let dbEmbGlobal: Database.Database | null = null
function getEmbDb(): Database.Database {
  if (!dbEmbGlobal) {
    dbEmbGlobal = new Database(embPathGlobal)
    tuneDb(dbEmbGlobal)
    // Keyword embedding cache table
    try {
      dbEmbGlobal.exec(`
        CREATE TABLE IF NOT EXISTS keyword_embeddings (
          term TEXT PRIMARY KEY,
          dim INTEGER NOT NULL,
          vec BLOB NOT NULL,
          norm REAL NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
    } catch {}
  }
  return dbEmbGlobal
}

const api = {
  getSetting(key: string): string | null {
    try {
      const db = getDb()
      db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  },

  // Hybrid: BM25-modulated semantic score
  async hybridSemanticModulated(query: string, limit: number = 200): Promise<Array<{ note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number; matched?: number }>> {
    const q = String(query || '').trim()
    if (!q) return []
    const terms = api.extractQueryKeywords(q)

    // Helpers
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
    const bm25ToPercent = (bm25: number, matched: number): number => {
      // Softer, capped boost above ~16; near-zero boost by ~7
      const s = Math.max(0, -Number(bm25 || 0)) // magnitude: larger is better
      const tau = 9.0 // slower growth
      const baseAmp = 0.60 // cap overall influence
      // Logistic gate centered a bit higher with gentler slope to avoid over-boost around 16
      const s0 = 18.0
      const k = 0.45
      const gate = 1 / (1 + Math.exp(-k * (s - s0))) // ~0 at 7, ~0.5 at 18, →1 > 22
      const base = baseAmp * (1 - Math.exp(-s / tau))
      const bonus = 0.03 * (1 - Math.exp(-Math.max(0, matched - 1) / 2.0)) // smaller multi-match bump
      const raw = Math.max(0, base - 0.02 + bonus)
      // Final cap keeps very large BM25 from dominating
      const pct = Math.min(0.65, raw * gate)
      return pct
    }
    const smoothstep = (e0: number, e1: number, x: number): number => {
      const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-9, e1 - e0)))
      return t * t * (3 - 2 * t)
    }
    const penaltyFactor = (bm25: number, cos: number): number => {
      // Penalize cosine when BM25 is weak (s < 11), with heavy emphasis below 7.
      // Fade the penalty out smoothly between cosine 0.5 and 0.6 (no penalty ≥ 0.6).
      const s = Math.max(0, -Number(bm25 || 0))
      const pLow = 1 - smoothstep(7.0, 11.0, s) // 1 at s<=7 -> 0 at s>=11
      const pHeavy = pLow * pLow
      const pModest = Math.max(0, pLow - pHeavy)
      const gateCos = 1 - smoothstep(0.5, 0.6, Math.max(0, Math.min(1, cos)))
      // Lighten penalties so BM25 around -7 doesn't depress scores too much
      const H = 0.35, M = 0.15
      const reduce = (H * pHeavy + M * pModest) * gateCos
      return Math.max(0, Math.min(1, 1 - reduce))
    }
    const modulated = (cos: number, bm25: number, matched: number): number => {
      const cosn = clamp01(Number(cos || 0))
      const F = penaltyFactor(bm25, cosn)
      const cosAdj = cosn * F
      const bmPct = bm25ToPercent(bm25, matched)
      // Positive BM25 boost competes with the (potentially) penalized cosine, stays in [0,1]
      return cosAdj + bmPct * (1 - cosAdj)
    }

    // 1) Retrieve candidates from embeddings and BM25
    let emb: Array<{ note_id: number; first_field: string | null; rerank: number }> = []
    try { emb = await api.embedSearch(q, 400) } catch { emb = [] }
    const bm = api.searchByBm25Terms(terms, 1200)

    // 2) Build union candidates
    type Cand = { id: number; first: string | null; cos?: number; bm25?: number }
    const byId: Map<number, Cand> = new Map()
    for (const r of emb || []) {
      const e = byId.get(r.note_id) || { id: r.note_id, first: r.first_field ?? null }
      const cos = Number(r.rerank || 0)
      e.cos = Math.max(e.cos ?? -Infinity, cos)
      byId.set(r.note_id, e)
    }
    for (const r of bm || []) {
      const e = byId.get(r.note_id) || { id: r.note_id, first: r.first_field ?? null }
      const s = Number(r.bm25 || 0)
      e.bm25 = Math.min(e.bm25 ?? Number.POSITIVE_INFINITY, s)
      byId.set(r.note_id, e)
    }
    if (byId.size === 0) return []

    // 3) Count matched keywords (front/back contains naive check)
    const db = getDb()
    const backStmt = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord DESC LIMIT 1')
    const matchCount = (first: string | null, back: string | null, terms: string[]): number => {
      const f = String(first || '').toLowerCase()
      const b = String(back || '').toLowerCase()
      let c = 0
      for (const t of terms) {
        const q = String(t || '').toLowerCase()
        if (!q) continue
        if (f.includes(q) || b.includes(q)) c++
      }
      return c
    }

    // 4) Backfill cosine for BM25-only notes (compute query embedding once, then dot with their vectors)
    try {
      const needCos: number[] = []
      for (const e of byId.values()) if (typeof e.cos !== 'number') needCos.push(e.id)
      const apiKey = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
      if (needCos.length > 0 && apiKey) {
        const model = api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
        const dims = Number(api.getSetting('deepinfra_embed_dims') || '8192')
        // Embed the whole query as one input (sufficient for backfilling tooltips and modulation)
        const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: [q], encoding_format: 'float', dimensions: dims })
        })
        if (res.ok) {
          const j = await res.json() as { data?: Array<{ embedding: number[] }> }
          const emb = (Array.isArray(j?.data) && j.data![0]?.embedding) ? j.data![0].embedding : null
          if (Array.isArray(emb) && emb.length === dims) {
            const qv = new Float32Array(emb)
            let qn = 0; for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i]
            qn = Math.sqrt(qn) || 1
            const dbEmb = getEmbDb()
            // Chunk IN clause to avoid parameter limits
            const CHUNK = 900
            for (let i = 0; i < needCos.length; i += CHUNK) {
              const ids = needCos.slice(i, i + CHUNK)
              const placeholders = ids.map(() => '?').join(',')
              const rows = dbEmb.prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`).all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
              for (const r of rows) {
                if (!r.vec || r.dim !== qv.length) continue
                const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
                let dot = 0; for (let k = 0; k < qv.length; k++) dot += qv[k] * v[k]
                const cos = dot / (qn * (r.norm || 1))
                const e = byId.get(r.note_id); if (e) e.cos = cos
              }
            }
          }
        }
      }
    } catch {}

    // 5) Score and sort
    const out: Array<{ note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number; matched?: number }> = []
    for (const e of byId.values()) {
      const back = (backStmt.get(e.id) as { value_html?: string } | undefined)?.value_html ?? null
      const matched = matchCount(e.first || null, back, terms)
      const cos = typeof e.cos === 'number' ? e.cos : 0
      const bm25 = Number(e.bm25 ?? 0)
      const score = modulated(cos, bm25, matched)
      const payload: any = { note_id: e.id, first_field: e.first ?? null, score, bm25, matched }
      if (typeof e.cos === 'number') payload.cos = e.cos
      out.push(payload)
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, Math.max(1, limit))
  },
  // BM25 scores for a specific set of notes against selected terms; used to reorder an existing result set
  bm25ForNotesByTerms(terms: string[], noteIds: number[]): Array<{ note_id: number; bm25: number }> {
    try {
      const db = getDb()
      api._ensureSearchIndexes()
      const cleanTerms = Array.isArray(terms) ? terms.map((t) => String(t || '').trim()).filter((t) => t.length > 0) : []
      const cleanIds = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
      if (cleanTerms.length === 0 || cleanIds.length === 0) return []
      const cappedTerms = cleanTerms.slice(0, 16)
      const expr = cappedTerms.map((t) => `"${t}"`).join(' OR ')
      const placeholders = cleanIds.map(() => '?').join(',')
      const sql = `SELECT note_id, bm25(note_fts) AS score FROM note_fts WHERE note_fts MATCH ? AND note_id IN (${placeholders}) ORDER BY score`
      const stmt = db.prepare(sql)
      const rows = stmt.all(expr, ...cleanIds) as Array<{ note_id: number; score: number }>
      return rows.map((r) => ({ note_id: r.note_id, bm25: Number(r.score) }))
    } catch {
      return []
    }
  },

  // Get or compute embeddings for keywords; caches in keyword_embeddings
  async getKeywordEmbeddings(terms: string[]): Promise<Array<{ term: string; vec: Float32Array }>> {
    const key = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
    const model = api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
    const dims = Number(api.getSetting('deepinfra_embed_dims') || '8192')
    const dbEmb = getEmbDb()
    const clean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean) : []
    if (clean.length === 0) return []
    const out: Array<{ term: string; vec: Float32Array }> = []
    const need: string[] = []
    const sel = dbEmb.prepare('SELECT term, dim, vec FROM keyword_embeddings WHERE term = ?')
    for (const t of clean) {
      const r = sel.get(t) as { term?: string; dim?: number; vec?: Buffer } | undefined
      if (r && r.vec && r.dim === dims) {
        out.push({ term: t, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4) })
      } else {
        need.push(t)
      }
    }
    if (need.length > 0 && key) {
      const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, input: need, encoding_format: 'float', dimensions: dims })
      })
      if (res.ok) {
        const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
        const data = Array.isArray(j?.data) ? j!.data! : []
        const ins = dbEmb.prepare('INSERT INTO keyword_embeddings(term, dim, vec, norm, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(term) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, norm=excluded.norm, updated_at=excluded.updated_at')
        for (let i = 0; i < need.length; i++) {
          const t = need[i]
          const emb = data[i]?.embedding || []
          const arr = new Float32Array(emb)
          let norm = 0
          for (let k = 0; k < arr.length; k++) norm += arr[k] * arr[k]
          norm = Math.sqrt(norm) || 1
          ins.run(t, dims, Buffer.from(arr.buffer), norm, Date.now())
          out.push({ term: t, vec: arr })
        }
      }
    }
    return out
  },

  // Cluster keywords by cosine similarity using cached embeddings
  async clusterKeywords(terms: string[], threshold: number = 0.85): Promise<Map<string, string>> {
    const embs = await api.getKeywordEmbeddings(terms)
    const by = new Map(embs.map((e) => [e.term, e.vec]))
    const repBy = new Map<string, string>()
    for (const t of terms.map((x) => String(x || '').toLowerCase())) {
      if (repBy.has(t)) continue
      const v = by.get(t)
      if (!v) { repBy.set(t, t); continue }
      repBy.set(t, t)
      const vnorm = (() => { let s=0; for (let i=0;i<v.length;i++) s+=v[i]*v[i]; return Math.sqrt(s)||1 })()
      for (const [uTerm, uVec] of by) {
        if (repBy.has(uTerm)) continue
        let dot = 0, un=0
        for (let i=0;i<v.length && i<uVec.length;i++) dot += v[i]*uVec[i]
        for (let i=0;i<uVec.length;i++) un += uVec[i]*uVec[i]
        const cos = dot / (vnorm * (Math.sqrt(un)||1))
        if (cos >= threshold) repBy.set(uTerm, t)
      }
    }
    return repBy
  },

  // For a set of keywords, compute cosine similarity to a query (uses cached embeddings; embeds if missing)
  async cosineForTerms(terms: string[], query: string): Promise<Array<{ term: string; cos: number }>> {
    try {
      const cleanTerms = Array.isArray(terms) ? terms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean) : []
      const q = String(query || '').trim().toLowerCase()
      if (!q || cleanTerms.length === 0) return []
      const embs = await api.getKeywordEmbeddings([...cleanTerms, q])
      const by = new Map(embs.map((e) => [e.term, e.vec]))
      const qv = by.get(q)
      if (!qv) return []
      let qn = 0
      for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i]
      qn = Math.sqrt(qn) || 1
      const out: Array<{ term: string; cos: number }> = []
      for (const t of cleanTerms) {
        const v = by.get(t)
        if (!v) { out.push({ term: t, cos: -1 }) ; continue }
        let dot = 0, vn = 0
        for (let i = 0; i < v.length; i++) { dot += (v[i] || 0) * (qv[i] || 0); vn += v[i] * v[i] }
        const cos = dot / (qn * (Math.sqrt(vn) || 1))
        out.push({ term: t, cos })
      }
      return out
    } catch {
      return []
    }
  },

  // Cosine similarity for one keyword against a subset of notes (by note_id)
  async embedCosForTermAgainstNotes(term: string, noteIds: number[]): Promise<Array<{ note_id: number; cos: number }>> {
    try {
      const ids = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
      if (!term || ids.length === 0) return []
      const embs = await api.getKeywordEmbeddings([String(term).toLowerCase()])
      const vec = embs[0]?.vec
      if (!vec) return []
      let qnorm = 0
      for (let i = 0; i < vec.length; i++) qnorm += vec[i] * vec[i]
      qnorm = Math.sqrt(qnorm) || 1
      const dbEmb = getEmbDb()
      const placeholders = ids.map(() => '?').join(',')
      const rows = dbEmb
        .prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`)
        .all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
      const out: Array<{ note_id: number; cos: number }> = []
      for (const r of rows) {
        const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        if (v.length !== vec.length) { out.push({ note_id: r.note_id, cos: -1 }); continue }
        let dot = 0
        for (let i = 0; i < vec.length; i++) dot += vec[i] * v[i]
        const cos = dot / (qnorm * (r.norm || 1))
        out.push({ note_id: r.note_id, cos })
      }
      return out
    } catch {
      return []
    }
  },

  // Cosine similarity for a combo of 2-3 keywords against a subset of notes
  async embedCosForTermsComboAgainstNotes(terms: string[], noteIds: number[]): Promise<Array<{ note_id: number; cos: number }>> {
    try {
      const ids = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
      const clean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean) : []
      if (clean.length < 2 || clean.length > 3 || ids.length === 0) return []
      const embs = await api.getKeywordEmbeddings(clean)
      if (embs.length !== clean.length) return []
      const dims = embs[0].vec.length
      // Mean vector
      const mean = new Float32Array(dims)
      for (const e of embs) {
        for (let i = 0; i < dims; i++) mean[i] += e.vec[i]
      }
      for (let i = 0; i < dims; i++) mean[i] /= clean.length
      let qnorm = 0
      for (let i = 0; i < dims; i++) qnorm += mean[i] * mean[i]
      qnorm = Math.sqrt(qnorm) || 1
      const dbEmb = getEmbDb()
      const placeholders = ids.map(() => '?').join(',')
      const rows = dbEmb
        .prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`)
        .all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
      const out: Array<{ note_id: number; cos: number }> = []
      for (const r of rows) {
        const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        if (v.length !== dims) { out.push({ note_id: r.note_id, cos: -1 }); continue }
        let dot = 0
        for (let i = 0; i < dims; i++) dot += mean[i] * v[i]
        const cos = dot / (qnorm * (r.norm || 1))
        out.push({ note_id: r.note_id, cos })
      }
      return out
    } catch {
      return []
    }
  },

  // Extract top keywords for a set of notes; returns map-like array {note_id, keywords}
  extractKeywordsForNotes(noteIds: number[], perNoteTopK: number = 6, maxGlobal: number = 200): Array<{ note_id: number; keywords: string[] }> {
    try {
      const ids = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
      if (ids.length === 0) return []
      const db = getDb()
      const stmt = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      const strip = (html: string): string => String(html || '')
        .replace(/<br\s*\/?\?\s*>/gi, ' ')
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      const out: Array<{ note_id: number; keywords: string[] }> = []
      for (const id of ids.slice(0, maxGlobal)) {
        const row = stmt.get(id) as { value_html?: string } | undefined
        const text = strip(row?.value_html || '')
        const kws = text ? kwExtract(text, perNoteTopK) : []
        out.push({ note_id: id, keywords: kws })
      }
      return out
    } catch {
      return []
    }
  },

  // Find related notes by embedding cosine similarity (async, non-blocking chunks)
  async getRelatedByEmbedding(noteId: number, minCos: number = 0.7, topK: number = 50): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>> {
    try {
      const dbEmb = getEmbDb()
      const rowQ = dbEmb
        .prepare('SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id = ?')
        .get(noteId) as { note_id: number; dim: number; vec: Buffer; norm: number } | undefined
      if (!rowQ || !rowQ.vec || !rowQ.dim) return []
      const q = new Float32Array(rowQ.vec.buffer, rowQ.vec.byteOffset, rowQ.vec.byteLength / 4)
      const qnorm = rowQ.norm || 1
      const iter = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id != ?').iterate(noteId) as any
      const scores: Array<{ id: number; s: number }> = []
      let processed = 0
      for (const r of iter) {
        if (!r.vec || r.dim !== q.length) { processed++; continue }
        const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        let dot = 0
        for (let i = 0; i < q.length; i++) dot += q[i] * vec[i]
        const denom = (qnorm || 1) * (r.norm || 1)
        const cos = denom ? (dot / denom) : 0
        if (cos >= minCos) scores.push({ id: r.note_id, s: cos })
        processed++
        if (processed % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      scores.sort((a, b) => b.s - a.s)
      const picked = scores.slice(0, Math.max(1, Math.min(200, topK)))
      const firstFieldStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      return picked.map(({ id, s }) => {
        const row = firstFieldStmt.get(id) as { value_html?: string } | undefined
        return { note_id: id, first_field: row?.value_html ?? null, cos: s }
      })
    } catch {
      return []
    }
  },

  // Extract top key ideas from a note's front field using IDF over FTS vocab
  extractFrontKeyIdeas(noteId: number, maxItems: number = 10): string[] {
    // Backward-compatible alias that now uses the improved extractor
    try {
      const dbMain = getDb()
      const frontStmt = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
      const strip = (html: string): string => String(html || '')
        .replace(/<br\s*\/??\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      const text = strip(src)
      const terms = kwExtract(text, Math.max(1, maxItems))
      return terms
    } catch {
      return []
    }
  },

  // New: deterministic top keywords for a note's front
  getTopKeywordsForNote(noteId: number, maxItems: number = 8): string[] {
    try {
      const dbMain = getDb()
      const frontStmt = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
      const strip = (html: string): string => String(html || '')
        .replace(/<br\s*\/??\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      return kwExtract(strip(src), Math.max(1, maxItems))
    } catch {
      return []
    }
  },

  // LLM-based key idea extraction via OpenAI Responses prompt (expects plain text input)
  async extractFrontKeyIdeasLLM(noteId: number, maxItems: number = 10): Promise<string[]> {
    try {
      const apiKey = api.getSetting('openai_api_key') || process.env.OPENAI_API_KEY || ''
      const promptId = api.getSetting('openai_kw_prompt_id') || 'pmpt_68b5ad09507c8195999c456bd50afd3809e0e005559ce008'
      if (!apiKey || !promptId) return []
      const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
      const strip = (html: string): string => String(html || '')
        .replace(/<br\s*\/??\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      const text = strip(src)
      if (!text) return []
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          prompt: { id: promptId, version: '1' },
          input: text
        })
      })
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error('extractFrontKeyIdeasLLM: OpenAI API failed', res.status, await res.text())
        return []
      }
      const json = await res.json() as any
      // Prefer output_text; fallback to concatenating content blocks if present
      let output = ''
      try {
        output = String(json?.output_text || '')
        if (!output && Array.isArray(json?.output)) {
          const textPieces: string[] = []
          for (const item of json.output) {
            const content = Array.isArray(item?.content) ? item.content : []
            for (const c of content) {
              const t = (c?.text?.value || c?.text || '').toString()
              if (t) textPieces.push(t)
            }
          }
          output = textPieces.join(' ').trim()
        }
      } catch {}
      if (!output) {
        // eslint-disable-next-line no-console
        console.warn('extractFrontKeyIdeasLLM: empty response body', JSON.stringify(json).slice(0, 400))
        return []
      }
      const parts = output.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      const uniq: string[] = []
      const seen = new Set<string>()
      for (const p of parts) {
        const key = p.toLowerCase()
        if (!seen.has(key)) { seen.add(key); uniq.push(p) }
        if (uniq.length >= maxItems) break
      }
      return uniq
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('extractFrontKeyIdeasLLM: request error', e)
      return []
    }
  },

  // BM25-based related notes using first-field text as a query (optionally limited to selected terms)
  getRelatedByBm25(noteId: number, limit: number = 20, terms?: string[]): Array<{ note_id: number; first_field: string | null; bm25: number }> {
    try {
      const dbMain = getDb()
      api._ensureSearchIndexes()
      const frontStmt = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
      const strip = (html: string): string => String(html || '')
        .replace(/<br\s*\/??\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      const text = strip(src)
      let tsel = Array.isArray(terms) && terms.length ? terms.slice(0, 16) : kwExtract(text, 16)
      if (tsel.length === 0) return []
      const expr = tsel.map((t) => `"${t}"`).join(' OR ')
      const hits = searchBm25(dbMain as any, expr, Math.max(100, limit * 5))
      const filtered = hits.filter((h) => h.note_id !== noteId).slice(0, Math.max(1, limit))
      const firstField = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      return filtered.map((h) => {
        const row = firstField.get(h.note_id) as { value_html?: string } | undefined
        return { note_id: h.note_id, first_field: row?.value_html ?? null, bm25: Number(h.score) }
      })
    } catch {
      return []
    }
  },

  // Embedding-based related notes from selected concept terms (fallback when BM25 empty)
  async getRelatedByEmbeddingTerms(terms: string[], topK: number = 20): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>> {
    try {
      const key = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
      if (!key) return []
      const model = api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
      const dims = Number(api.getSetting('deepinfra_embed_dims') || '8192')
      const termsClean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim()).filter((t) => t.length > 0) : []
      if (termsClean.length === 0) return []
      // Embed each term individually
      const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, input: termsClean, encoding_format: 'float', dimensions: dims })
      })
      if (!res.ok) return []
      const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
      const embList = Array.isArray(j?.data) ? j!.data!.map((d) => d.embedding) : []
      if (embList.length === 0) return []
      const dbEmb = getEmbDb()
      const iter = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings').iterate() as any
      const perNoteBestCos = new Map<number, number>()
      const perNoteRrf = new Map<number, number>()
      const K = 60
      for (const emb of embList) {
        if (!Array.isArray(emb)) continue
        const q = new Float32Array(emb)
        let qnorm = 0
        for (let i = 0; i < q.length; i++) qnorm += q[i] * q[i]
        qnorm = Math.sqrt(qnorm) || 1
        const scores: Array<{ id: number; s: number }> = []
        for (const r of iter) {
          if (!r.vec || r.dim !== q.length) continue
          const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
          let dot = 0
          for (let i = 0; i < q.length; i++) dot += q[i] * vec[i]
          const cos = dot / (qnorm * (r.norm || 1))
          scores.push({ id: r.note_id, s: cos })
        }
        scores.sort((a, b) => b.s - a.s)
        for (let rank = 0; rank < scores.length; rank++) {
          const { id, s } = scores[rank]
          if (!perNoteBestCos.has(id) || s > (perNoteBestCos.get(id) as number)) perNoteBestCos.set(id, s)
          perNoteRrf.set(id, (perNoteRrf.get(id) || 0) + 1 / (K + (rank + 1)))
        }
      }
      const final = Array.from(perNoteRrf.entries())
        .map(([id, rrf]) => ({ id, rrf, cos: perNoteBestCos.get(id) || 0 }))
        .sort((a, b) => (b.cos - a.cos) || (b.rrf - a.rrf))
        .slice(0, Math.max(1, Math.min(100, topK)))
      const firstFieldStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      return final.map(({ id, cos }) => {
        const row = firstFieldStmt.get(id) as { value_html?: string } | undefined
        return { note_id: id, first_field: row?.value_html ?? null, cos }
      })
    } catch {
      return []
    }
  },
  setSetting(key: string, value: string): void {
    try {
      const db = getDb()
      db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
      db.prepare('INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
    } catch {
      // ignore
    }
  },
  // Production extractor: reuse the same keyword/phrase extractor used by related notes
  extractQueryKeywords(query: string): string[] {
    const qnorm = String(query || '').replace(/\s+/g, ' ').trim()
    if (!qnorm) return []
    return kwExtract(qnorm, 16)
  },
  listNotes(limit = 200, offset = 0): Array<{ note_id: number; first_field: string | null }> {
    const stmt = getDb().prepare(
      `SELECT n.note_id,
              (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
         FROM notes n
        ORDER BY n.note_id DESC
        LIMIT ? OFFSET ?`
    )
    return stmt.all(limit, offset)
  },

  // BM25 search directly from a list of selected keywords/phrases
  searchByBm25Terms(terms: string[], limit: number = 200): Array<{ note_id: number; first_field: string | null; bm25: number }> {
    try {
      const db = getDb()
      api._ensureSearchIndexes()
      const clean = Array.isArray(terms)
        ? terms.map((t) => String(t || '').trim()).filter((t) => t.length > 0)
        : []
      if (clean.length === 0) return []
      const capped = clean.slice(0, 16)
      const expr = capped.map((t) => `"${t}"`).join(' OR ')
      const fetch = Math.min(5000, Math.max(limit * 2, 1000))
      const hits = searchBm25(db as any, expr, fetch)
      const firstField = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      return hits.slice(0, limit).map((h) => {
        const row = firstField.get(h.note_id) as { value_html?: string } | undefined
        return { note_id: h.note_id, first_field: row?.value_html ?? null, bm25: Number(h.score) }
      })
    } catch {
      return []
    }
  },

  // OpenAI-based badge classification for visible notes (one-by-one calls)
  async classifyBadges(noteIds: number[], queryText: string): Promise<Array<{ note_id: number; category: 'in' | 'out' | 'related' | 'unknown' }>> {
    try {
      if (!Array.isArray(noteIds) || noteIds.length === 0) return []
      const apiKey = api.getSetting('openai_api_key') || process.env.OPENAI_API_KEY || ''
      // Prefer new key 'openai_badge_prompt_id', but support legacy 'openai_badge_prompt_url'
      const promptId = api.getSetting('openai_badge_prompt_id') || api.getSetting('openai_badge_prompt_url') || ''
      if (!apiKey || !promptId) {
        // eslint-disable-next-line no-console
        console.warn('classifyBadges: missing OpenAI API key or Prompt ID')
        return noteIds.map((id) => ({ note_id: id, category: 'unknown' }))
      }
      const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      const strip = (html: string): string => String(html || '')
        .replace(/<br\s*\/??\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      const docs = noteIds.map((id) => ({ id, text: strip(((frontStmt.get(id) as { value_html?: string } | undefined)?.value_html) || '') }))
      const url = 'https://api.openai.com/v1/responses'
      // eslint-disable-next-line no-console
      console.log('classifyBadges: calling OpenAI one-by-one for', docs.length, 'cards')

      // Helpers for parsing a single digit 0..3 from a response
      const extractSingleDigitFromJson = (jsonStr: string): number | undefined => {
        try {
          const j = JSON.parse(jsonStr)
          const fields: string[] = []
          if (typeof j?.output_text === 'string') fields.push(j.output_text)
          if (typeof j?.text === 'string') fields.push(j.text)
          if (Array.isArray(j?.output)) {
            for (const item of j.output) {
              const contentArr = Array.isArray(item?.content) ? item.content : []
              for (const c of contentArr) {
                const t = (c?.text?.value || c?.text || '').toString()
                if (t) fields.push(t)
              }
            }
          }
          for (const f of fields) {
            const d = extractSingleDigit(f)
            if (typeof d === 'number') return d
          }
        } catch {}
        return undefined
      }
      const extractSingleDigit = (s: string): number | undefined => {
        const sent = /BEGIN_DIGITS\s*<\s*([0-3])\s*>\s*END_DIGITS/i.exec(s)
        if (sent && sent[1]) return Number(sent[1])
        const m = /\b([0-3])\b/.exec(s)
        return m ? Number(m[1]) : undefined
      }

      // Concurrency control
      const CONCURRENCY = 5
      let idx = 0
      const resultsNum: Array<number | undefined> = new Array(docs.length).fill(undefined)
      async function worker(): Promise<void> {
        while (true) {
          const i = idx
          if (i >= docs.length) return
          idx++
          const d = docs[i]
          const input = [
            'QUERY:',
            String(queryText || ''),
            '',
            'CARD:',
            `id=${d.id} ${d.text}`,
            '',
            'OUTPUT FORMAT:',
            'Return ONLY one integer in [0,3]. Example: 1',
            'Additionally, include the same value between markers as: BEGIN_DIGITS <d> END_DIGITS',
            'No extra text.'
          ].join('\n')
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
              body: JSON.stringify({ prompt: { id: promptId }, input })
            })
            if (!res.ok) {
              // eslint-disable-next-line no-console
              console.error('classifyBadges:item error', d.id, res.status, await res.text())
              continue
            }
            const raw = await res.text()
            let digit = extractSingleDigitFromJson(raw)
            if (typeof digit !== 'number') digit = extractSingleDigit(raw)
            // eslint-disable-next-line no-console
            console.log('classifyBadges:item parsed', d.id, '=>', digit)
            resultsNum[i] = typeof digit === 'number' ? Math.max(0, Math.min(3, digit)) : undefined
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('classifyBadges:item fetch failed', d.id, e)
          }
        }
      }
      await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()))

      const byId = new Map<number, { category?: 'in' | 'out' | 'related' | 'unknown'; category_num?: 0 | 1 | 2 | 3 }>()
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i]
        const num = resultsNum[i]
        const mapped: { category?: 'in' | 'out' | 'related' | 'unknown'; category_num?: 0 | 1 | 2 | 3 } = {}
        if (typeof num === 'number') mapped.category_num = num as 0 | 1 | 2 | 3
        byId.set(d.id, mapped)
      }
      return noteIds.map((id) => {
        const v = byId.get(id)
        if (!v) return { note_id: id, category: 'unknown' as const, category_num: undefined as any }
        const cat: 'in' | 'out' | 'related' | 'unknown' = v.category || 'unknown'
        return { note_id: id, category: cat, category_num: v.category_num }
      })
    } catch {
      return noteIds.map((id) => ({ note_id: id, category: 'unknown' }))
    }
  },
  countNotes(): number {
    const row = getDb().prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }
    return row?.c || 0
  },

  // Build or refresh FTS5 and trigram indexes used for fuzzy search
  _ensureSearchIndexes(): void {
    const db = getDb()
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(content, note_id UNINDEXED, tokenize='unicode61');
       CREATE INDEX IF NOT EXISTS idx_note_fields_note_ord ON note_fields(note_id, ord);`
    )

    const noteCount = db.prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }
    const ftsCount = db.prepare('SELECT COUNT(1) AS c FROM note_fts').get() as { c: number }
    const shouldRebuildFts = ftsCount.c !== noteCount.c
    const shouldRebuildTrigrams = false // trigram maintenance disabled for performance

    if (shouldRebuildFts || shouldRebuildTrigrams) {
      // Build indices using ONLY the first (front) field text per note
      const rows = db
        .prepare(
          `SELECT n.note_id AS note_id,
                  (SELECT nf.value_html
                     FROM note_fields nf
                    WHERE nf.note_id = n.note_id
                    ORDER BY nf.ord ASC
                    LIMIT 1) AS content
             FROM notes n`
        )
        .all() as Array<{ note_id: number; content: string | null }>

      const strip = (html: string): string => {
        const noImgs = html.replace(/<img[^>]*>/gi, ' 🖼️ ')
        const brSp = noImgs.replace(/<br\s*\/?\s*>/gi, ' ')
        const noTags = brSp.replace(/<[^>]*>/g, ' ')
        const noAudio = noTags.replace(/\[sound:[^\]]+\]/gi, ' 🔊 ')
        return noAudio
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
      }

      const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

      if (shouldRebuildFts) {
        db.exec('DELETE FROM note_fts')
        const insFts = db.prepare('INSERT INTO note_fts(content, note_id) VALUES (?, ?)')
        const txn = db.transaction((items: Array<{ note_id: number; text: string }>) => {
          for (const it of items) insFts.run(it.text, it.note_id)
        })
        const items = rows.map((r) => ({ note_id: r.note_id, text: normalize(strip(r.content || '')) }))
        txn(items)
      }

      if (shouldRebuildTrigrams) {
        // intentionally disabled
      }
    }
  },

  fuzzySearch(
    query: string,
    limit = 50,
    exclude: string[] = []
  ): Array<{ note_id: number; first_field: string | null; bm25?: number; trigrams?: number; combined: number; rrf: number; where?: 'front' | 'back' | 'both' }> {
    const db = getDb()
    api._ensureSearchIndexes()
    const qnorm = String(query || '').replace(/\s+/g, ' ').trim()
    if (!qnorm) {
      const rows = api.listNotes(limit, 0)
      return rows.map((r) => ({ ...r, combined: 0, rrf: 0 }))
    }

    // Improved keywords: use extractor (returns phrases + tokens)
    let terms = kwExtract(qnorm, 16)
    if (exclude.length) {
      const ex = new Set(exclude.map((s) => s.toLowerCase()))
      terms = terms.filter((t) => !ex.has(t.toLowerCase()))
    }
    if (terms.length === 0) terms = qnorm.split(/\s+/)

    const perTermMatch = terms.map((t) => `"${t}"`)
    const fetchBm25 = Math.min(5000, Math.max(limit * 2, 1000))
    const bm25Lists = perTermMatch.map((m) => searchBm25(db, m, fetchBm25))
    const widened = bm25Lists.every((l) => l.length === 0)
    const bm25Wide = widened ? [searchBm25(db, terms.map((t) => `"${t}"`).join(' OR '), fetchBm25)] : []

    // Compute per-keyword weights from selection cues: IDF (word or phrase), hyphenation, length, noun-ish heuristic
    let weights: number[] = []
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts_vocab USING fts5vocab(note_fts, 'row')`)
      const uniq = Array.from(new Set(terms))
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM note_fts`).get() as { c: number }).c || 1
      const unig = uniq.filter((t) => !t.includes(' '))
      const phr = uniq.filter((t) => t.includes(' '))
      const idfBy = new Map<string, number>()
      // Unigram df from fts5vocab
      if (unig.length) {
        const placeholders = unig.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT term, doc AS df FROM note_fts_vocab WHERE term IN (${placeholders})`)
          .all(...unig) as Array<{ term: string; df: number }>
        for (const t of unig) {
          const r = rows.find((x) => x.term === t)
          const df = r?.df ?? 0
          const idf = Math.log((total - df + 0.5) / (df + 0.5))
          idfBy.set(t, Math.max(0, isFinite(idf) ? idf : 0))
        }
      }
      // Phrase df via FTS MATCH count
      if (phr.length) {
        const countStmt = db.prepare('SELECT COUNT(1) AS c FROM note_fts WHERE note_fts MATCH ?')
        for (const p of phr) {
          const r = countStmt.get(`"${p}"`) as { c: number }
          const df = Number(r?.c || 0)
          const idf = Math.log((total - df + 0.5) / (df + 0.5))
          idfBy.set(p, Math.max(0, isFinite(idf) ? idf : 0))
        }
      }
      const nounSuffix = /(?:tion|sion|ment|ness|ity|ism|ology|logy|itis|emia|osis|oma|ectomy|plasty|scopy|gram|graphy|phobia|philia|gen|genic|ase|ose|algia|derm|cyte|blast|coccus|cocci|bacter|virus|enzyme|receptor|syndrome|disease|anemia|ecchymosis|contusion|hematoma|neuron|artery|vein|nerve|muscle|bone|cortex|nucleus|organ|tissue|cell|protein)$/
      function isLikelyNoun(token: string): boolean {
        if (token.includes('-')) return true
        if (nounSuffix.test(token)) return true
        if (token.length >= 5 && !/(?:ing|ed)$/.test(token)) return true
        return false
      }
      weights = terms.map((t) => {
        const base = 1
        const idf = Math.min(3, idfBy.get(t) ?? 0)
        const hyphen = t.includes('-') ? 0.75 : 0
        const long = t.length >= 8 ? 0.25 : 0
        const nounBoost = isLikelyNoun(t) ? 3.5 : 0
        return base + idf + hyphen + long + nounBoost
      })
    } catch {
      const nounSuffix = /(?:tion|sion|ment|ness|ity|ism|ology|logy|itis|emia|osis|oma|ectomy|plasty|scopy|gram|graphy|phobia|philia|gen|genic|ase|ose|algia|derm|cyte|blast|coccus|cocci|bacter|virus|enzyme|receptor|syndrome|disease|anemia|ecchymosis|contusion|hematoma|neuron|artery|vein|nerve|muscle|bone|cortex|nucleus|organ|tissue|cell|protein)$/
      function isLikelyNoun(token: string): boolean {
        if (token.includes('-')) return true
        if (nounSuffix.test(token)) return true
        if (token.length >= 5 && !/(?:ing|ed)$/.test(token)) return true
        return false
      }
      weights = terms.map((t) => 1 + (t.includes('-') ? 0.75 : 0) + (t.length >= 8 ? 0.25 : 0) + (isLikelyNoun(t) ? 3.5 : 0))
    }

    let combined = rrfCombinePerKeywordWeighted(
      bm25Lists.length ? bm25Lists : bm25Wide,
      bm25Lists.length ? weights : [1]
    )

    const ranked = combined

    const frontStmt = db.prepare(
      'SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1'
    )
    const backStmt = db.prepare(
      'SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord DESC LIMIT 1'
    )
    return ranked.map((r) => {
      const front = frontStmt.get(r.note_id) as { value_html?: string } | undefined
      const back = backStmt.get(r.note_id) as { value_html?: string } | undefined
      let where: 'front' | 'back' | 'both' | undefined
      const f = (front?.value_html || '').toLowerCase()
      const b = (back?.value_html || '').toLowerCase()
      const hitFront = terms.some((t) => f.includes(t.toLowerCase()))
      const hitBack = terms.some((t) => b.includes(t.toLowerCase()))
      if (hitFront && hitBack) where = 'both'
      else if (hitFront) where = 'front'
      else if (hitBack) where = 'back'
      return {
        note_id: r.note_id,
        first_field: front?.value_html ?? null,
        bm25: r.bm25,
        trigrams: undefined,
        combined: r.rrf,
        rrf: r.rrf,
        where
      }
    })
  },

  async semanticRerank(query: string, limit = 100): Promise<Array<{ note_id: number; first_field: string | null; bm25?: number; trigrams?: number; combined: number; rrf: number; where?: 'front' | 'back' | 'both'; rerank?: number }>> {
    const q = String(query || '').trim()
    if (!q) return []
    const defaultInstruction = 'Given a search query, retrieve relevant anki cards.'
    const instruction = api.getSetting('deepinfra_instruction') || defaultInstruction
    const apiKey = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN || ''
    const url = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-8B'

    // Collect candidates: Top 100 by BM25 + Top 100 by Embedding, deduped
    const MAX_BM25 = 100
    const MAX_EMB = 100
    const allFuzzy = api.fuzzySearch(q, Math.max(limit, 400))
    // If fuzzy empty, fall back to default list
    const fallbackList = allFuzzy.length === 0 ? api.listNotes(limit, 0) : []
    const withBm = (allFuzzy.length ? allFuzzy : fallbackList).filter((c: any) => typeof c.bm25 === 'number') as any[]
    const bmTop = withBm.sort((a, b) => (a.bm25 as number) - (b.bm25 as number)).slice(0, MAX_BM25)
    let embTop: Array<{ note_id: number; first_field: string | null; rerank: number }> = []
    try {
      const es = await api.embedSearch(q, MAX_EMB)
      if (Array.isArray(es)) embTop = es as any
    } catch {
      // ignore embed errors for candidate gathering
    }

    // Build deduped chosen set
    const chosenIds = new Set<number>()
    bmTop.forEach((c: any) => chosenIds.add(c.note_id))
    embTop.forEach((e: any) => chosenIds.add(e.note_id))
    // Map for quick lookup of fuzzy info (for where/bm25 fields)
    const fuzzyById = new Map<number, any>()
    for (const c of allFuzzy) fuzzyById.set(c.note_id, c)

    // Fetch/clean fronts for chosen
    const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const strip = (html: string): string => html
      .replace(/<br\s*\/?\?\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\[sound:[^\]]+\]/gi, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    const chosen: Array<{ id: number; text: string; first: string | null }> = []
    chosenIds.forEach((id) => {
      const f = fuzzyById.get(id)
      const html = (f?.first_field as string | null) ?? ((frontStmt.get(id) as { value_html?: string } | undefined)?.value_html ?? null)
      const text = strip(String(html || ''))
      if (text) chosen.push({ id, text, first: html })
    })
    if (chosen.length === 0) return allFuzzy

    // Prepare rerank request (cap at 200)
    const MAX_RERANK = 200
    const docs = chosen.slice(0, MAX_RERANK)
    const documents = docs.map((c) => c.text)
    const queries = documents.map(() => q)

    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.warn('DeepInfra API key not set; skipping semantic rerank')
      // Return BM25 order for fuzzy, but ensure chosen appear first in their fuzzy order
      const head = docs.map((d) => {
        const f = fuzzyById.get(d.id)
        return {
          note_id: d.id,
          first_field: d.first,
          bm25: f?.bm25,
          trigrams: f?.trigrams,
          combined: f?.rrf ?? 0,
          rrf: f?.rrf ?? 0,
          where: f?.where,
          rerank: 0
        }
      })
      const tail = allFuzzy.filter((c) => !chosenIds.has(c.note_id))
      const tailSorted = tail.slice().sort((a, b) => {
        const ab = typeof a.bm25 === 'number' ? a.bm25 : Number.POSITIVE_INFINITY
        const bb = typeof b.bm25 === 'number' ? b.bm25 : Number.POSITIVE_INFINITY
        return ab - bb
      })
      return head.concat(tailSorted as any)
    }

    try {
      // eslint-disable-next-line no-console
      console.log('semanticRerank: calling DeepInfra with', documents.length, 'docs (BM25 100 + Emb 100 deduped)')
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ queries, documents, instruction })
      })
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error('Rerank API error', res.status, await res.text())
        return allFuzzy
      }
      const json = (await res.json()) as { scores: number[] }
      const scores = Array.isArray(json?.scores) ? json.scores : []
      const headScored = docs.map((d, i) => {
        const f = fuzzyById.get(d.id)
        const r = Number.isFinite(scores[i]) ? (scores[i] as number) : -Infinity
        return {
          note_id: d.id,
          first_field: d.first,
          bm25: f?.bm25,
          trigrams: f?.trigrams,
          combined: f?.rrf ?? 0,
          rrf: f?.rrf ?? 0,
          where: f?.where,
          rerank: r
        }
      })
      const headSorted = headScored.sort((a, b) => (b.rerank ?? -Infinity) - (a.rerank ?? -Infinity))
      const tail = allFuzzy.filter((c) => !docs.some((d) => d.id === c.note_id))
      const tailSorted = tail.slice().sort((a, b) => {
        const ab = typeof a.bm25 === 'number' ? a.bm25 : Number.POSITIVE_INFINITY
        const bb = typeof b.bm25 === 'number' ? b.bm25 : Number.POSITIVE_INFINITY
        return ab - bb
      })
      return headSorted.concat(tailSorted as any)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Rerank fetch failed', e)
      return allFuzzy
    }
  },

  

  // Conservative rerank: at most top 5 BM25 + top 5 Embedding; return only those
  async semanticRerankSmall(query: string): Promise<Array<{ note_id: number; first_field: string | null; rerank?: number }>> {
    const q = String(query || '').trim()
    if (!q) return []
    const BM25_TOP = 5
    const EMBED_TOP = 5
    // Get fuzzy (for BM25) and embed candidates
    let fuzzy = api.fuzzySearch(q, 200)
    const withBm = fuzzy.filter((c: any) => typeof c.bm25 === 'number') as any[]
    const bmTop = withBm.sort((a, b) => (a.bm25 as number) - (b.bm25 as number)).slice(0, BM25_TOP)
    let embedTop: Array<{ note_id: number; first_field: string | null; rerank: number }> = []
    try {
      const es = await api.embedSearch(q, EMBED_TOP)
      if (Array.isArray(es)) embedTop = es as any
    } catch {
      // ignore
    }
    // Merge ids
    const chosenIds = new Set<number>()
    bmTop.forEach((c: any) => chosenIds.add(c.note_id))
    embedTop.forEach((e: any) => chosenIds.add(e.note_id))
    if (chosenIds.size === 0) return []
    // Fetch/clean fronts
    const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const strip = (html: string): string => html
      .replace(/<br\s*\/??\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\[sound:[^\]]+\]/gi, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    const chosen: Array<{ id: number; text: string; first: string | null }> = []
    chosenIds.forEach((id) => {
      const inF = fuzzy.find((c: any) => c.note_id === id)
      const html = (inF?.first_field as string | null) ?? ((frontStmt.get(id) as { value_html?: string } | undefined)?.value_html ?? null)
      const text = strip(String(html || ''))
      if (text) chosen.push({ id, text, first: html })
    })
    if (chosen.length === 0) return []
    // Rerank only these
    const documents = chosen.map((c) => c.text)
    const queries = documents.map(() => q)
    const instruction = api.getSetting('deepinfra_instruction') || 'Given a search query, retrieve relevant anki cards.'
    const apiKey = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN || ''
    const url = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-8B'
    try {
      if (!apiKey) return chosen.map((c) => ({ note_id: c.id, first_field: c.first, rerank: 0 }))
      const headersSmall: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headersSmall.Authorization = `Bearer ${apiKey}`
      const res = await fetch(url, {
        method: 'POST',
        headers: headersSmall,
        body: JSON.stringify({ queries, documents, instruction })
      })
      if (!res.ok) return chosen.map((c) => ({ note_id: c.id, first_field: c.first, rerank: 0 }))
      const json = (await res.json()) as { scores: number[] }
      const scores = Array.isArray(json?.scores) ? json.scores : []
      const out = chosen.map((c, i) => ({ note_id: c.id, first_field: c.first, rerank: Number(scores[i] || 0) }))
      return out.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0))
    } catch {
      return chosen.map((c) => ({ note_id: c.id, first_field: c.first, rerank: 0 }))
    }
  },

  getNoteDetails(noteId: number): {
    note: { note_id: number; model_name: string; mod: number | null }
    fields: Array<{ field_name: string; value_html: string; ord: number | null }>
    tags: string[]
  } | null {
    const note = getDb()
      .prepare('SELECT note_id, model_name, mod FROM notes WHERE note_id = ?')
      .get(noteId)
    if (!note) return null
    const fields = getDb()
      .prepare(
        'SELECT field_name, value_html, ord FROM note_fields WHERE note_id = ? ORDER BY ord ASC, field_name ASC'
      )
      .all(noteId)
    const tags = getDb()
      .prepare('SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag ASC')
      .all(noteId)
      .map((r: { tag: string }) => r.tag)
    return { note, fields, tags }
  },

  searchNotes(
    query: string,
    limit = 200,
    offset = 0
  ): Array<{ note_id: number; first_field: string | null }> {
    const raw = String(query || '').trim()
    if (raw.length === 0) {
      return api.listNotes(limit, offset)
    }

    // Tokenize into space-separated terms, honoring quoted phrases
    const tokens: string[] = []
    const re = /"([^"]+)"|(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      const phrase = (m[1] || m[2] || '').toLowerCase()
      if (phrase) tokens.push(phrase)
    }

    if (tokens.length === 0) {
      return api.listNotes(limit, offset)
    }

    // Build WHERE as AND of EXISTS clauses (boolean AND exact substring match case-insensitive)
    const where = tokens
      .map(
        () =>
          `EXISTS (
             SELECT 1 FROM note_fields nf
              WHERE nf.note_id = n.note_id
                AND instr(lower(nf.value_html), ?) > 0
           )`
      )
      .join(' AND ')

    const sql = `
      SELECT n.note_id,
             (SELECT nf2.value_html FROM note_fields nf2 WHERE nf2.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
        FROM notes n
       WHERE ${where}
       ORDER BY n.note_id DESC
       LIMIT ? OFFSET ?`

    const stmt = getDb().prepare(sql)
    const params = [...tokens, limit, offset]
    return stmt.all(...params)
  },

  runIngest(query: string = '*'): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.resolve(process.cwd(), 'database/anki_ingest.mjs')
      const child = spawn(process.execPath, [scriptPath, query], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })

      let output = ''
      child.stdout.on('data', (d) => {
        output += d.toString()
      })
      child.stderr.on('data', (d) => {
        output += d.toString()
      })
      child.on('error', (err) => reject(err))
      child.on('close', (code) => resolve({ code: code ?? -1, output }))
    })
  },
  async pingAnkiConnect(): Promise<{ ok: boolean; version?: number; error?: string }> {
    try {
      const res = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'version', version: 6 })
      })
      const json = (await res.json()) as { result?: number; error?: string }
      if (json?.result && !json.error) return { ok: true, version: json.result }
      return { ok: false, error: json?.error || 'Unknown response' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
  ,
  startEmbedding(rebuild?: boolean): Promise<{ pid: number }> {
    return new Promise((resolve, reject) => {
      try {
        const scriptPath = path.resolve(process.cwd(), 'database/embed_index.mjs')
        const key = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
        const dims = api.getSetting('deepinfra_embed_dims') || '8192'
        const model = api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
        const service = api.getSetting('deepinfra_embed_tier') || 'default'
        const child = spawnChild(process.execPath, [scriptPath], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            DEEPINFRA_API_KEY: key,
            EMBED_MODEL: model,
            EMBED_DIMS: String(dims),
            EMBED_SERVICE_TIER: service,
            CONCURRENCY: '200',
            BATCH_SIZE: '8',
            REBUILD_ALL: rebuild ? '1' : '0'
          }
        })
        child.stdout?.on('data', (d) => {
          // Could forward to renderer via events in future
          // eslint-disable-next-line no-console
          console.log(String(d))
        })
        child.stderr?.on('data', (d) => {
          // eslint-disable-next-line no-console
          console.error(String(d))
        })
        ;(globalThis as any).__embedChild = child
        resolve({ pid: child.pid ?? -1 })
      } catch (e) {
        reject(e)
      }
    })
  },
  stopEmbedding(): Promise<{ ok: boolean }> {
    return new Promise((resolve) => {
      try {
        const child = (globalThis as any).__embedChild
        if (child && typeof child.kill === 'function') child.kill('SIGINT')
      } catch {
        // ignore
      } finally {
        resolve({ ok: true })
      }
    })
  },
  getEmbeddingProgress(): {
    total: number
    embedded: number
    pending: number
    errors: number
    rate: number
    etaSeconds: number
  } {
    const embPath = path.resolve(process.cwd(), 'database/embeddings.db')
    const dbEmb = new Database(embPath)
    const total = (getDb().prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }).c || 0
    const embedded = (dbEmb.prepare('SELECT COUNT(1) AS c FROM embeddings').get() as { c: number }).c || 0
    const pending = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs WHERE status='pending'").get() as { c: number }).c || 0
    const errors = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs WHERE status='error'").get() as { c: number }).c || 0
    let rate = 0
    try {
      const row = dbEmb.prepare("SELECT value FROM settings WHERE key='embed_progress'").get() as { value?: string }
      if (row?.value) {
        const obj = JSON.parse(row.value)
        rate = Number(obj?.rate || 0)
      }
    } catch {
      // ignore
    }
    const remaining = Math.max(0, total - embedded)
    const etaSeconds = rate > 0 ? Math.round(remaining / rate) : 0
    return { total, embedded, pending, errors, rate, etaSeconds }
  },
  async readFileBinary(filePath: string): Promise<ArrayBuffer> {
    try {
      const p = filePath.startsWith('file://') ? filePath.replace('file://', '') : filePath
      const buf = fs.readFileSync(p)
      // Return a standalone ArrayBuffer copy to survive structured cloning across contexts
      const ab = new ArrayBuffer(buf.length)
      const view = new Uint8Array(ab)
      view.set(buf)
      return ab
    } catch (e) {
      throw e
    }
  },
  async embedSearch(query: string, topK = 200): Promise<Array<{ note_id: number; first_field: string | null; rerank: number }>> {
    // Sentence-wise embedding search with RRF fusion over notes
    const key = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
    if (!key) return []
    const raw = String(query || '').trim()
    if (!raw) return []
    const model = api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
    const dims = Number(api.getSetting('deepinfra_embed_dims') || '8192')
    // Split into sentences, then group into chunks of up to 3 sentences each
    const sentences = raw
      .split(/(?<=[\.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const inputs: string[] = []
    if (sentences.length === 0) {
      inputs.push(raw)
    } else {
      const CHUNK_SIZE = 3
      for (let i = 0; i < sentences.length; i += CHUNK_SIZE) {
        inputs.push(sentences.slice(i, i + CHUNK_SIZE).join(' '))
      }
    }
    // Batch embed all sentences in one call
    const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, input: inputs, encoding_format: 'float', dimensions: dims })
    })
    if (!res.ok) return []
    const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    const embList = Array.isArray(j?.data) ? j!.data!.map((d) => d.embedding) : []
    if (embList.length === 0) return []

    const embPath = path.resolve(process.cwd(), 'database/embeddings.db')
    const dbEmb = new Database(embPath)
    const rows = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings').all() as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>

    // Preload note fronts for output shaping
    const firstFieldStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')

    // Compute cosine for each sentence independently, then fuse via RRF across sentences per note
    const K = 60
    const perNoteBestCos = new Map<number, number>()
    const perNoteRrf = new Map<number, number>()

    for (const emb of embList) {
      if (!Array.isArray(emb)) continue
      const q = new Float32Array(emb)
      let qnorm = 0
      for (let i = 0; i < q.length; i++) qnorm += q[i] * q[i]
      qnorm = Math.sqrt(qnorm) || 1
      const scores: Array<{ id: number; s: number }> = []
      for (const r of rows) {
        if (!r.vec || r.dim !== q.length) continue
        const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        let dot = 0
        for (let i = 0; i < q.length; i++) dot += q[i] * vec[i]
        const cos = dot / (qnorm * (r.norm || 1))
        scores.push({ id: r.note_id, s: cos })
      }
      scores.sort((a, b) => b.s - a.s)
      // Track best cosine per note and add RRF contribution by this sentence's ranking
      for (let rank = 0; rank < scores.length; rank++) {
        const { id, s } = scores[rank]
        if (!perNoteBestCos.has(id) || s > (perNoteBestCos.get(id) as number)) perNoteBestCos.set(id, s)
        const prev = perNoteRrf.get(id) || 0
        perNoteRrf.set(id, prev + 1 / (K + (rank + 1)))
      }
    }

    // Produce final topK sorted by best cosine desc (tie-break by RRF), include cos for display
    const final = Array.from(perNoteRrf.entries())
      .map(([id, rrf]) => ({ id, rrf, cos: perNoteBestCos.get(id) || 0 }))
      .sort((a, b) => (b.cos - a.cos) || (b.rrf - a.rrf))
      .slice(0, Math.max(1, Math.min(100, topK)))

    return final.map(({ id, cos }) => {
      const row = firstFieldStmt.get(id) as { value_html?: string } | undefined
      return { note_id: id, first_field: row?.value_html ?? null, rerank: cos }
    })
  }
  ,
  async unsuspendNotes(noteIds: number[]): Promise<{ ok: boolean; changed: number; error?: string }> {
    try {
      if (!Array.isArray(noteIds) || noteIds.length === 0) return { ok: true, changed: 0 }
      // Use findCards with query: "nid:<id> or nid:<id> ..."
      const q = noteIds.map((id) => `nid:${id}`).join(' or ')
      const resFind = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'findCards', version: 6, params: { query: q } })
      })
      const jsonFind = (await resFind.json()) as { result?: number[]; error?: string }
      if (!jsonFind || jsonFind.error) return { ok: false, changed: 0, error: jsonFind?.error || 'findCards failed' }
      const cardIds = jsonFind.result || []
      if (cardIds.length === 0) return { ok: true, changed: 0 }

      // Determine how many are currently suspended (optional accuracy for "changed")
      const resBefore = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'areSuspended', version: 6, params: { cards: cardIds } })
      })
      const jsonBefore = (await resBefore.json()) as { result?: boolean[]; error?: string }
      if (jsonBefore?.error) return { ok: false, changed: 0, error: jsonBefore.error }
      const before = Array.isArray(jsonBefore?.result) ? jsonBefore.result : []

      // Use canonical unsuspend action per AnkiConnect docs
      const resUnsuspend = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unsuspend', version: 6, params: { cards: cardIds } })
      })
      const jsonUnsuspend = (await resUnsuspend.json()) as { result?: boolean; error?: string }
      if (jsonUnsuspend?.error) return { ok: false, changed: 0, error: jsonUnsuspend.error }

      // Verify post-state to count changes
      const resAfter = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'areSuspended', version: 6, params: { cards: cardIds } })
      })
      const jsonAfter = (await resAfter.json()) as { result?: boolean[]; error?: string }
      if (jsonAfter?.error) return { ok: false, changed: 0, error: jsonAfter.error }
      const after = Array.isArray(jsonAfter?.result) ? jsonAfter.result : []

      let changed = 0
      for (let i = 0; i < Math.min(before.length, after.length); i++) {
        if (before[i] === true && after[i] === false) changed++
      }
      return { ok: true, changed }
    } catch (e) {
      return { ok: false, changed: 0, error: (e as Error).message }
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
