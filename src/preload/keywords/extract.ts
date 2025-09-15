import { extractKeywords as kwExtract } from '../search/kw'
import { getDb } from '../db/core'
import { stripHtmlToText } from '../utils/text'

export function extractQueryKeywords(query: string): string[] {
  const qnorm = String(query || '').replace(/\s+/g, ' ').trim()
  if (!qnorm) return []
  return kwExtract(qnorm, 16)
}

export function extractKeywordsForNotes(noteIds: number[], perNoteTopK: number = 6, maxGlobal: number = 200): Array<{ note_id: number; keywords: string[] }> {
  try {
    const ids = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
    if (ids.length === 0) return []
    const db = getDb()
    const stmt = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const out: Array<{ note_id: number; keywords: string[] }> = []
    for (const id of ids.slice(0, maxGlobal)) {
      const row = stmt.get(id) as { value_html?: string } | undefined
      const text = stripHtmlToText(row?.value_html || '')
      const kws = text ? kwExtract(text, perNoteTopK) : []
      out.push({ note_id: id, keywords: kws })
    }
    return out
  } catch { return [] }
}

export function extractFrontKeyIdeas(noteId: number, maxItems: number = 10): string[] {
  try {
    const db = getDb()
    const frontStmt = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
    const text = stripHtmlToText(src)
    return kwExtract(text, Math.max(1, maxItems))
  } catch { return [] }
}

export function getTopKeywordsForNote(noteId: number, maxItems: number = 8): string[] {
  try {
    const db = getDb()
    const frontStmt = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
    return kwExtract(stripHtmlToText(src), Math.max(1, maxItems))
  } catch { return [] }
}


