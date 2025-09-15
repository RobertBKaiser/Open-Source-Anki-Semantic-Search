import { getEmbDb } from './core'
import { getFirstFieldsForIds } from '../db/fields'

export function getPrecomputedRelated(type: 'bm25' | 'embedding' | 'hybrid', noteId: number, limit: number = 20): Array<{ note_id: number; first_field: string | null; score: number }> {
  try {
    const dbEmb = getEmbDb()
    const rows = dbEmb.prepare('SELECT target_note_id AS id, score FROM related_precomputed WHERE source_note_id = ? AND type = ? ORDER BY score DESC LIMIT ?').all(noteId, type, Math.max(1, limit)) as Array<{ id: number; score: number }>
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    const firstBy = getFirstFieldsForIds(ids)
    return rows.map((r) => ({ note_id: r.id, first_field: firstBy.get(r.id) ?? null, score: Number(r.score || 0) }))
  } catch { return [] }
}

export function setPrecomputedRelated(type: 'bm25' | 'embedding' | 'hybrid', noteId: number, items: Array<{ note_id: number; score: number }>): { ok: boolean; inserted: number } {
  try {
    const dbEmb = getEmbDb()
    const del = dbEmb.prepare('DELETE FROM related_precomputed WHERE source_note_id = ? AND type = ?')
    const ins = dbEmb.prepare('INSERT INTO related_precomputed(source_note_id, type, target_note_id, score, created_at) VALUES(?, ?, ?, ?, ?)')
    const now = Date.now()
    const txn = dbEmb.transaction(() => {
      del.run(noteId, type)
      let inserted = 0
      for (const it of items) {
        if (!it || !Number.isFinite(Number(it.note_id))) continue
        ins.run(noteId, type, Number(it.note_id), Number(it.score || 0), now)
        inserted++
      }
      return inserted
    })
    const inserted = txn()
    return { ok: true, inserted }
  } catch { return { ok: false, inserted: 0 } }
}


