import { getSetting } from '../../db/settings'
import { getDb } from '../../db/core'
import { getEmbDb } from '../../embeddings/core'
import { getHnswIndex } from '../../embeddings/hnsw'
import { frontIsVisible } from '../../db/fields'
import { searchByBm25Terms } from './bm25'
import { stripHtmlToText } from '../../utils/text'

// Related notes by embedding against a source note vector
export async function getRelatedByEmbedding(noteId: number, minCos: number = 0.7, topK: number = 50): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>> {
  try {
    const dbEmb = getEmbDb()
    const rowQ = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id = ?').get(noteId) as { note_id: number; dim: number; vec: Buffer; norm: number } | undefined
    if (!rowQ || !rowQ.vec || !rowQ.dim) return []
    const q = new Float32Array(rowQ.vec.buffer, rowQ.vec.byteOffset, rowQ.vec.byteLength / 4)
    const qnorm = rowQ.norm || 1
    // Prefilter by BM25 terms from the front field
    let candidates: number[] = []
    try {
      const frontRow = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1').get(noteId) as { value_html?: string } | undefined
      const text = String(frontRow?.value_html || '')
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      const words = text.split(/\s+/).filter(Boolean).slice(0, 12)
      if (words.length > 0) {
        const bm = searchByBm25Terms(words, Math.min(800, Math.max(200, topK * 12)))
        candidates = bm.map((r) => r.note_id).filter((id) => id !== noteId)
      }
    } catch {}
    // Fetch candidate vectors
    const rows: Array<{ note_id: number; dim: number; vec: Buffer; norm: number }> = []
    if (Array.isArray(candidates) && candidates.length > 0) {
      const CHUNK = 900
      for (let i = 0; i < candidates.length; i += CHUNK) {
        const ids = candidates.slice(i, i + CHUNK)
        const placeholders = ids.map(() => '?').join(',')
        const part = dbEmb.prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`).all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
        rows.push(...part)
      }
    } else {
      const iter = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id != ?').iterate(noteId) as any
      for (const r of iter) rows.push(r)
    }
    const scores: Array<{ id: number; s: number }> = []
    let processed = 0
    for (const r of rows) {
      if (!r.vec || r.dim !== q.length) { processed++; continue }
      const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
      let dot = 0
      for (let i = 0; i < q.length; i++) dot += q[i] * vec[i]
      const denom = (qnorm || 1) * (r.norm || 1)
      const cos = denom ? (dot / denom) : 0
      if (cos >= minCos) scores.push({ id: r.note_id, s: cos })
      processed++
      if (processed % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    scores.sort((a, b) => b.s - a.s)
    const picked = scores.slice(0, Math.max(1, Math.min(200, topK)))
    const firstBy = new Map<number, string | null>()
    try {
      const stmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      for (const p of picked) {
        const row = stmt.get(p.id) as { value_html?: string } | undefined
        firstBy.set(p.id, row?.value_html ?? null)
      }
    } catch {}
    return picked.map(({ id, s }) => ({ note_id: id, first_field: firstBy.get(id) ?? null, cos: s })).filter((r) => frontIsVisible(r.first_field))
  } catch { return [] }
}

// Embedding-based search over query text with optional HNSW acceleration
export async function embedSearch(query: string, topK = 200): Promise<Array<{ note_id: number; first_field: string | null; rerank: number }>> {
  const key = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
  const raw = String(query || '').trim()
  if (!raw) return []
  const model = getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
  const dims = Number(getSetting('deepinfra_embed_dims') || '4096')

  // Offline fallback by averaging candidate embeddings
  async function offlineFallback(): Promise<Array<{ note_id: number; first_field: string | null; rerank: number }>> {
    try {
      const dbMain = getDb()
      const tokens = raw.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w && w.length >= 2)
      const uniq: string[] = []
      const seen = new Set<string>()
      for (const w of tokens) { if (!seen.has(w)) { seen.add(w); uniq.push(w) } }
      const capped = uniq.slice(0, 64)
      if (capped.length === 0) return []
      const BM_CAND = Math.min(800, Math.max(200, Math.floor(topK * 8)))
      const bm = searchByBm25Terms(capped, BM_CAND)
      if (bm.length === 0) return []
      const dbEmb = getEmbDb()
      const ids = bm.map((r) => r.note_id)
      const CHUNK = 900
      const vecs: Array<{ id: number; dim: number; vec: Float32Array; norm: number; first: string | null }> = []
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK)
        const placeholders = slice.map(() => '?').join(',')
        const rows = dbEmb.prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`).all(...slice) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
        for (const r of rows) {
          if (!r.vec || !Number.isFinite(r.dim)) continue
          const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
          vecs.push({ id: r.note_id, dim: r.dim, vec: v, norm: r.norm || 1, first: bm.find((x) => x.note_id === r.note_id)?.first_field ?? null })
        }
      }
      if (vecs.length === 0) return bm.map((r) => ({ note_id: r.note_id, first_field: r.first_field, rerank: 0 }))
      const dimCounts = new Map<number, number>()
      for (const v of vecs) dimCounts.set(v.dim, (dimCounts.get(v.dim) || 0) + 1)
      let modeDim = vecs[0].dim
      let modeCnt = 0
      for (const [d, c] of dimCounts.entries()) { if (c > modeCnt) { modeCnt = c; modeDim = d } }
      const sameDim = vecs.filter((v) => v.dim === modeDim)
      if (sameDim.length === 0) return []
      const qv = new Float32Array(modeDim)
      for (const { vec } of sameDim) { const len = Math.min(modeDim, vec.length); for (let i = 0; i < len; i++) qv[i] += vec[i] }
      for (let i = 0; i < qv.length; i++) qv[i] /= sameDim.length
      let qn = 0; for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i]
      qn = Math.sqrt(qn) || 1
      const vecById = new Map<number, { vec: Float32Array; norm: number; first: string | null }>()
      for (const v of sameDim) vecById.set(v.id, { vec: v.vec, norm: v.norm || 1, first: v.first })
      const scored: Array<{ note_id: number; first_field: string | null; cos: number }> = []
      for (const r of bm) {
        const vv = vecById.get(r.note_id)
        if (!vv) continue
        const len = Math.min(qv.length, vv.vec.length)
        let dot = 0
        for (let i = 0; i < len; i++) dot += qv[i] * vv.vec[i]
        const cos = dot / (qn * (vv.norm || 1))
        scored.push({ note_id: r.note_id, first_field: vv.first ?? r.first_field, cos })
      }
      scored.sort((a, b) => b.cos - a.cos)
      return scored.map((s) => ({ note_id: s.note_id, first_field: s.first_field, rerank: s.cos })).filter((r) => frontIsVisible(r.first_field)).slice(0, Math.max(1, Math.min(100, topK)))
    } catch { return [] }
  }

  // If no API key, immediately use offline fallback
  if (!key) return offlineFallback()

  // Online embed: ALWAYS embed the cleaned, capped query as a single input
  const qClean = stripHtmlToText(raw).slice(0, 1000)
  const inputs: string[] = [qClean]
  let qVec: Float32Array | null = null
  try {
    const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, input: inputs, encoding_format: 'float', dimensions: dims })
    })
    if (!res.ok) return []
    const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    const emb = Array.isArray(j?.data) && j!.data![0]?.embedding ? j!.data![0].embedding : []
    if (!Array.isArray(emb) || emb.length === 0) return []
    qVec = new Float32Array(emb)
  } catch { return [] }

  // HNSW disabled per request. Always use DB cosine scan.
  const useHnsw = false
  const firstFieldStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
  if (!qVec) return offlineFallback()
  let qn = 0; for (let i = 0; i < qVec.length; i++) qn += qVec[i] * qVec[i]
  qn = Math.sqrt(qn) || 1

  if (useHnsw) { /* disabled */ }

  // Full scan fallback: compute cosine against all vectors with matching dimension
  const dbEmb = getEmbDb()
  const rows = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings WHERE dim = ?').all(dims) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
  const scores: Array<{ id: number; s: number }> = []
  for (const r of rows) {
    if (!r.vec) continue
    const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
    if (vec.length !== qVec.length) continue
    let dot = 0
    for (let i = 0; i < qVec.length; i++) dot += qVec[i] * vec[i]
    const cos = dot / (qn * (r.norm || 1))
    scores.push({ id: r.note_id, s: cos })
  }
  scores.sort((a, b) => b.s - a.s)
  const picked = scores.slice(0, Math.max(1, Math.min(100, topK)))
  const mapped = picked.map(({ id, s }) => {
    const row = firstFieldStmt.get(id) as { value_html?: string } | undefined
    return { note_id: id, first_field: row?.value_html ?? null, rerank: s }
  }).filter((r) => frontIsVisible(r.first_field))
  if (mapped.length === 0) return []
  return mapped
}

