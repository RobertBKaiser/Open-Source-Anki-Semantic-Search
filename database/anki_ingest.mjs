// anki_ingest.mjs (ESM)
// Minimal example: request notes from AnkiConnect and save them into SQLite (better-sqlite3).
// Usage: node database/anki_ingest.mjs "*"

import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---- Config ---------------------------------------------------
const ANKI_CONNECT_URL = 'http://127.0.0.1:8765'
const AC_VERSION = 6
const DB_PATH = path.resolve(__dirname, 'anki_cache.db')
const query = process.argv[2] || '*'

async function ac(action, params = {}) {
  const body = JSON.stringify({ action, version: AC_VERSION, params })
  const res = await fetch(ANKI_CONNECT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const json = await res.json()
  if (json.error) throw new Error(`AnkiConnect error: ${json.error}`)
  return json.result
}

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  note_id     INTEGER PRIMARY KEY,
  model_name  TEXT NOT NULL,
  profile     TEXT,
  mod         INTEGER,
  fetched_at  INTEGER NOT NULL,
  content_hash TEXT,
  synced_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS note_fields (
  note_id     INTEGER NOT NULL,
  field_name  TEXT NOT NULL,
  value_html  TEXT NOT NULL,
  ord         INTEGER,
  PRIMARY KEY (note_id, field_name),
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  tag TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag),
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE,
  FOREIGN KEY (tag)     REFERENCES tags(tag)     ON DELETE CASCADE
);
`)

// Best-effort add columns if they were missing previously
try { db.exec(`ALTER TABLE notes ADD COLUMN content_hash TEXT`) } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN synced_at INTEGER`) } catch {}
// Populate synced_at if null
try { db.exec(`UPDATE notes SET synced_at = CAST(strftime('%s','now') AS INTEGER) WHERE synced_at IS NULL`) } catch {}

const upsertNote = db.prepare(`
INSERT INTO notes (note_id, model_name, profile, mod, fetched_at)
VALUES (@note_id, @model_name, @profile, @mod, @fetched_at)
ON CONFLICT(note_id) DO UPDATE SET
  model_name=excluded.model_name,
  profile   =excluded.profile,
  mod       =excluded.mod,
  fetched_at=excluded.fetched_at
`)

const upsertField = db.prepare(`
INSERT INTO note_fields (note_id, field_name, value_html, ord)
VALUES (@note_id, @field_name, @value_html, @ord)
ON CONFLICT(note_id, field_name) DO UPDATE SET
  value_html=excluded.value_html,
  ord       =excluded.ord
`)

const upsertTag = db.prepare(`INSERT OR IGNORE INTO tags(tag) VALUES (?)`)
const upsertNoteTag = db.prepare(`INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?, ?)`) 

const deleteNoteFields = db.prepare(`DELETE FROM note_fields WHERE note_id = ?`)
const deleteNoteTags = db.prepare(`DELETE FROM note_tags WHERE note_id = ?`)
const updateNoteHash = db.prepare(`UPDATE notes SET content_hash = ?, mod = ?, synced_at = ? WHERE note_id = ?`)

// Ensure search indexes exist (matching preload `_ensureSearchIndexes` schema)
db.exec(
  `CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(content, note_id UNINDEXED, tokenize='unicode61');
   CREATE INDEX IF NOT EXISTS idx_note_fields_note_ord ON note_fields(note_id, ord);`
)

const deleteFtsFor = db.prepare(`DELETE FROM note_fts WHERE note_id = ?`)
const insertFts = db.prepare(`INSERT OR REPLACE INTO note_fts(content, note_id) VALUES (?, ?)`)
// Trigram maintenance disabled for performance
const deleteTrigramsFor = { run() {} }
const insertTrigram = { run() {} }

function normalizeHtml(html) {
  if (!html) return ''
  const noImgs = html.replace(/<img[^>]*>/gi, ' 🖼️ ')
  const brSp = noImgs.replace(/<br\s*\/?\s*>/gi, ' ')
  const noTags = brSp.replace(/<[^>]*>/g, ' ')
  const noAudio = noTags.replace(/\[sound:[^\]]+\]/gi, ' 🔊 ')
  return noAudio
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function computeContentHash(note) {
  // Stable order by field order
  const fieldEntries = Object.entries(note.fields || {}).map(([name, obj]) => ({
    name,
    order: obj?.order ?? 0,
    value: normalizeHtml(obj?.value ?? '')
  }))
  fieldEntries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const fieldsJoined = fieldEntries.map((f) => `${f.name}=${f.value}`).join('|')
  const tags = (note.tags || []).slice().sort().join('|')
  const payload = `${note.modelName || ''}||${fieldsJoined}||${tags}`
  return crypto.createHash('sha256').update(payload).digest('hex')
}

