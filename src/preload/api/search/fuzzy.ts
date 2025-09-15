import { getDb, ensureIndexes } from '../../db/core'
import { rrfCombinePerKeywordWeighted } from '../../search/combine'
import { searchBm25 } from '../../search/bm25'
import { extractKeywords as kwExtract } from '../../search/kw'

export function fuzzySearch(
  query: string,
  limit = 50,
  exclude: string[] = []
): Array<{ note_id: number; first_field: string | null; bm25?: number; trigrams?: number; combined: number; rrf: number; where?: 'front' | 'back' | 'both' }>
{
  const db = getDb()
  ensureIndexes()
  const qnorm = String(query || '').replace(/\s+/g, ' ').trim()
  if (!qnorm) {
    const rows = db.prepare(
      `SELECT n.note_id,
              (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
         FROM notes n
        ORDER BY n.note_id DESC
        LIMIT ? OFFSET 0`
    ).all(limit) as Array<{ note_id: number; first_field: string | null }>
    return rows.map((r) => ({ ...r, combined: 0, rrf: 0 }))
  }

  let terms = kwExtract(qnorm, 16)
  if (exclude.length) {
    const ex = new Set(exclude.map((s) => s.toLowerCase()))
    terms = terms.filter((t) => !ex.has(t.toLowerCase()))
  }
  if (terms.length === 0) terms = qnorm.split(/\s+/)

  const perTermMatch = terms.map((t) => `"${t}"`)
  const fetchBm25 = Math.min(5000, Math.max(limit * 2, 1000))
  const bm25Lists = perTermMatch.map((m) => searchBm25(getDb(), m, fetchBm25))
  const widened = bm25Lists.every((l: any[]) => l.length === 0)
  const bm25Wide = widened ? [searchBm25(getDb(), terms.map((t: string) => `"${t}"`).join(' OR '), fetchBm25)] : []

  let weights: number[] = []
  try {
    getDb().exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts_vocab USING fts5vocab(note_fts, 'row')`)
    const uniq = Array.from(new Set(terms))
    const total = (getDb().prepare(`SELECT COUNT(*) AS c FROM note_fts`).get() as { c: number }).c || 1
    const unig = uniq.filter((t) => !t.includes(' '))
    const phr = uniq.filter((t) => t.includes(' '))
    const idfBy = new Map<string, number>()
    if (unig.length) {
      const placeholders = unig.map(() => '?').join(',')
      const rows = getDb().prepare(`SELECT term, doc AS df FROM note_fts_vocab WHERE term IN (${placeholders})`).all(...unig) as Array<{ term: string; df: number }>
      for (const t of unig) {
        const r = rows.find((x) => x.term === t)
        const df = r?.df ?? 0
        const idf = Math.log((total - df + 0.5) / (df + 0.5))
        idfBy.set(t, Math.max(0, isFinite(idf) ? idf : 0))
      }
    }
    if (phr.length) {
      const countStmt = getDb().prepare('SELECT COUNT(1) AS c FROM note_fts WHERE note_fts MATCH ?')
      for (const p of phr) {
        const r = countStmt.get(`"${p}"`) as { c: number }
        const df = Number(r?.c || 0)
        const idf = Math.log((total - df + 0.5) / (df + 0.5))
        idfBy.set(p, Math.max(0, isFinite(idf) ? idf : 0))
      }
    }
    const nounSuffix = /(?:tion|sion|ment|ness|ity|ism|ology|logy|itis|emia|osis|oma|ectomy|plasty|scopy|gram|graphy|phobia|philia|gen|genic|ase|ose|algia|derm|cyte|blast|coccus|cocci|bacter|virus|enzyme|receptor|syndrome|disease|anemia|ecchymosis|contusion|hematoma|neuron|artery|vein|nerve|muscle|bone|cortex|nucleus|organ|tissue|cell|protein)$/
    function isLikelyNoun(token: string): boolean {
      if (token.includes('-')) return true
      if (nounSuffix.test(token)) return true
      if (token.length >= 5 && !/(?:ing|ed)$/.test(token)) return true
      return false
    }
    weights = terms.map((t) => {
      const base = 1
      const idf = Math.min(3, idfBy.get(t) ?? 0)
      const hyphen = t.includes('-') ? 0.75 : 0
      const long = t.length >= 8 ? 0.25 : 0
      const nounBoost = isLikelyNoun(t) ? 3.5 : 0
      return base + idf + hyphen + long + nounBoost
    })
  } catch {
    const nounSuffix = /(?:tion|sion|ment|ness|ity|ism|ology|logy|itis|emia|osis|oma|ectomy|plasty|scopy|gram|graphy|phobia|philia|gen|genic|ase|ose|algia|derm|cyte|blast|coccus|cocci|bacter|virus|enzyme|receptor|syndrome|disease|anemia|ecchymosis|contusion|hematoma|neuron|artery|vein|nerve|muscle|bone|cortex|nucleus|organ|tissue|cell|protein)$/
    function isLikelyNoun(token: string): boolean {
      if (token.includes('-')) return true
      if (nounSuffix.test(token)) return true
      if (token.length >= 5 && !/(?:ing|ed)$/.test(token)) return true
      return false
    }
    weights = terms.map((t) => 1 + (t.includes('-') ? 0.75 : 0) + (t.length >= 8 ? 0.25 : 0) + (isLikelyNoun(t) ? 3.5 : 0))
  }

  const combined = rrfCombinePerKeywordWeighted(
    (bm25Lists as any).length ? (bm25Lists as any) : (bm25Wide as any),
    (bm25Lists as any).length ? weights : [1]
  )

  const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
  const backStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord DESC LIMIT 1')
  return combined.map((r: any) => {
    const front = frontStmt.get(r.note_id) as { value_html?: string } | undefined
    const back = backStmt.get(r.note_id) as { value_html?: string } | undefined
    let where: 'front' | 'back' | 'both' | undefined
    const f = (front?.value_html || '').toLowerCase()
    const b = (back?.value_html || '').toLowerCase()
    const hitFront = terms.some((t) => f.includes(t.toLowerCase()))
    const hitBack = terms.some((t) => b.includes(t.toLowerCase()))
    if (hitFront && hitBack) where = 'both'
    else if (hitFront) where = 'front'
    else if (hitBack) where = 'back'
    return { note_id: r.note_id, first_field: front?.value_html ?? null, bm25: r.bm25, trigrams: undefined, combined: r.rrf, rrf: r.rrf, where }
  })
}


