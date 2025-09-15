import { getDb } from './core'
import { frontIsVisible } from '../utils/text'

export function getFirstFieldsForIds(ids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>()
  try {
    if (!Array.isArray(ids) || ids.length === 0) return out
    const db = getDb()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT n.note_id AS id,
              (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first
         FROM notes n
        WHERE n.note_id IN (${placeholders})`
    ).all(...ids) as Array<{ id: number; first: string | null }>
    for (const r of rows) out.set(r.id, r.first ?? null)
  } catch {}
  return out
}

export function getBackFieldsForIds(ids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>()
  try {
    if (!Array.isArray(ids) || ids.length === 0) return out
    const db = getDb()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(
      `WITH mm AS (
         SELECT note_id, MAX(COALESCE(ord, -999999)) AS max_ord
           FROM note_fields
          WHERE note_id IN (${placeholders})
          GROUP BY note_id
       )
       SELECT nf.note_id AS id, nf.value_html AS back
         FROM note_fields nf
         JOIN mm ON mm.note_id = nf.note_id AND (nf.ord = mm.max_ord OR (mm.max_ord = -999999 AND nf.ord IS NULL))`
    ).all(...ids) as Array<{ id: number; back: string | null }>
    for (const r of rows) out.set(r.id, r.back ?? null)
  } catch {}
  return out
}

export { frontIsVisible }


