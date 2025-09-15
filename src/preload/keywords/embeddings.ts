import { getSetting } from '../db/settings'
import { getEmbDb } from '../embeddings/core'

export async function getKeywordEmbeddings(terms: string[]): Promise<Array<{ term: string; vec: Float32Array }>> {
  const key = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
  const model = getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
  const dims = Number(getSetting('deepinfra_embed_dims') || '4096')
  const dbEmb = getEmbDb()
  const clean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean) : []
  if (clean.length === 0) return []
  const out: Array<{ term: string; vec: Float32Array }> = []
  const need: string[] = []
  const sel = dbEmb.prepare('SELECT term, dim, vec FROM keyword_embeddings WHERE term = ?')
  for (const t of clean) {
    const r = sel.get(t) as { term?: string; dim?: number; vec?: Buffer } | undefined
    if (r && r.vec && r.dim === dims) out.push({ term: t, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4) })
    else need.push(t)
  }
  if (need.length > 0 && key) {
    const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, input: need, encoding_format: 'float', dimensions: dims })
    })
    if (res.ok) {
      const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
      const data = Array.isArray(j?.data) ? j!.data! : []
      const ins = dbEmb.prepare('INSERT INTO keyword_embeddings(term, dim, vec, norm, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(term) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, norm=excluded.norm, updated_at=excluded.updated_at')
      for (let i = 0; i < need.length; i++) {
        const t = need[i]
        const emb = data[i]?.embedding || []
        const arr = new Float32Array(emb)
        let norm = 0
        for (let k = 0; k < arr.length; k++) norm += arr[k] * arr[k]
        norm = Math.sqrt(norm) || 1
        ins.run(t, dims, Buffer.from(arr.buffer), norm, Date.now())
        out.push({ term: t, vec: arr })
      }
    }
  }
  return out
}

export async function clusterKeywords(terms: string[], threshold: number = 0.85): Promise<Map<string, string>> {
  const embs = await getKeywordEmbeddings(terms)
  const by = new Map(embs.map((e) => [e.term, e.vec]))
  const repBy = new Map<string, string>()
  for (const t of terms.map((x) => String(x || '').toLowerCase())) {
    if (repBy.has(t)) continue
    const v = by.get(t)
    if (!v) { repBy.set(t, t); continue }
    repBy.set(t, t)
    const vnorm = (() => { let s=0; for (let i=0;i<v.length;i++) s+=v[i]*v[i]; return Math.sqrt(s)||1 })()
    for (const [uTerm, uVec] of by) {
      if (repBy.has(uTerm)) continue
      let dot = 0, un=0
      for (let i=0;i<v.length && i<uVec.length;i++) dot += v[i]*uVec[i]
      for (let i=0;i<uVec.length;i++) un += uVec[i]*uVec[i]
      const cos = dot / (vnorm * (Math.sqrt(un)||1))
      if (cos >= threshold) repBy.set(uTerm, t)
    }
  }
  return repBy
}

export async function cosineForTerms(terms: string[], query: string): Promise<Array<{ term: string; cos: number }>> {
  try {
    const cleanTerms = Array.isArray(terms) ? terms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean) : []
    const q = String(query || '').trim().toLowerCase()
    if (!q || cleanTerms.length === 0) return []
    const embs = await getKeywordEmbeddings([...cleanTerms, q])
    const by = new Map(embs.map((e) => [e.term, e.vec]))
    const qv = by.get(q)
    if (!qv) return []
    let qn = 0
    for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i]
    qn = Math.sqrt(qn) || 1
    const out: Array<{ term: string; cos: number }> = []
    for (const t of cleanTerms) {
      const v = by.get(t)
      if (!v) { out.push({ term: t, cos: -1 }) ; continue }
      let dot = 0, vn = 0
      for (let i = 0; i < v.length; i++) { dot += (v[i] || 0) * (qv[i] || 0); vn += v[i] * v[i] }
      const cos = dot / (qn * (Math.sqrt(vn) || 1))
      out.push({ term: t, cos })
    }
    return out
  } catch { return [] }
}

export async function embedCosForTermAgainstNotes(term: string, noteIds: number[]): Promise<Array<{ note_id: number; cos: number }>> {
  try {
    const ids = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
    if (!term || ids.length === 0) return []
    const embs = await getKeywordEmbeddings([String(term).toLowerCase()])
    const vec = embs[0]?.vec
    if (!vec) return []
    let qnorm = 0
    for (let i = 0; i < vec.length; i++) qnorm += vec[i] * vec[i]
    qnorm = Math.sqrt(qnorm) || 1
    const dbEmb = getEmbDb()
    const placeholders = ids.map(() => '?').join(',')
    const rows = dbEmb
      .prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`)
      .all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
    const out: Array<{ note_id: number; cos: number }> = []
    for (const r of rows) {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
      if (v.length !== vec.length) { out.push({ note_id: r.note_id, cos: -1 }); continue }
      let dot = 0
      for (let i = 0; i < vec.length; i++) dot += vec[i] * v[i]
      const cos = dot / (qnorm * (r.norm || 1))
      out.push({ note_id: r.note_id, cos })
    }
    return out
  } catch { return [] }
}

export async function embedCosForTermsComboAgainstNotes(terms: string[], noteIds: number[]): Promise<Array<{ note_id: number; cos: number }>> {
  try {
    const ids = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
    const clean = Array.isArray(terms) ? terms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean) : []
    if (clean.length < 2 || clean.length > 3 || ids.length === 0) return []
    const embs = await getKeywordEmbeddings(clean)
    if (embs.length !== clean.length) return []
    const dims = embs[0].vec.length
    const mean = new Float32Array(dims)
    for (const e of embs) { for (let i = 0; i < dims; i++) mean[i] += e.vec[i] }
    for (let i = 0; i < dims; i++) mean[i] /= clean.length
    let qnorm = 0
    for (let i = 0; i < dims; i++) qnorm += mean[i] * mean[i]
    qnorm = Math.sqrt(qnorm) || 1
    const dbEmb = getEmbDb()
    const placeholders = ids.map(() => '?').join(',')
    const rows = dbEmb
      .prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`)
      .all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
    const out: Array<{ note_id: number; cos: number }> = []
    for (const r of rows) {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
      if (v.length !== dims) { out.push({ note_id: r.note_id, cos: -1 }); continue }
      let dot = 0
      for (let i = 0; i < dims; i++) dot += mean[i] * v[i]
      const cos = dot / (qnorm * (r.norm || 1))
      out.push({ note_id: r.note_id, cos })
    }
    return out
  } catch { return [] }
}


