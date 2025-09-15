import { getDb } from './core'

type NoteDetailsCache = {
  note: { note_id: number; model_name: string; mod: number | null }
  fields: Array<{ field_name: string; value_html: string; ord: number | null }>
  tags: string[]
  ts: number
}

const NOTE_DETAILS_TTL_MS = 2 * 60 * 1000
const noteDetailsCache: Map<number, NoteDetailsCache> = new Map()

export function listNotes(limit = 200, offset = 0): Array<{ note_id: number; first_field: string | null }>{
  const stmt = getDb().prepare(
    `SELECT n.note_id,
            (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
       FROM notes n
      ORDER BY n.note_id DESC
      LIMIT ? OFFSET ?`
  )
  return stmt.all(limit, offset)
}

export function countNotes(): number {
  const row = getDb().prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }
  return row?.c || 0
}

export function searchNotes(query: string, limit = 200, offset = 0): Array<{ note_id: number; first_field: string | null }>{
  const raw = String(query || '').trim()
  if (raw.length === 0) return listNotes(limit, offset)
  const tokens: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const phrase = (m[1] || m[2] || '').toLowerCase()
    if (phrase) tokens.push(phrase)
  }
  if (tokens.length === 0) return listNotes(limit, offset)
  const where = tokens
    .map(() =>
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
}

export function getNoteDetails(noteId: number): {
  note: { note_id: number; model_name: string; mod: number | null }
  fields: Array<{ field_name: string; value_html: string; ord: number | null }>
  tags: string[]
} | null {
  const now = Date.now()
  const cached = noteDetailsCache.get(noteId)
  if (cached && (now - cached.ts) < NOTE_DETAILS_TTL_MS) return { note: cached.note, fields: cached.fields, tags: cached.tags }
  try {
    const db = getDb()
    const note = db.prepare('SELECT note_id, model_name, mod FROM notes WHERE note_id = ?').get(noteId)
    if (!note) return null
    const fields = db.prepare('SELECT field_name, value_html, ord FROM note_fields WHERE note_id = ? ORDER BY ord ASC, field_name ASC').all(noteId)
    const tags = db.prepare('SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag ASC').all(noteId).map((r: { tag: string }) => r.tag)
    const result = { note, fields, tags }
    noteDetailsCache.set(noteId, { ...result, ts: now })
    if (noteDetailsCache.size > 100) {
      const entries = Array.from(noteDetailsCache.entries())
      entries.sort((a, b) => a[1].ts - b[1].ts)
      for (let i = 0; i < 50; i++) noteDetailsCache.delete(entries[i][0])
    }
    return result
  } catch { return null }
}

export function getNotesByTag(tag: string, limit: number = 1000, offset: number = 0): Array<{ note_id: number; first_field: string | null }>{
  try {
    const sql = `
      SELECT n.note_id,
             (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
        FROM notes n
        JOIN note_tags t ON t.note_id = n.note_id
       WHERE t.tag = ?
       ORDER BY n.note_id DESC
       LIMIT ? OFFSET ?`
    const stmt = getDb().prepare(sql)
    return stmt.all(tag, limit, offset) as Array<{ note_id: number; first_field: string | null }>
  } catch { return [] }
}

export function getNotesByTagPrefix(prefix: string, limit: number = 2000, offset: number = 0): Array<{ note_id: number; first_field: string | null }>{
  try {
    const p = String(prefix || '')
    const stmt = getDb().prepare(`
      SELECT n.note_id,
             (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
        FROM notes n
        WHERE EXISTS (
          SELECT 1 FROM note_tags t WHERE t.note_id = n.note_id AND (t.tag = ? OR t.tag LIKE (? || '::%'))
        )
       ORDER BY n.note_id DESC
       LIMIT ? OFFSET ?`)
    return stmt.all(p, p, limit, offset) as Array<{ note_id: number; first_field: string | null }>
  } catch { return [] }
}


