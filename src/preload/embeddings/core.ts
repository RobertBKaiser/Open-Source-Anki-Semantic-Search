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
        
        -- New multi-model tables
        CREATE TABLE IF NOT EXISTS embeddings2 (
          note_id INTEGER NOT NULL,
          backend TEXT NOT NULL,         -- 'deepinfra' | 'gemma'
          model TEXT NOT NULL,           -- e.g. 'Qwen/Qwen3-Embedding-8B' or gemma model id
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

        -- Concept map storage (TopicBERT/BERTopic outputs)
        CREATE TABLE IF NOT EXISTS topic_runs (
          run_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          scope_hash TEXT NOT NULL,
          backend TEXT NOT NULL,
          model TEXT NOT NULL,
          note_count INTEGER NOT NULL,
          params_json TEXT,
          created_at INTEGER NOT NULL,
          query TEXT,
          query_embedding BLOB,
          query_dim INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_topic_runs_scope_model ON topic_runs(scope_hash, backend, model);

        CREATE TABLE IF NOT EXISTS topics (
          run_id TEXT NOT NULL,
          topic_id INTEGER NOT NULL,
          parent_id INTEGER,
          label TEXT NOT NULL,
          level INTEGER NOT NULL,
          size INTEGER NOT NULL,
          score REAL,
          query_cos REAL,
          centroid BLOB,
          centroid_dim INTEGER,
          PRIMARY KEY (run_id, topic_id),
          FOREIGN KEY (run_id) REFERENCES topic_runs(run_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(run_id, parent_id);

        CREATE TABLE IF NOT EXISTS topic_terms (
          run_id TEXT NOT NULL,
          topic_id INTEGER NOT NULL,
          term TEXT NOT NULL,
          score REAL NOT NULL,
          rank INTEGER NOT NULL,
          PRIMARY KEY (run_id, topic_id, term),
          FOREIGN KEY (run_id, topic_id) REFERENCES topics(run_id, topic_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_topic_terms_topic ON topic_terms(run_id, topic_id);

        CREATE TABLE IF NOT EXISTS topic_docs (
          run_id TEXT NOT NULL,
          topic_id INTEGER NOT NULL,
          note_id INTEGER NOT NULL,
          weight REAL,
          cos REAL,
          PRIMARY KEY (run_id, topic_id, note_id),
          FOREIGN KEY (run_id, topic_id) REFERENCES topics(run_id, topic_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_topic_docs_note ON topic_docs(run_id, note_id);
      `)
    } catch {}
    // One-time migration: copy existing single-model rows into embeddings2 under detected backend/model
    try {
      const hasV1 = dbEmbGlobal.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").get() as any
      if (hasV1) {
        // Detect Gemma markers in hash: 'gemma|<model>|<dtype>|…'
        const anyGemma = dbEmbGlobal.prepare("SELECT 1 FROM embeddings WHERE hash LIKE 'gemma|%' LIMIT 1").get() as any
        if (anyGemma) {
          const rows = dbEmbGlobal.prepare('SELECT note_id, dim, vec, norm, hash, updated_at FROM embeddings').all() as Array<{note_id:number; dim:number; vec:Buffer; norm:number; hash:string; updated_at:number}>
          const ins = dbEmbGlobal.prepare('INSERT OR IGNORE INTO embeddings2(note_id, backend, model, dim, vec, norm, hash, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          const tx = dbEmbGlobal.transaction(() => {
            for (const r of rows) {
              let backend = 'gemma'
              let model = 'onnx-community/embeddinggemma-300m-ONNX'
              try {
                if (typeof r.hash === 'string' && r.hash.startsWith('gemma|')) {
                  const parts = r.hash.split('|')
                  if (parts.length >= 3) { model = parts[1] || model }
                } else {
                  backend = 'deepinfra'
                  model = 'Qwen/Qwen3-Embedding-8B'
                }
              } catch {}
              ins.run(r.note_id, backend, model, r.dim, r.vec, r.norm, r.hash, r.updated_at)
            }
          })
          tx()
        } else {
          // Assume DeepInfra/Qwen-only rows
          const rows = dbEmbGlobal.prepare('SELECT note_id, dim, vec, norm, hash, updated_at FROM embeddings').all() as Array<{note_id:number; dim:number; vec:Buffer; norm:number; hash:string; updated_at:number}>
          const ins = dbEmbGlobal.prepare('INSERT OR IGNORE INTO embeddings2(note_id, backend, model, dim, vec, norm, hash, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          const tx = dbEmbGlobal.transaction(() => {
            for (const r of rows) ins.run(r.note_id, 'deepinfra', 'Qwen/Qwen3-Embedding-8B', r.dim, r.vec, r.norm, r.hash, r.updated_at)
          })
          tx()
        }
      }
    } catch {}
  }
  return dbEmbGlobal
}

export function migrateEmbeddingsTo4096(): { ok: boolean; changed: number } {
  try {
    const dbEmb = getEmbDb()
    const rows = dbEmb.prepare("SELECT note_id, dim, vec, norm FROM embeddings2 WHERE backend='deepinfra' AND model='Qwen/Qwen3-Embedding-8B' AND dim > 4096").all() as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
    const upd = dbEmb.prepare("UPDATE embeddings2 SET dim = 4096, vec = ?, norm = ? WHERE note_id = ? AND backend='deepinfra' AND model='Qwen/Qwen3-Embedding-8B'")
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
  const backend = (getDb().prepare("SELECT value FROM app_settings WHERE key='embedding_backend'").get() as { value?: string } | undefined)?.value || 'deepinfra'
  const total = (getDb().prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }).c || 0
  let embedded = 0
  try {
    if (backend === 'gemma') {
      const modelIdRow = getDb().prepare("SELECT value FROM app_settings WHERE key='gemma_model_id'").get() as { value?: string } | undefined
      const modelId = (modelIdRow?.value || 'onnx-community/embeddinggemma-300m-ONNX')
      embedded = (dbEmb.prepare('SELECT COUNT(1) AS c FROM embeddings2 WHERE backend = ? AND model = ?').get('gemma', modelId) as { c: number }).c || 0
    } else if (backend === 'google') {
      const modelRow = getDb().prepare("SELECT value FROM app_settings WHERE key='google_embed_model'").get() as { value?: string } | undefined
      const model = (modelRow?.value || 'gemini-embedding-001')
      embedded = (dbEmb.prepare('SELECT COUNT(1) AS c FROM embeddings2 WHERE backend = ? AND model = ?').get('google', model) as { c: number }).c || 0
    } else {
      const modelRow = getDb().prepare("SELECT value FROM app_settings WHERE key='deepinfra_embed_model'").get() as { value?: string } | undefined
      const model = (modelRow?.value || 'Qwen/Qwen3-Embedding-8B')
      embedded = (dbEmb.prepare('SELECT COUNT(1) AS c FROM embeddings2 WHERE backend = ? AND model = ?').get('deepinfra', model) as { c: number }).c || 0
    }
  } catch {}
  let pending = 0
  let errors = 0
  try {
    if (backend === 'gemma') {
      const modelIdRow = getDb().prepare("SELECT value FROM app_settings WHERE key='gemma_model_id'").get() as { value?: string } | undefined
      const modelId = (modelIdRow?.value || 'onnx-community/embeddinggemma-300m-ONNX')
      pending = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='pending'").get('gemma', modelId) as { c: number }).c || 0
      errors = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='error'").get('gemma', modelId) as { c: number }).c || 0
    } else if (backend === 'google') {
      const modelRow = getDb().prepare("SELECT value FROM app_settings WHERE key='google_embed_model'").get() as { value?: string } | undefined
      const model = (modelRow?.value || 'gemini-embedding-001')
      pending = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='pending'").get('google', model) as { c: number }).c || 0
      errors = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='error'").get('google', model) as { c: number }).c || 0
    } else {
      const modelRow = getDb().prepare("SELECT value FROM app_settings WHERE key='deepinfra_embed_model'").get() as { value?: string } | undefined
      const model = (modelRow?.value || 'Qwen/Qwen3-Embedding-8B')
      pending = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='pending'").get('deepinfra', model) as { c: number }).c || 0
      errors = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='error'").get('deepinfra', model) as { c: number }).c || 0
    }
  } catch {}
  let rate = 0
  try {
    const key = backend === 'gemma' ? 'embed_progress_gemma' : (backend === 'google' ? 'embed_progress_google' : 'embed_progress')
    const row = dbEmb.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string }
    if (row?.value) {
      const obj = JSON.parse(row.value)
      rate = Number(obj?.rate || 0)
    }
  } catch {}
  const remaining = Math.max(0, total - embedded)
  const etaSeconds = rate > 0 ? Math.round(remaining / rate) : 0
  return { total, embedded, pending, errors, rate, etaSeconds }
}

export function getEmbeddingProgressAll(): Array<{
  backend: 'deepinfra' | 'gemma' | 'google'
  model: string
  total: number
  embedded: number
  pending: number
  errors: number
  rate: number
  etaSeconds: number
}> {
  const out: Array<{ backend: 'deepinfra' | 'gemma' | 'google'; model: string; total: number; embedded: number; pending: number; errors: number; rate: number; etaSeconds: number }> = []
  try {
    const dbMain = getDb()
    const total = (dbMain.prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }).c || 0
    const dbEmb = getEmbDb()
    const diModel = (dbMain.prepare("SELECT value FROM app_settings WHERE key='deepinfra_embed_model'").get() as { value?: string } | undefined)?.value || 'Qwen/Qwen3-Embedding-8B'
    const ggModel = (dbMain.prepare("SELECT value FROM app_settings WHERE key='google_embed_model'").get() as { value?: string } | undefined)?.value || 'gemini-embedding-001'
    const gmModel = (dbMain.prepare("SELECT value FROM app_settings WHERE key='gemma_model_id'").get() as { value?: string } | undefined)?.value || 'onnx-community/embeddinggemma-300m-ONNX'
    const rows: Array<{ backend: 'deepinfra'|'google'|'gemma'; model: string }> = [
      { backend: 'deepinfra', model: diModel },
      { backend: 'google', model: ggModel },
      { backend: 'gemma', model: gmModel }
    ]
    for (const r of rows) {
      let embedded = 0, pending = 0, errors = 0, rate = 0
      try { embedded = (dbEmb.prepare('SELECT COUNT(1) AS c FROM embeddings2 WHERE backend=? AND model=?').get(r.backend, r.model) as { c: number }).c || 0 } catch {}
      try { pending = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='pending'").get(r.backend, r.model) as { c: number }).c || 0 } catch {}
      try { errors = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs2 WHERE backend=? AND model=? AND status='error'").get(r.backend, r.model) as { c: number }).c || 0 } catch {}
      try {
        const key = r.backend === 'gemma' ? 'embed_progress_gemma' : (r.backend === 'google' ? 'embed_progress_google' : 'embed_progress')
        const row = dbEmb.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string }
        if (row?.value) { const obj = JSON.parse(row.value); rate = Number(obj?.rate || 0) }
      } catch {}
      const remaining = Math.max(0, total - embedded)
      const etaSeconds = rate > 0 ? Math.round(remaining / rate) : 0
      out.push({ backend: r.backend, model: r.model, total, embedded, pending, errors, rate, etaSeconds })
    }
  } catch {}
  return out
}

