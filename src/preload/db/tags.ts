import { getDb } from './core'

export type TagRow = { tag: string; notes: number }

let tagListCache: { rows: TagRow[]; ts: number } | null = null
const TAG_LIST_TTL_MS = 60_000
const childCache: Map<string, { rows: TagRow[]; ts: number }> = new Map()

function getAllTagsCached(): TagRow[] {
  const now = Date.now()
  if (tagListCache && (now - tagListCache.ts) < TAG_LIST_TTL_MS) return tagListCache.rows
  const sql = `SELECT tag, COUNT(DISTINCT note_id) AS notes FROM note_tags GROUP BY tag ORDER BY tag`
  const rows = getDb().prepare(sql).all() as TagRow[]
  tagListCache = { rows, ts: now }
  return rows
}

export function listAllTags(): Array<{ tag: string; notes: number }> {
  try { return getAllTagsCached() } catch { return [] }
}

export function getChildTags(prefix: string): Array<{ tag: string; notes: number }> {
  try {
    const p = String(prefix || '')
    const now = Date.now()
    const cached = childCache.get(p)
    if (cached && (now - cached.ts) < TAG_LIST_TTL_MS) return cached.rows
    const all = getAllTagsCached()
    const map = new Map<string, number>()
    for (const r of all) {
      const t = String(r.tag || '')
      if (!p) {
        const head = t.includes('::') ? t.slice(0, t.indexOf('::')) : t
        map.set(head, (map.get(head) || 0) + Number(r.notes || 0))
      } else if (t === p || t.startsWith(p + '::')) {
        const rest = t.slice(p.length)
        if (rest.startsWith('::')) {
          const after = rest.slice(2)
          const child = after.includes('::') ? after.slice(0, after.indexOf('::')) : after
          const full = p + '::' + child
          map.set(full, (map.get(full) || 0) + Number(r.notes || 0))
        }
      }
    }
    const rows = Array.from(map.entries()).map(([tag, notes]) => ({ tag, notes }))
    childCache.set(p, { rows, ts: now })
    return rows
  } catch { return [] }
}


