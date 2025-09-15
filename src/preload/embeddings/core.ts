import Database from 'better-sqlite3'
import path from 'node:path'
import { getDb } from '../db/core'

let dbEmbGlobal: Database.Database | null = null

export function getEmbDb(): Database.Database {
  if (!dbEmbGlobal) {
    const embPathGlobal = path.resolve(process.cwd(), 'database/embeddings.db')
    dbEmbGlobal = new Database(embPathGlobal)
    try {
      dbEmbGlobal.pragma('journal_mode = WAL')
      dbEmbGlobal.pragma('synchronous = NORMAL')
      dbEmbGlobal.pragma('temp_store = MEMORY')
      dbEmbGlobal.pragma('cache_size = -262144')
      dbEmbGlobal.pragma('mmap_size = 268435456')
    } catch {}
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

export function migrateEmbeddingsTo4096(): { ok: boolean; changed: number } {
  try {
    const dbEmb = getEmbDb()
    const rows = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings WHERE dim > 4096').all() as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
    const upd = dbEmb.prepare('UPDATE embeddings SET dim = 4096, vec = ?, norm = ? WHERE note_id = ?')
    let changed = 0
    const txn = dbEmb.transaction(() => {
      for (const r of rows) {
        if (!r.vec || r.dim <= 4096) continue
        const full = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        const sliced = full.slice(0, 4096)
        let norm = 0
        for (let i = 0; i < sliced.length; i++) norm += sliced[i] * sliced[i]
        norm = Math.sqrt(norm) || 1
        upd.run(Buffer.from(sliced.buffer), norm, r.note_id)
        changed++
      }
    })
    txn()
    return { ok: true, changed }
  } catch { return { ok: false, changed: 0 } }
}

export function getEmbeddingProgress(): {
  total: number
  embedded: number
  pending: number
  errors: number
  rate: number
  etaSeconds: number
} {
  const dbEmb = getEmbDb()
  const total = (getDb().prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }).c || 0
  const embedded = (dbEmb.prepare('SELECT COUNT(1) AS c FROM embeddings').get() as { c: number }).c || 0
  const pending = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs WHERE status='pending'").get() as { c: number }).c || 0
  const errors = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs WHERE status='error'").get() as { c: number }).c || 0
  let rate = 0
  try {
    const row = dbEmb.prepare("SELECT value FROM settings WHERE key='embed_progress'").get() as { value?: string }
    if (row?.value) { const obj = JSON.parse(row.value); rate = Number(obj?.rate || 0) }
  } catch {}
  const remaining = Math.max(0, total - embedded)
  const etaSeconds = rate > 0 ? Math.round(remaining / rate) : 0
  return { total, embedded, pending, errors, rate, etaSeconds }
}


