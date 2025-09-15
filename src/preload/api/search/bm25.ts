import { getDb, ensureIndexes } from '../../db/core'
import { searchBm25 } from '../../search/bm25'

export function bm25ForNotesByTerms(terms: string[], noteIds: number[]): Array<{ note_id: number; bm25: number }> {
  try {
    const db = getDb()
    ensureIndexes()
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
  } catch { return [] }
}

export function searchByBm25Terms(terms: string[], limit: number = 200): Array<{ note_id: number; first_field: string | null; bm25: number }> {
  try {
    const db = getDb()
    ensureIndexes()
    const clean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim()).filter((t) => t.length > 0) : []
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
  } catch { return [] }
}

export function getRelatedByBm25(noteId: number, limit: number = 20, terms?: string[]): Array<{ note_id: number; first_field: string | null; bm25: number }> {
  try {
    const db = getDb()
    ensureIndexes()
    const frontStmt = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
    const text = String(src || '')
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\[sound:[^\]]+\]/gi, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    const selected = Array.isArray(terms) && terms.length ? terms.slice(0, 16) : text.split(/\s+/).filter(Boolean).slice(0, 16)
    if (selected.length === 0) return []
    const expr = selected.map((t) => `"${t}"`).join(' OR ')
    const hits = searchBm25(db as any, expr, Math.max(100, limit * 5))
    const filtered = hits.filter((h) => h.note_id !== noteId).slice(0, Math.max(1, limit * 3))
    const firstField = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const mapped = filtered.map((h) => {
      const row = firstField.get(h.note_id) as { value_html?: string } | undefined
      return { note_id: h.note_id, first_field: row?.value_html ?? null, bm25: Number(h.score) }
    })
    return mapped.slice(0, Math.max(1, limit))
  } catch { return [] }
}


