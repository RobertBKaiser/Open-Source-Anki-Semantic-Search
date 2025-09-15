import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

let db: Database.Database | null = null
let dbInitialized = false

function tuneDb(handle: Database.Database): void {
  try {
    handle.pragma('journal_mode = WAL')
    handle.pragma('synchronous = NORMAL')
    handle.pragma('temp_store = MEMORY')
    handle.pragma('cache_size = -262144')
    handle.pragma('mmap_size = 268435456')
  } catch {}
}

function ensureSearchInfra(handle: Database.Database): void {
  if (dbInitialized) return
  try {
    handle.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(content, note_id UNINDEXED, tokenize='unicode61');
       CREATE INDEX IF NOT EXISTS idx_note_fields_note_ord ON note_fields(note_id, ord);`
    )
    try { handle.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts_vocab USING fts5vocab(note_fts, 'row')`) } catch {}
  } catch {}
  dbInitialized = true
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve(process.cwd(), 'database/anki_cache.db')
    try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }) } catch {}
    db = new Database(dbPath)
    tuneDb(db)
    ensureSearchInfra(db)
  }
  return db
}

// Build or refresh FTS5 index used for fuzzy and BM25 search
export function ensureIndexes(): void {
  const db = getDb()
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(content, note_id UNINDEXED, tokenize='unicode61');
     CREATE INDEX IF NOT EXISTS idx_note_fields_note_ord ON note_fields(note_id, ord);`
  )

  const noteCount = db.prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }
  const ftsCount = db.prepare('SELECT COUNT(1) AS c FROM note_fts').get() as { c: number }
  const shouldRebuildFts = ftsCount.c !== noteCount.c
  const shouldRebuildTrigrams = false

  if (shouldRebuildFts || shouldRebuildTrigrams) {
    const rows = db
      .prepare(
        `SELECT n.note_id AS note_id,
                (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY nf.ord ASC LIMIT 1) AS content
           FROM notes n`
      )
      .all() as Array<{ note_id: number; content: string | null }>

    const strip = (html: string): string => {
      const s = String(html || '')
      const noImgs = s.replace(/<img[^>]*>/gi, ' 🖼️ ')
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
  }
}