function updateIndexesFor(noteId, note) {
  // Use first (front) field text only
  const entries = Object.entries(note.fields || {}).map(([name, obj]) => ({
    name,
    order: obj?.order ?? 0,
    value: obj?.value ?? ''
  }))
  entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const front = entries.length ? normalizeHtml(entries[0].value) : ''
  deleteFtsFor.run(noteId)
  insertFts.run(front, noteId)
  // Rebuild trigrams for this note
  deleteTrigramsFor.run(noteId)
  // Trigram computation disabled
}

const insertNotesTxn = db.transaction((notes) => {
  const now = Math.floor(Date.now() / 1000)
  for (const n of notes) {
    upsertNote.run({
      note_id: n.noteId,
      model_name: n.modelName,
      profile: n.profile ?? null,
      mod: n.mod ?? null,
      fetched_at: now,
    })

    for (const [fieldName, obj] of Object.entries(n.fields || {})) {
      upsertField.run({
        note_id: n.noteId,
        field_name: fieldName,
        value_html: obj?.value ?? '',
        ord: obj?.order ?? null,
      })
    }

    for (const t of n.tags || []) {
      upsertTag.run(t)
      upsertNoteTag.run(n.noteId, t)
    }
  }
})

;(async () => {
  console.log(`Fetching notesInfo for query: ${JSON.stringify(query)}`)
  const notes = await ac('notesInfo', { query })
  const fetchedCount = Array.isArray(notes) ? notes.length : 0
  console.log(`Fetched ${fetchedCount} notes`)

  if (!Array.isArray(notes) || notes.length === 0) {
    console.log('Nothing to ingest. Exiting.')
    process.exit(0)
  }

  const now = Math.floor(Date.now() / 1000)
  // Existing DB state
  const dbRows = db.prepare('SELECT note_id, mod, content_hash FROM notes').all()
  const dbById = new Map(dbRows.map((r) => [r.note_id, r]))
  const fetchedIds = new Set(notes.map((n) => n.noteId))
  const dbIds = new Set(dbRows.map((r) => r.note_id))

  // Deletions
  const toDelete = []
  for (const id of dbIds) if (!fetchedIds.has(id)) toDelete.push(id)
  if (toDelete.length) {
    const qs = toDelete.map(() => '?').join(',')
    db.prepare(`DELETE FROM notes WHERE note_id IN (${qs})`).run(...toDelete)
    console.log(`Deleted ${toDelete.length} notes no longer present in Anki`)
  }

  let inserted = 0
  let updated = 0
  let unchanged = 0

  const upsertOne = db.transaction((note) => {
    // Insert/Update note row
    upsertNote.run({
      note_id: note.noteId,
      model_name: note.modelName,
      profile: note.profile ?? null,
      mod: note.mod ?? null,
      fetched_at: now
    })
  })

  for (const n of notes) {
    const prior = dbById.get(n.noteId)
    if (prior && prior.mod === (n.mod ?? null)) {
      // No change; just touch synced_at
      db.prepare('UPDATE notes SET synced_at = ? WHERE note_id = ?').run(now, n.noteId)
      unchanged++
      continue
    }
    const hash = computeContentHash(n)
    if (!prior || (prior.content_hash || '') !== hash) {
      upsertOne(n)
      // Replace fields and tags for this note
      deleteNoteFields.run(n.noteId)
      for (const [fieldName, obj] of Object.entries(n.fields || {})) {
        upsertField.run({
          note_id: n.noteId,
          field_name: fieldName,
          value_html: obj?.value ?? '',
          ord: obj?.order ?? null
        })
      }
      deleteNoteTags.run(n.noteId)
      for (const t of n.tags || []) {
        upsertTag.run(t)
        upsertNoteTag.run(n.noteId, t)
      }
      updateNoteHash.run(hash, n.mod ?? null, now, n.noteId)
      updateIndexesFor(n.noteId, n)
      if (prior) updated++
      else inserted++
    } else {
      // Hash equal but mod changed (rare); update meta only
      db.prepare('UPDATE notes SET mod=?, synced_at=? WHERE note_id=?').run(n.mod ?? null, now, n.noteId)
      unchanged++
    }
  }

  console.log(`Ingest complete. Inserted: ${inserted}, Updated: ${updated}, Unchanged: ${unchanged}, Deleted: ${toDelete.length}`)
  console.log('Done. Data saved to', DB_PATH)
})().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
