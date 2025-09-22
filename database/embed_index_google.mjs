// Google Gemini Embedding indexer
// Env:
//   GOOGLE_API_KEY
//   GOOGLE_EMBED_MODEL=gemini-embedding-001
//   GOOGLE_EMBED_DIMS=3072 (informational only)
//   CONCURRENCY=100 (RPM limit)
//   BATCH_SIZE=8 (tune per payload size)
//   REBUILD_ALL=0|1

import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const apiKey = process.env.GOOGLE_API_KEY || ''
if (!apiKey) { console.error('Missing GOOGLE_API_KEY'); process.exit(1) }
const model = process.env.GOOGLE_EMBED_MODEL || 'gemini-embedding-001'
const CONCURRENCY = Math.max(1, Math.min(3000, Number(process.env.CONCURRENCY || 600)))
const BATCH_SIZE = Math.max(1, Math.min(32, Number(process.env.BATCH_SIZE || 8)))
const MAX_RPM = Math.max(1, Number(process.env.GOOGLE_MAX_RPM || 3000))
const MAX_TPM = Math.max(1, Number(process.env.GOOGLE_MAX_TPM || 1000000))
const REBUILD_ALL = process.env.REBUILD_ALL === '1'

const cacheDb = new Database(path.resolve(__dirname, 'anki_cache.db'))
const embedDb = new Database(path.resolve(__dirname, 'embeddings.db'))
embedDb.pragma('journal_mode = WAL')
embedDb.exec(`
CREATE TABLE IF NOT EXISTS embeddings2 (
  note_id INTEGER NOT NULL,
  backend TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  norm REAL NOT NULL,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, backend, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings2_dim ON embeddings2(dim);
CREATE INDEX IF NOT EXISTS idx_embeddings2_backend_model ON embeddings2(backend, model);
CREATE TABLE IF NOT EXISTS embed_jobs2 (
  note_id INTEGER NOT NULL,
  backend TEXT NOT NULL,
  model TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (note_id, backend, model)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)

function now() { return Math.floor(Date.now() / 1000) }
function setSetting(key, value) { embedDb.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)) }

function normalizeHtml(html) {
  if (!html) return ''
  const noImgs = html.replace(/<img[^>]*>/gi, ' ')
  const brSp = noImgs.replace(/<br\s*\/?\s*>/gi, ' ')
  const noTags = brSp.replace(/<[^>]*>/g, ' ')
  const noAudio = noTags.replace(/\[sound:[^\]]+\]/gi, ' ')
  return noAudio
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function enqueue(rebuild) {
  const t = now()
  if (rebuild) {
    const rows = cacheDb.prepare(`
      SELECT n.note_id,
             (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front
      FROM notes n
    `).all()
    const ins = embedDb.prepare(`INSERT INTO embed_jobs2(note_id, backend, model, hash, status, enqueued_at) VALUES(?, 'google', ?, ?, 'pending', ?) ON CONFLICT(note_id, backend, model) DO UPDATE SET hash=excluded.hash, status='pending', enqueued_at=excluded.enqueued_at`)
    const tx = embedDb.transaction((items) => {
      for (const r of items) {
        const text = normalizeHtml(r.front || '')
        const fh = text ? text : ''
        ins.run(r.note_id, model, fh, t)
      }
    })
    tx(rows)
    return rows.length
  }
  const embRows = embedDb.prepare(`SELECT note_id, hash FROM embeddings2 WHERE backend='google' AND model=?`).all(model)
  const embById = new Map(embRows.map((r) => [r.note_id, r.hash]))
  const allCache = cacheDb.prepare(`
    SELECT n.note_id,
           (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front
    FROM notes n
  `).all()
  const toEnqueue = []
  for (const r of allCache) {
    const text = normalizeHtml(r.front || '')
    const fh = text ? text : ''
    const prev = embById.get(r.note_id) || null
    if (!prev || prev !== fh) toEnqueue.push({ note_id: r.note_id, hash: fh })
  }
  const ins = embedDb.prepare(`INSERT INTO embed_jobs2(note_id, backend, model, hash, status, enqueued_at) VALUES(?, 'google', ?, ?, 'pending', ?) ON CONFLICT(note_id, backend, model) DO UPDATE SET hash=excluded.hash, status='pending', enqueued_at=excluded.enqueued_at`)
  const tx = embedDb.transaction((items) => { for (const r of items) ins.run(r.note_id, model, r.hash, t) })
  tx(toEnqueue)
  return toEnqueue.length
}

function pickBatch(limit) {
  const rows = embedDb.prepare(`SELECT note_id, hash FROM embed_jobs2 WHERE backend='google' AND model=? AND status='pending' ORDER BY enqueued_at ASC LIMIT ?`).all(model, limit)
  if (!rows.length) return []
  const t = now()
  const upd = embedDb.prepare(`UPDATE embed_jobs2 SET status='in_progress', started_at=? WHERE note_id=? AND backend='google' AND model=?`)
  const tx = embedDb.transaction((items) => { for (const r of items) upd.run(t, r.note_id, model) })
  tx(rows)
  const qMarks = rows.map(() => '?').join(',')
  const fronts = cacheDb.prepare(`
    SELECT n.note_id,
           (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front
    FROM notes n WHERE n.note_id IN (${qMarks})
  `).all(...rows.map(r => r.note_id))
  const byId = new Map(fronts.map(f => [f.note_id, f]))
  return rows.map(r => ({ note_id: r.note_id, hash: r.hash, text: normalizeHtml(byId.get(r.note_id)?.front || '') }))
}

async function embedBatch(items, rateGate) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`
  const toF32 = (arr) => Buffer.from(new Float32Array(arr).buffer)
  const l2 = (arr) => Math.sqrt(arr.reduce((s, x) => s + x * x, 0))
  const upsert = embedDb.prepare(`INSERT INTO embeddings2(note_id, backend, model, dim, vec, norm, hash, updated_at) VALUES(?, 'google', ?, ?, ?, ?, ?, ?) ON CONFLICT(note_id, backend, model) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, norm=excluded.norm, hash=excluded.hash, updated_at=excluded.updated_at`)
  const done = embedDb.prepare(`UPDATE embed_jobs2 SET status='done', finished_at=? WHERE note_id=? AND backend='google' AND model=?`)
  const nowSec = now()
  let upserted = 0
  for (const it of items) {
    // Per-item request with correct body shape
    const body = { content: { parts: [{ text: it.text }] } }
    console.log(JSON.stringify({ type: 'google_embed_request', count: 1 }))
    // rate gate per request to respect global RPM 100
    const estTokens = Math.max(1, Math.floor(String(it.text || '').length / 4))
    await rateGate(estTokens)
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`Google Embeddings API ${res.status}: ${txt}`)
    }
    const json = await res.json()
    const emb = (json?.embedding?.values || json?.embedding || [])
    console.log(JSON.stringify({ type: 'google_embed_response', items: Array.isArray(emb) ? 1 : 0 }))
    const arr = Array.isArray(emb) ? emb : []
    const dim = arr.length
    const norm = l2(arr)
    upsert.run(it.note_id, model, dim, toF32(arr), norm, it.hash, nowSec)
    done.run(nowSec, it.note_id, model)
    upserted++
  }
  console.log(JSON.stringify({ type: 'google_embed_upserted', count: upserted }))
}

async function main() {
  const enq = enqueue(REBUILD_ALL)
  console.log(`Enqueued ${enq} embedding jobs (Google) model=${model}`)
  let processed = 0
  const started = Date.now()
  let stop = false
  process.on('SIGINT', () => { stop = true })

  // Global RPM limiter: max 100 requests in any rolling 60s window
  const stamps = [] // request timestamps (ms)
  const tokenStamps = [] // [ms, tokens]
  function prune(nowMs) {
    while (stamps.length && nowMs - stamps[0] > 60000) stamps.shift()
    while (tokenStamps.length && nowMs - tokenStamps[0][0] > 60000) tokenStamps.shift()
  }
  function tokensInWindow() {
    let s = 0; for (const [, t] of tokenStamps) s += t; return s
  }
  async function rateGate(tokenCost) {
    const nowMs = Date.now()
    prune(nowMs)
    const reqs = stamps.length
    const toks = tokensInWindow()
    if (reqs >= MAX_RPM || (toks + tokenCost) > MAX_TPM) {
      const headMs = Math.min(stamps[0] || nowMs, tokenStamps[0]?.[0] || nowMs)
      const waitMs = 60000 - (nowMs - headMs) + 5
      console.log(JSON.stringify({ type: 'google_rate_wait', waitMs, reqs, toks }))
      await new Promise(r => setTimeout(r, Math.max(5, waitMs)))
      return rateGate(tokenCost)
    }
    const ts = Date.now()
    stamps.push(ts)
    tokenStamps.push([ts, tokenCost])
  }
  async function worker() {
    while (!stop) {
      const batchItems = pickBatch(BATCH_SIZE)
      if (batchItems.length === 0) return
      try {
        await embedBatch(batchItems, rateGate)
        processed += batchItems.length
        const elapsed = (Date.now() - started) / 1000
        const rate = processed / Math.max(1, elapsed)
        setSetting('embed_progress_google', JSON.stringify({ processed, elapsed, rate }))
        console.log(JSON.stringify({ type: 'progress', processed, elapsed, rate }))
      } catch (e) {
        const t = now()
        const pend = embedDb.prepare(`UPDATE embed_jobs2 SET status='pending', attempts=attempts+1, last_error=?, started_at=NULL WHERE backend='google' AND model=? AND note_id=?`)
        if (Array.isArray(batchItems)) {
          const tx = embedDb.transaction(() => { for (const it of batchItems) pend.run(String(e), model, it.note_id) })
          tx()
        }
        console.error(JSON.stringify({ type: 'google_embed_error', message: String(e) }))
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }
  const workers = Array.from({ length: CONCURRENCY }, () => worker())
  await Promise.all(workers)
  console.log('Google embedding indexing complete')
}

main().catch((e) => { console.error('embed_index_google failed', e); process.exit(1) })


