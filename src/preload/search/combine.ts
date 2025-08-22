export type Combined = { note_id: number; rrf: number; bm25?: number; trig?: number }

export function rrfCombine(
  bm25Hits: Array<{ note_id: number; score: number }>,
  triHits: Array<{ note_id: number; hits: number }>,
  k = 60
): Combined[] {
  const bm25Ranks = new Map<number, number>()
  bm25Hits
    .slice()
    .sort((a, b) => a.score - b.score)
    .forEach((r, i) => bm25Ranks.set(r.note_id, i + 1))

  const triRanks = new Map<number, number>()
  triHits
    .slice()
    .sort((a, b) => b.hits - a.hits)
    .forEach((r, i) => triRanks.set(r.note_id, i + 1))

  const all = new Set<number>()
  bm25Hits.forEach((r) => all.add(r.note_id))
  triHits.forEach((r) => all.add(r.note_id))

  const out: Combined[] = []
  for (const id of all) {
    const r1 = bm25Ranks.get(id)
    const r2 = triRanks.get(id)
    const s1 = r1 ? 1 / (k + r1) : 0
    const s2 = r2 ? 1 / (k + r2) : 0
    out.push({ note_id: id, rrf: s1 + s2, bm25: bm25Hits.find((x) => x.note_id === id)?.score, trig: triHits.find((x) => x.note_id === id)?.hits })
  }
  return out.sort((a, b) => b.rrf - a.rrf)
}

// New: combine multiple per-keyword lists using RRF across all lists.
export function rrfCombinePerKeyword(
  bm25Lists: Array<Array<{ note_id: number; score: number }>>,
  triLists: Array<Array<{ note_id: number; hits: number }>>,
  k = 60
): Combined[] {
  const rrfById = new Map<number, number>()
  const bestBm25 = new Map<number, number>()
  const bestTri = new Map<number, number>()

  const applyListAsc = (list: Array<{ note_id: number }>) => {
    list.forEach((r, i) => {
      rrfById.set(r.note_id, (rrfById.get(r.note_id) || 0) + 1 / (k + (i + 1)))
    })
  }
  const applyListDesc = (list: Array<{ note_id: number }>) => {
    list.forEach((r, i) => {
      rrfById.set(r.note_id, (rrfById.get(r.note_id) || 0) + 1 / (k + (i + 1)))
    })
  }

  for (const list of bm25Lists) {
    applyListAsc(list)
    for (const r of list) {
      const existing = bestBm25.get(r.note_id)
      if (existing === undefined || r.score < existing) bestBm25.set(r.note_id, r.score)
    }
  }
  for (const list of triLists) {
    applyListDesc(list)
    for (const r of list) {
      const existing = bestTri.get(r.note_id)
      if (existing === undefined || r.hits > existing) bestTri.set(r.note_id, r.hits)
    }
  }

  const ids = new Set<number>()
  bm25Lists.forEach((l) => l.forEach((r) => ids.add(r.note_id)))
  triLists.forEach((l) => l.forEach((r) => ids.add(r.note_id)))

  const out: Combined[] = []
  ids.forEach((id) => {
    out.push({ note_id: id, rrf: rrfById.get(id) || 0, bm25: bestBm25.get(id), trig: bestTri.get(id) })
  })
  return out.sort((a, b) => b.rrf - a.rrf)
}

// Weighted variant: each per-keyword list contributes weight/(k+rank)
export function rrfCombinePerKeywordWeighted(
  bm25Lists: Array<Array<{ note_id: number; score: number }>>,
  weights: number[],
  k = 60
): Combined[] {
  const rrfById = new Map<number, number>()
  const bestBm25 = new Map<number, number>()

  for (let li = 0; li < bm25Lists.length; li++) {
    const list = bm25Lists[li]
    const w = Number.isFinite(weights[li]) ? Math.max(0, weights[li]) : 1
    list.forEach((r, i) => {
      rrfById.set(r.note_id, (rrfById.get(r.note_id) || 0) + w / (k + (i + 1)))
    })
    for (const r of list) {
      const existing = bestBm25.get(r.note_id)
      if (existing === undefined || r.score < existing) bestBm25.set(r.note_id, r.score)
    }
  }

  const ids = new Set<number>()
  bm25Lists.forEach((l) => l.forEach((r) => ids.add(r.note_id)))

  const out: Combined[] = []
  ids.forEach((id) => {
    out.push({ note_id: id, rrf: rrfById.get(id) || 0, bm25: bestBm25.get(id) })
  })
  return out.sort((a, b) => b.rrf - a.rrf)
}


