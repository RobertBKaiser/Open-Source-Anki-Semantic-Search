// Local Embedding indexer using Transformers.js EmbeddingGemma
// Env:
//   GEMMA_MODEL_ID=onnx-community/embeddinggemma-300m-ONNX
//   GEMMA_DTYPE=q4|q8|fp32
//   CONCURRENCY=64
//   BATCH_SIZE=8
//   REBUILD_ALL=0|1

import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const modelId = process.env.GEMMA_MODEL_ID || 'onnx-community/embeddinggemma-300m-ONNX'
const dtype = process.env.GEMMA_DTYPE || 'q4'
const CONCURRENCY = Math.max(1, Math.min(128, Number(process.env.CONCURRENCY || 64)))
const BATCH_SIZE = Math.max(1, Math.min(16, Number(process.env.BATCH_SIZE || 8)))
const REBUILD_ALL = process.env.REBUILD_ALL === '1'

const cacheDb = new Database(path.resolve(__dirname, 'anki_cache.db'))
const embedDb = new Database(path.resolve(__dirname, 'embeddings.db'))

embedDb.pragma('journal_mode = WAL')
embedDb.exec(`
CREATE TABLE IF NOT EXISTS embeddings (
  note_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  norm REAL NOT NULL,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS embed_jobs (
  note_id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)

function now() { return Math.floor(Date.now() / 1000) }

function setSetting(key, value) {
  embedDb.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
}

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

function modelAwareHash(crypto, text) {
  const t = String(text || '')
  const hFront = crypto.createHash('sha256').update(t).digest('hex')
  return `gemma|${modelId}|${dtype}|${hFront}`
}

function enqueue(rebuild) {
  const t = now()
  if (rebuild) {
    const rows = cacheDb.prepare(`
      SELECT n.note_id,
             (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front
      FROM notes n
    `).all()
    const ins = embedDb.prepare(`INSERT INTO embed_jobs(note_id, hash, status, enqueued_at) VALUES(?,?, 'pending', ?) ON CONFLICT(note_id) DO UPDATE SET hash=excluded.hash, status='pending', enqueued_at=excluded.enqueued_at`)
    const tx = embedDb.transaction((items) => {
      for (const r of items) {
        const text = normalizeHtml(r.front || '')
        const fh = modelAwareHash(crypto, text)
        ins.run(r.note_id, fh, t)
      }
    })
    tx(rows)
    return rows.length
  }
  const embRows = embedDb.prepare(`SELECT note_id, hash FROM embeddings`).all()
  const embById = new Map(embRows.map((r) => [r.note_id, r.hash]))
  const allCache = cacheDb.prepare(`
    SELECT n.note_id,
           (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front
    FROM notes n
  `).all()
  const toEnqueue = []
  for (const r of allCache) {
    const text = normalizeHtml(r.front || '')
    const fh = modelAwareHash(crypto, text)
    const prev = embById.get(r.note_id) || null
    if (!prev || prev !== fh) toEnqueue.push({ note_id: r.note_id, hash: fh })
  }
  const ins = embedDb.prepare(`INSERT INTO embed_jobs(note_id, hash, status, enqueued_at) VALUES(?,?, 'pending', ?) ON CONFLICT(note_id) DO UPDATE SET hash=excluded.hash, status='pending', enqueued_at=excluded.enqueued_at`)
  const tx = embedDb.transaction((items) => { for (const r of items) ins.run(r.note_id, r.hash, t) })
  tx(toEnqueue)
  return toEnqueue.length
}

function pickBatch(limit) {
  const rows = embedDb.prepare(`SELECT note_id, hash FROM embed_jobs WHERE status='pending' ORDER BY enqueued_at ASC LIMIT ?`).all(limit)
  if (!rows.length) return []
  const t = now()
  const upd = embedDb.prepare(`UPDATE embed_jobs SET status='in_progress', started_at=? WHERE note_id=?`)
  const tx = embedDb.transaction((items) => { for (const r of items) upd.run(t, r.note_id) })
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

let __gemma = null
async function ensureModel() {
  if (__gemma) return __gemma
  const transformers = await import('@huggingface/transformers')
  const AutoTokenizer = transformers.AutoTokenizer
  const AutoModel = transformers.AutoModel
  const tokenizer = await AutoTokenizer.from_pretrained(modelId)
  const model = await AutoModel.from_pretrained(modelId, { dtype })
  __gemma = { tokenizer, model }
  return __gemma
}

async function embedBatch(items) {
  const { tokenizer, model } = await ensureModel()
  const prefixes = { document: 'title: none | text: ' }
  const inputs = await tokenizer(items.map((i) => prefixes.document + i.text), { padding: true })
  const out = await model(inputs)
  const emb = out?.sentence_embedding
  if (!emb || typeof emb.tolist !== 'function') throw new Error('Invalid embedding output')
  const mat = emb.tolist()
  const dim = Array.isArray(mat[0]) ? mat[0].length : 0
  if (!Number.isFinite(dim) || dim <= 0) throw new Error('Invalid embedding dimension')
  const nowSec = now()
  const upsert = embedDb.prepare(`INSERT INTO embeddings(note_id, dim, vec, norm, hash, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, norm=excluded.norm, hash=excluded.hash, updated_at=excluded.updated_at`)
  const done = embedDb.prepare(`UPDATE embed_jobs SET status='done', finished_at=? WHERE note_id=?`)
  const toF32Buf = (arr) => Buffer.from(new Float32Array(arr).buffer)
  const l2 = (arr) => Math.sqrt(arr.reduce((s, x) => s + x * x, 0))
  const tx = embedDb.transaction((pairs) => {
    for (let i = 0; i < pairs.length; i++) {
      const { id, emb, hash } = pairs[i]
      const norm = l2(emb)
      upsert.run(id, dim, toF32Buf(emb), norm, hash, nowSec)
      done.run(nowSec, id)
    }
  })
  const pairs = items.map((it, i) => ({ id: it.note_id, emb: mat[i], hash: it.hash }))
  tx(pairs)
}

async function main() {
  const enq = enqueue(REBUILD_ALL)
  console.log(`Enqueued ${enq} embedding jobs (Gemma) model=${modelId} dtype=${dtype}`)
  try { await ensureModel() } catch (e) { console.error('Model load failed', e); process.exit(1) }
  try { setSetting('embed_progress_gemma', JSON.stringify({ processed: 0, elapsed: 0, rate: 0 })) } catch {}
  let processed = 0
  const started = Date.now()
  let stop = false
  process.on('SIGINT', () => { stop = true })
  async function worker() {
    while (!stop) {
      const batchItems = pickBatch(BATCH_SIZE)
      if (batchItems.length === 0) return
      try {
        await embedBatch(batchItems)
        processed += batchItems.length
        const elapsed = (Date.now() - started) / 1000
        const rate = processed / Math.max(1, elapsed)
        setSetting('embed_progress_gemma', JSON.stringify({ processed, elapsed, rate }))
        console.log(JSON.stringify({ type: 'progress', processed, elapsed, rate }))
      } catch (e) {
        console.error('embed_batch_error', e)
        const t = now()
        const pend = embedDb.prepare(`UPDATE embed_jobs SET status='pending', attempts=attempts+1, last_error=?, started_at=NULL WHERE note_id=?`)
        const tx = embedDb.transaction(() => { for (const it of batchItems) pend.run(String(e), it.note_id) })
        tx()
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }
  // Limit concurrent workers; model inference is heavy. Use Math.min to avoid overwhelming CPU.
  const W = Math.max(1, Math.min(4, Math.floor(CONCURRENCY / 16)))
  const workers = Array.from({ length: W }, () => worker())
  await Promise.all(workers)
  console.log('Local embedding indexing complete')
}

main().catch((e) => { console.error('embed_index_local failed', e); process.exit(1) })


