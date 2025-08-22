// Embedding indexer: builds and maintains embeddings.db from anki_cache.db
// Usage: node database/embed_index.mjs
// Env:
//   DEEPINFRA_API_KEY
//   EMBED_MODEL=Qwen/Qwen3-Embedding-8B
//   EMBED_DIMS=8192
//   EMBED_SERVICE_TIER=default|priority
//   CONCURRENCY=200
//   BATCH_SIZE=8
//   REBUILD_ALL=0|1

import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const apiKey = process.env.DEEPINFRA_API_KEY || ''
if (!apiKey) {
  console.error('Missing DEEPINFRA_API_KEY')
  process.exit(1)
}

const model = process.env.EMBED_MODEL || 'Qwen/Qwen3-Embedding-8B'
const dims = Number(process.env.EMBED_DIMS || 8192)
const serviceTier = process.env.EMBED_SERVICE_TIER || 'default'
const CONCURRENCY = Math.max(1, Math.min(200, Number(process.env.CONCURRENCY || 200)))
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

function setSetting(key, value) {
  embedDb.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
}

function now() { return Math.floor(Date.now() / 1000) }

// Reset stuck jobs
embedDb.prepare(`UPDATE embed_jobs SET status='pending', started_at=NULL WHERE status='in_progress'`).run()

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
    // Enqueue all notes
    const rows = cacheDb.prepare(`
      SELECT n.note_id, n.content_hash AS hash,
             (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front
      FROM notes n
    `).all()
    const ins = embedDb.prepare(`INSERT INTO embed_jobs(note_id, hash, status, enqueued_at) VALUES(?,?, 'pending', ?) ON CONFLICT(note_id) DO UPDATE SET hash=excluded.hash, status='pending', enqueued_at=excluded.enqueued_at`)
    const tx = embedDb.transaction((items) => { for (const r of items) ins.run(r.note_id, r.hash || '', t) })
    tx(rows)
    return rows.length
  }
  // Non-rebuild: only enqueue notes missing in embeddings.db or with stale hash
  const embRows = embedDb.prepare(`SELECT note_id, hash FROM embeddings`).all()
  const embById = new Map(embRows.map((r) => [r.note_id, r.hash]))
  const allCache = cacheDb.prepare(`
    SELECT n.note_id, n.content_hash AS hash,
           (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front
    FROM notes n
  `).all()
  const toEnqueue = allCache.filter((r) => {
    const h = embById.get(r.note_id)
    return !h || h !== (r.hash || '')
  })
  const ins = embedDb.prepare(`INSERT INTO embed_jobs(note_id, hash, status, enqueued_at) VALUES(?,?, 'pending', ?) ON CONFLICT(note_id) DO UPDATE SET hash=excluded.hash, status='pending', enqueued_at=excluded.enqueued_at`)
  const tx = embedDb.transaction((items) => { for (const r of items) ins.run(r.note_id, r.hash || '', t) })
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
  // fetch fronts for these from cacheDb
  const qMarks = rows.map(() => '?').join(',')
  const fronts = cacheDb.prepare(`
    SELECT n.note_id,
           (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS front,
           n.content_hash AS hash
    FROM notes n WHERE n.note_id IN (${qMarks})
  `).all(...rows.map(r => r.note_id))
  const byId = new Map(fronts.map(f => [f.note_id, f]))
  return rows.map(r => ({ note_id: r.note_id, hash: r.hash, text: normalizeHtml(byId.get(r.note_id)?.front || '') }))
}

async function embedBatch(items) {
  const inputs = items.map(i => i.text)
  const body = {
    model,
    input: inputs,
    encoding_format: 'float',
    dimensions: dims
  }
  const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Embeddings API ${res.status}: ${txt}`)
  }
  const json = await res.json()
  const data = json?.data || []
  if (!Array.isArray(data) || data.length !== items.length) throw new Error('Embeddings length mismatch')
  const nowSec = now()
  const upsert = embedDb.prepare(`INSERT INTO embeddings(note_id, dim, vec, norm, hash, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, norm=excluded.norm, hash=excluded.hash, updated_at=excluded.updated_at`)
  const done = embedDb.prepare(`UPDATE embed_jobs SET status='done', finished_at=? WHERE note_id=?`)
  const toF32 = (arr) => {
    const f = new Float32Array(arr)
    return Buffer.from(f.buffer)
  }
  const l2 = (arr) => Math.sqrt(arr.reduce((s, x) => s + x * x, 0))
  const tx = embedDb.transaction((pairs) => {
    for (let i = 0; i < pairs.length; i++) {
      const { id, emb, hash } = pairs[i]
      const norm = l2(emb)
      upsert.run(id, dims, toF32(emb), norm, hash, nowSec)
      done.run(nowSec, id)
    }
  })
  const pairs = items.map((it, i) => ({ id: it.note_id, emb: data[i]?.embedding || [], hash: it.hash }))
  tx(pairs)
}

async function main() {
  const enq = enqueue(REBUILD_ALL)
  console.log(`Enqueued ${enq} embedding jobs`)
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
        setSetting('embed_progress', JSON.stringify({ processed, elapsed, rate }))
        console.log(JSON.stringify({ type: 'progress', processed, elapsed, rate }))
      } catch (e) {
        // push back to pending and record error
        const t = now()
        const pend = embedDb.prepare(`UPDATE embed_jobs SET status='pending', attempts=attempts+1, last_error=?, started_at=NULL WHERE note_id=?`)
        if (Array.isArray(batchItems)) {
          const tx = embedDb.transaction(() => {
            for (const it of batchItems) pend.run(String(e), it.note_id)
          })
          tx()
        }
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker())
  await Promise.all(workers)
  console.log('Embedding indexing complete')
}

main().catch((e) => {
  console.error('embed_index failed', e)
  process.exit(1)
})