// Embedding-based related by selected concept terms with FTS prefilter and RRF
export async function getRelatedByEmbeddingTerms(terms: string[], topK: number = 20): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>> {
  try {
    const key = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
    if (!key) return []
    const model = getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
    const dims = Number(getSetting('deepinfra_embed_dims') || '4096')
    const termsClean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim()).filter((t) => t.length > 0) : []
    if (termsClean.length === 0) return []

    // Batch embed the terms
    let embList: number[][] = []
    const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, input: termsClean, encoding_format: 'float', dimensions: dims })
    })
    if (!res.ok) return []
    const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    embList = Array.isArray(j?.data) ? j!.data!.map((d) => d.embedding) : []
    if (embList.length === 0) return []

    // HNSW acceleration
    const idx = getHnswIndex(dims)
    if (idx) {
      try {
        const q = new Float32Array(dims)
        for (const e of embList) { const v = new Float32Array(e); for (let i = 0; i < Math.min(dims, v.length); i++) q[i] += v[i] }
        for (let i = 0; i < q.length; i++) q[i] /= embList.length
        const index = idx as any
        try { index.setEf(200) } catch {}
        const kSearch = Math.max(200, Math.min(1000, Math.floor(topK * 3)))
        const result = index.searchKnn(Array.from(q), kSearch)
        const idsRaw: any[] = Array.isArray((result as any).neighbors) ? (result as any).neighbors : (Array.isArray((result as any).labels) ? (result as any).labels : [])
        const ids = idsRaw.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
        const firstBy = new Map<number, string | null>()
        const stmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
        for (const id of ids) { const row = stmt.get(id) as { value_html?: string } | undefined; firstBy.set(id, row?.value_html ?? null) }
        const out: Array<{ note_id: number; first_field: string | null; cos: number }> = []
        const scores = Array.isArray((result as any).distances) ? (result as any).distances : []
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]
          const sim = (typeof scores[i] === 'number') ? (1 - Number(scores[i])) : 0
          out.push({ note_id: id, first_field: firstBy.get(id) ?? null, cos: sim })
        }
        return out.slice(0, topK)
      } catch {}
    }

    // FTS prefilter
    const bm = searchByBm25Terms(termsClean, Math.min(1000, Math.max(200, topK * 20)))
    const candidates = bm.map((r) => r.note_id)
    const dbEmb = getEmbDb()
    const perNoteBestCos = new Map<number, number>()
    const perNoteRrf = new Map<number, number>()
    const K = 60
    for (const emb of embList) {
      const q = new Float32Array(emb)
      let qnorm = 0
      for (let i = 0; i < q.length; i++) qnorm += q[i] * q[i]
      qnorm = Math.sqrt(qnorm) || 1
      const rows: Array<{ note_id: number; dim: number; vec: Buffer; norm: number }> = []
      if (candidates.length > 0) {
        const CHUNK = 900
        for (let i = 0; i < candidates.length; i += CHUNK) {
          const ids = candidates.slice(i, i + CHUNK)
          const placeholders = ids.map(() => '?').join(',')
          const part = dbEmb.prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`).all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
          rows.push(...part)
        }
      } else {
        const iter = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings').iterate() as any
        for (const r of iter) rows.push(r)
      }
      const scores: Array<{ id: number; s: number }> = []
      for (const r of rows) {
        if (!r.vec) continue
        const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        const len = Math.min(q.length, vec.length)
        if (len === 0) continue
        let dot = 0
        let vnorm = 0
        for (let i = 0; i < len; i++) { const vi = vec[i]; const qi = q[i]; dot += qi * vi; vnorm += vi * vi }
        vnorm = Math.sqrt(vnorm) || 1
        const cos = dot / (qnorm * vnorm)
        scores.push({ id: r.note_id, s: cos })
      }
      scores.sort((a, b) => b.s - a.s)
      for (let rank = 0; rank < scores.length; rank++) {
        const { id, s } = scores[rank]
        if (!perNoteBestCos.has(id) || s > (perNoteBestCos.get(id) as number)) perNoteBestCos.set(id, s)
        perNoteRrf.set(id, (perNoteRrf.get(id) || 0) + 1 / (K + (rank + 1)))
      }
    }
    const final = Array.from(perNoteRrf.entries())
      .map(([id, rrf]) => ({ id, rrf, cos: perNoteBestCos.get(id) || 0 }))
      .sort((a, b) => (b.cos - a.cos) || (b.rrf - a.rrf))
      .slice(0, Math.max(1, Math.min(100, topK)))
    const firstBy = new Map<number, string | null>()
    try {
      const stmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      for (const x of final) { const row = stmt.get(x.id) as { value_html?: string } | undefined; firstBy.set(x.id, row?.value_html ?? null) }
    } catch {}
    return final.map(({ id, cos }) => ({ note_id: id, first_field: firstBy.get(id) ?? null, cos })).filter((r) => frontIsVisible(r.first_field))
  } catch { return [] }
}


