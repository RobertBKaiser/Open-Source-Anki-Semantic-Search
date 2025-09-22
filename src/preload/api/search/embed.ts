import { getSetting } from '../../db/settings'
import { getDb } from '../../db/core'
import { getEmbDb } from '../../embeddings/core'
import { getHnswIndex } from '../../embeddings/hnsw'
import { frontIsVisible } from '../../db/fields'
import { searchByBm25Terms } from './bm25'
import { stripHtmlToText } from '../../utils/text'
import { computeLocalEmbedding } from '../../embeddings/gemma'

// Related notes by embedding against a source note vector
export async function getRelatedByEmbedding(noteId: number, minCos: number = 0.7, topK: number = 50): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>> {
  try {
    const dbEmb = getEmbDb()
    const backend = getSetting('embedding_backend') || 'deepinfra'
    const model = backend === 'gemma' ? (getSetting('gemma_model_id') || 'onnx-community/embeddinggemma-300m-ONNX') : (getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B')
    const rowQ = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings2 WHERE note_id = ? AND backend = ? AND model = ?').get(noteId, backend, model) as { note_id: number; dim: number; vec: Buffer; norm: number } | undefined
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
        const part = dbEmb.prepare(`SELECT note_id, dim, vec, norm FROM embeddings2 WHERE backend = ? AND model = ? AND note_id IN (${placeholders})`).all(backend, model, ...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
        rows.push(...part)
      }
    } else {
      const iter = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings2 WHERE backend = ? AND model = ? AND note_id != ?').iterate(backend, model, noteId) as any
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
  const backend = getSetting('embedding_backend') || 'deepinfra'
  const key = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
  const raw = String(query || '').trim()
  if (!raw) return []
  const diModel = getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
  const diDims = Number(getSetting('deepinfra_embed_dims') || '4096')
  const gemmaModel = getSetting('gemma_model_id') || 'onnx-community/embeddinggemma-300m-ONNX'
  const googleModel = getSetting('google_embed_model') || 'gemini-embedding-001'
  const multi = (getSetting('embedding_multi_model') || '0') === '1'

  const logModel = backend === 'gemma' ? gemmaModel : backend === 'google' ? googleModel : diModel
  const logDims = backend === 'deepinfra' ? diDims : backend === 'google' ? 3072 : backend === 'gemma' ? 768 : null
  try {
    console.log(`[embedSearch] backend=${backend} model=${logModel}${logDims ? ` dims=${logDims}` : ''} q='${raw}'`)
  } catch {}

  // Offline fallback by averaging candidate embeddings
  async function offlineFallback(reason?: string): Promise<Array<{ note_id: number; first_field: string | null; rerank: number }>> {
    const message = reason || 'Embedding query failed and fallback is disabled.'
    try { console.error(`[embedSearch] ${message}`) } catch {}
    throw new Error(message)
  }

  // If backend is gemma or no DeepInfra key, compute local embedding for the query (unless multi-model aggregation is enabled)
  if (!multi && (backend === 'gemma' || (!key && backend !== 'google'))) {
    try {
      const qClean = stripHtmlToText(raw).slice(0, 1000)
      const arr = await computeLocalEmbedding([qClean], 'query')
      const vec = Array.isArray(arr) && Array.isArray(arr[0]) ? new Float32Array(arr[0]) : null
      if (!vec || vec.length === 0) return offlineFallback('Local Gemma query embedding is empty.')
      // Full scan: match on dimension equality
      const dbEmb = getEmbDb()
      const backend = 'gemma'
      const firstFieldStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      let qn = 0; for (let i = 0; i < vec.length; i++) qn += vec[i] * vec[i]
      qn = Math.sqrt(qn) || 1
      const rows = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings2 WHERE backend = ? AND model = ? AND dim = ?').all(backend, gemmaModel, vec.length) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
      try { console.log(`[embedSearch.gemma] q_dim=${vec.length} db_rows=${rows?.length ?? 0}`) } catch {}
      if (!rows || rows.length === 0) return offlineFallback('No Gemma document vectors match the query dimension.')
      const scores: Array<{ id: number; s: number }> = []
      for (const r of rows) {
        if (!r.vec) continue
        const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        if (v.length !== vec.length) continue
        let dot = 0
        for (let i = 0; i < vec.length; i++) dot += vec[i] * v[i]
        const cos = dot / (qn * (r.norm || 1))
        scores.push({ id: r.note_id, s: cos })
      }
      scores.sort((a, b) => b.s - a.s)
      const picked = scores.slice(0, Math.max(1, Math.min(100, topK)))
      const mapped = picked.map(({ id, s }) => {
        const row = firstFieldStmt.get(id) as { value_html?: string } | undefined
        return { note_id: id, first_field: row?.value_html ?? null, rerank: s }
      }).filter((r) => frontIsVisible(r.first_field))
      if (!mapped || mapped.length === 0) return offlineFallback('Gemma cosine search returned no candidates.')
      return mapped
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gemma query embedding failed.'
      return offlineFallback(message)
    }
  }

  // Online embed: DeepInfra or Google, with optional multi-model aggregation
  const qClean = stripHtmlToText(raw).slice(0, 1000)
  const inputs: string[] = [qClean]
  let qVec: Float32Array | null = null
  const qVecs: Array<{ backend: 'deepinfra' | 'google' | 'gemma'; model: string; vec: Float32Array; qn: number }> = []
  try {
    const gFetch = async (): Promise<Float32Array | null> => {
      const gkey = getSetting('google_api_key') || process.env.GOOGLE_API_KEY || ''
      if (!gkey) return null
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(googleModel)}:embedContent?key=${encodeURIComponent(gkey)}`
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: { parts: [{ text: qClean }] } }) })
      if (!res.ok) return null
      const j = await res.json()
      const arr = (j?.embedding?.values || j?.embedding || [])
      if (!Array.isArray(arr) || arr.length === 0) return null
      return new Float32Array(arr)
    }
    const diFetch = async (): Promise<Float32Array | null> => {
      if (!key) return null
      const body: any = { model: diModel, input: inputs, encoding_format: 'float' }
      if (Number.isFinite(diDims) && diDims > 0) body.dimensions = diDims
      const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      })
      if (!res.ok) { try { console.warn(`[embedSearch.deepinfra] HTTP ${res.status}`) } catch {}; return null }
      const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
      const emb = Array.isArray(j?.data) && j!.data![0]?.embedding ? j!.data![0].embedding : []
      if (!Array.isArray(emb) || emb.length === 0) { try { console.warn('[embedSearch.deepinfra] empty embedding in response') } catch {}; return null }
      return new Float32Array(emb)
    }
    const gmFetch = async (): Promise<Float32Array | null> => {
      try {
        const arr = await computeLocalEmbedding([qClean], 'query')
        const vec = Array.isArray(arr) && Array.isArray(arr[0]) ? new Float32Array(arr[0]) : null
        if (!vec || vec.length === 0) {
          throw new Error('Gemma query embedding returned empty vector')
        }
        return vec
      } catch (err) {
        try { console.error('[embedSearch.gemma] query embedding error', err) } catch {}
        return null
      }
    }

    if (multi) {
      const enableDi = (getSetting('enable_model_deepinfra') || '1') === '1'
      const enableGg = (getSetting('enable_model_google') || '1') === '1'
      const enableGm = (getSetting('enable_model_gemma') || '1') === '1'
      if (enableDi) {
        const di = await diFetch()
        if (di) { let n = 0; for (let i = 0; i < di.length; i++) n += di[i] * di[i]; qVecs.push({ backend: 'deepinfra', model: diModel, vec: di, qn: Math.sqrt(n) || 1 }) }
      }
      if (enableGg) {
        const gg = await gFetch()
        if (gg) { let n = 0; for (let i = 0; i < gg.length; i++) n += gg[i] * gg[i]; qVecs.push({ backend: 'google', model: googleModel, vec: gg, qn: Math.sqrt(n) || 1 }) }
      }
      if (enableGm) {
        const gm = await gmFetch()
        if (gm) { let n = 0; for (let i = 0; i < gm.length; i++) n += gm[i] * gm[i]; qVecs.push({ backend: 'gemma', model: gemmaModel, vec: gm, qn: Math.sqrt(n) || 1 }) }
      }
      if (qVecs.length === 0) return await offlineFallback('No query embeddings were generated for any enabled backend.')
    } else if (backend === 'google') {
      const gv = await gFetch(); if (!gv) return await offlineFallback('Google query embedding unavailable.'); qVec = gv
    } else {
      const dv = await diFetch(); if (!dv) return await offlineFallback('DeepInfra query embedding unavailable.'); qVec = dv
      try { console.log(`[embedSearch.deepinfra] q_dim=${qVec.length}`) } catch {}
    }
  } catch (err) { return await offlineFallback(err instanceof Error ? err.message : 'Failed generating query embedding.') }

  // HNSW disabled per request. Always use DB cosine scan.
  const useHnsw = false
  const firstFieldStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
  if (!multi && !qVec) return offlineFallback('Query embedding missing after preprocessing.')
  let qn = 0; if (qVec) { for (let i = 0; i < qVec.length; i++) qn += qVec[i] * qVec[i]; qn = Math.sqrt(qn) || 1 }

  if (useHnsw) { /* disabled */ }

  // Full scan fallback: compute cosine against all vectors with matching dimension
  const dbEmb = getEmbDb()
  let picked: Array<{ id: number; s: number; bd?: Array<{ backend: 'deepinfra'|'google'|'gemma'; model: string; cos: number }> }> = []
  if (multi) {
    const agg = new Map<number, { sum: number; cnt: number; bd: Array<{ backend: 'deepinfra'|'google'|'gemma'; model: string; cos: number }> }>()
    const backModels = qVecs
    for (const qm of backModels) {
      const rows = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings2 WHERE backend = ? AND model = ? AND dim = ?').all(qm.backend, qm.model, qm.vec.length) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
      if (!rows || rows.length === 0) continue
      for (const r of rows) {
        if (!r.vec) continue
        const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
        if (vec.length !== qm.vec.length) continue
        let dot = 0
        for (let i = 0; i < qm.vec.length; i++) dot += qm.vec[i] * vec[i]
        const cos = dot / (qm.qn * (r.norm || 1))
        const a = agg.get(r.note_id) || { sum: 0, cnt: 0, bd: [] }
        a.sum += cos; a.cnt += 1; a.bd.push({ backend: qm.backend, model: qm.model, cos })
        agg.set(r.note_id, a)
      }
    }
    const scores: Array<{ id: number; s: number; bd?: Array<{ backend: 'deepinfra'|'google'|'gemma'; model: string; cos: number }> }> = []
    for (const [id, a] of agg.entries()) { if (a.cnt > 0) scores.push({ id, s: a.sum / a.cnt, bd: a.bd }) }
    scores.sort((a, b) => b.s - a.s)
    picked = scores.slice(0, Math.max(1, Math.min(100, topK)))
  } else {
    const backendSel = backend === 'google' ? 'google' : backend === 'gemma' ? 'gemma' : 'deepinfra'
    const modelSel = backendSel === 'google' ? googleModel : backendSel === 'gemma' ? gemmaModel : diModel
    const rows = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings2 WHERE backend = ? AND model = ? AND dim = ?').all(backendSel, modelSel, qVec!.length) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
    try { console.log(`[embedSearch.${backendSel}] db_rows=${rows?.length ?? 0} for dim=${qVec!.length}`) } catch {}
    if (!rows || rows.length === 0) return offlineFallback('No embeddings found for the requested backend/model.')
    const scores: Array<{ id: number; s: number }> = []
    for (const r of rows) {
      if (!r.vec) continue
      const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
      if (vec.length !== qVec!.length) continue
      let dot = 0
      for (let i = 0; i < qVec!.length; i++) dot += qVec![i] * vec[i]
      const cos = dot / (qn * (r.norm || 1))
      scores.push({ id: r.note_id, s: cos })
    }
    scores.sort((a, b) => b.s - a.s)
    picked = scores.slice(0, Math.max(1, Math.min(100, topK)))
  }
  const mapped = picked.map(({ id, s, bd }) => {
    const row = firstFieldStmt.get(id) as { value_html?: string } | undefined
    const out: any = { note_id: id, first_field: row?.value_html ?? null, rerank: s }
    if (multi && Array.isArray(bd)) out.__cos_breakdown__ = bd
    return out
  }).filter((r) => frontIsVisible(r.first_field))
  if (!mapped || mapped.length === 0) return offlineFallback('Cosine scoring produced no ranked results.')
  return mapped
}

// Embedding-based related by selected concept terms with FTS prefilter and RRF
export async function getRelatedByEmbeddingTerms(terms: string[], topK: number = 20): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>> {
  try {
    const backend = getSetting('embedding_backend') || 'deepinfra'
    const key = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
    if (backend === 'gemma' || !key) {
      // Local path: embed each term and aggregate
      const termsClean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim()).filter((t) => t.length > 0) : []
      if (termsClean.length === 0) return []
      const embs = await computeLocalEmbedding(termsClean, 'query')
      if (!Array.isArray(embs) || embs.length === 0) return []
      // BM25+cos aggregation (same as remote path)
      const bm = searchByBm25Terms(termsClean, Math.min(1000, Math.max(200, topK * 20)))
      const candidates = bm.map((r) => r.note_id)
      const dbEmb = getEmbDb()
      const perNoteBest = new Map<number, number>()
      for (const e of embs) {
        const q = new Float32Array(e)
        let qn = 0; for (let i = 0; i < q.length; i++) qn += q[i] * q[i]
        qn = Math.sqrt(qn) || 1
        const rows: Array<{ note_id: number; dim: number; vec: Buffer; norm: number }> = []
        if (candidates.length > 0) {
          const CHUNK = 900
          for (let i = 0; i < candidates.length; i += CHUNK) {
            const ids = candidates.slice(i, i + CHUNK)
            const placeholders = ids.map(() => '?').join(',')
            const part = dbEmb.prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders}) AND dim = ?`).all(...ids, q.length) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
            rows.push(...part)
          }
        } else {
          const iter = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings WHERE dim = ?').iterate(q.length) as any
          for (const r of iter) rows.push(r)
        }
        for (const r of rows) {
          if (!r.vec) continue
          const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
          if (v.length !== q.length) continue
          let dot = 0
          for (let i = 0; i < q.length; i++) dot += q[i] * v[i]
          const cos = dot / (qn * (r.norm || 1))
          perNoteBest.set(r.note_id, Math.max(perNoteBest.get(r.note_id) || -Infinity, cos))
        }
      }
      const stmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      const out: Array<{ note_id: number; first_field: string | null; cos: number }> = []
      for (const [id, cos] of perNoteBest.entries()) {
        const row = stmt.get(id) as { value_html?: string } | undefined
        out.push({ note_id: id, first_field: row?.value_html ?? null, cos })
      }
      out.sort((a, b) => b.cos - a.cos)
      return out.slice(0, topK)
    }
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
