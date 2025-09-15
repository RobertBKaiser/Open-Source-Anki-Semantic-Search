import { extractQueryKeywords } from '../../keywords/extract'
import { embedSearch, getRelatedByEmbedding } from './embed'
import { searchBm25 } from '../../search/bm25'
import { getDb } from '../../db/core'
import { getBackFieldsForIds } from '../../db/fields'
import { getQueryEmbeddingCached } from '../../utils/cache'

export async function hybridSemanticModulated(query: string, limit: number = 200): Promise<Array<{ note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number; matched?: number }>> {
  const q = String(query || '').trim()
  if (!q) return []
  const terms = extractQueryKeywords(q)

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
  const bm25ToPercent = (bm25: number, matched: number): number => {
    const s = Math.max(0, -Number(bm25 || 0))
    const tau = 9.0
    const baseAmp = 0.60
    const s0 = 18.0
    const k = 0.45
    const gate = 1 / (1 + Math.exp(-k * (s - s0)))
    const base = baseAmp * (1 - Math.exp(-s / tau))
    const bonus = 0.03 * (1 - Math.exp(-Math.max(0, matched - 1) / 2.0))
    const raw = Math.max(0, base - 0.02 + bonus)
    const pct = Math.min(0.65, raw * gate)
    return pct
  }
  const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-9, e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  const penaltyFactor = (bm25: number, cos: number): number => {
    const s = Math.max(0, -Number(bm25 || 0))
    const pLow = 1 - smoothstep(7.0, 11.0, s)
    const pHeavy = pLow * pLow
    const pModest = Math.max(0, pLow - pHeavy)
    const gateCos = 1 - smoothstep(0.5, 0.6, Math.max(0, Math.min(1, cos)))
    const H = 0.35, M = 0.15
    const reduce = (H * pHeavy + M * pModest) * gateCos
    return Math.max(0, Math.min(1, 1 - reduce))
  }
  const modulated = (cos: number, bm25: number, matched: number): number => {
    const cosn = clamp01(Number(cos || 0))
    const F = penaltyFactor(bm25, cosn)
    const cosAdj = cosn * F
    const bmPct = bm25ToPercent(bm25, matched)
    return cosAdj + bmPct * (1 - cosAdj)
  }

  const EMB_CAND = Math.min(200, Math.max(60, Math.floor(limit * 2)))
  const BM_CAND = Math.min(800, Math.max(200, Math.floor(limit * 8)))
  let emb: Array<{ note_id: number; first_field: string | null; rerank: number }> = []
  try { emb = await embedSearch(q, EMB_CAND) } catch { emb = [] }

  let bm: Array<{ note_id: number; first_field: string | null; bm25: number }> = []
  try {
    const dbMain = getDb()
    const tokens = String(q || '')
      .toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w && w.length >= 2)
    const uniq: string[] = []
    const seen = new Set<string>()
    for (const w of tokens) { if (!seen.has(w)) { seen.add(w); uniq.push(w) } }
    const capped = uniq.slice(0, 64)
    if (capped.length > 0) {
      const expr = capped.map((t) => `"${t}"`).join(' OR ')
      const raw = searchBm25(dbMain as any, expr, Math.max(1000, BM_CAND * 2))
      const firstField = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
      bm = raw.slice(0, BM_CAND).map((h) => {
        const row = firstField.get(h.note_id) as { value_html?: string } | undefined
        return { note_id: h.note_id, first_field: row?.value_html ?? null, bm25: Number(h.score) }
      })
    }
  } catch { bm = [] }

  type Cand = { id: number; first: string | null; cos?: number; bm25?: number }
  const byId: Map<number, Cand> = new Map()
  for (const r of emb || []) {
    const e = byId.get(r.note_id) || { id: r.note_id, first: r.first_field ?? null }
    const cos = Number(r.rerank || 0)
    e.cos = Math.max(e.cos ?? -Infinity, cos)
    byId.set(r.note_id, e)
  }
  for (const r of bm || []) {
    const e = byId.get(r.note_id) || { id: r.note_id, first: r.first_field ?? null }
    const s = Number(r.bm25 || 0)
    e.bm25 = Math.min(e.bm25 ?? Number.POSITIVE_INFINITY, s)
    byId.set(r.note_id, e)
  }
  if (byId.size === 0) return []

  const matchCount = (first: string | null, back: string | null, terms: string[]): number => {
    const f = String(first || '').toLowerCase()
    const b = String(back || '').toLowerCase()
    let c = 0
    for (const t of terms) {
      const q = String(t || '').toLowerCase()
      if (!q) continue
      if (f.includes(q) || b.includes(q)) c++
    }
    return c
  }

  try {
    const needCos: number[] = []
    for (const e of byId.values()) if (typeof e.cos !== 'number') needCos.push(e.id)
    const qv = await getQueryEmbeddingCached(q)
    if (needCos.length > 0 && qv) {
      let qn = 0; for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i]
      qn = Math.sqrt(qn) || 1
      const dbEmb = require('../../embeddings/core') as any
      const getEmbDb = (dbEmb.getEmbDb as () => any)
      const embDb = getEmbDb()
      const CHUNK = 900
      for (let i = 0; i < needCos.length; i += CHUNK) {
        const ids = needCos.slice(i, i + CHUNK)
        const placeholders = ids.map(() => '?').join(',')
        const rows = embDb.prepare(`SELECT note_id, dim, vec, norm FROM embeddings WHERE note_id IN (${placeholders})`).all(...ids) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
        for (const r of rows) {
          if (!r.vec || r.dim !== qv.length) continue
          const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
          let dot = 0; for (let k = 0; k < qv.length; k++) dot += qv[k] * v[k]
          const cos = dot / (qn * (r.norm || 1))
          const e = byId.get(r.note_id); if (e) e.cos = cos
        }
      }
    }
  } catch {}

  const out: Array<{ note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number; matched?: number }> = []
  const allIds = Array.from(byId.keys())
  const backBy = getBackFieldsForIds(allIds)
  for (const e of byId.values()) {
    const back = backBy.get(e.id) ?? null
    const matched = matchCount(e.first || null, back, terms)
    const cos = typeof e.cos === 'number' ? e.cos : 0
    const bm25 = Number(e.bm25 ?? 0)
    const score = modulated(cos, bm25, matched)
    const payload: any = { note_id: e.id, first_field: e.first ?? null, score, bm25, matched }
    // Always include cos and bm25 for UI tooltips; use 0 when missing
    payload.cos = typeof e.cos === 'number' ? e.cos : 0
    out.push(payload)
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, Math.max(1, limit))
}

export async function hybridSemanticModulatedFromNote(noteId: number, limit: number = 200): Promise<Array<{ note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number; matched?: number }>> {
  try {
    const dbMain = getDb()
    const frontStmt = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
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
    if (!text) return []
    const terms = extractQueryKeywords(text)

    const EMB_CAND = Math.min(200, Math.max(60, Math.floor(limit * 2)))
    const BM_CAND = Math.min(800, Math.max(200, Math.floor(limit * 8)))

    // Use precomputed vector for the source note; avoid external embedding calls
    let emb: Array<{ note_id: number; first_field: string | null; rerank: number }> = []
    try {
      const rel = await getRelatedByEmbedding(noteId, 0.0, EMB_CAND)
      emb = rel.map((r) => ({ note_id: r.note_id, first_field: r.first_field, rerank: r.cos }))
    } catch { emb = [] }

    let bm: Array<{ note_id: number; first_field: string | null; bm25: number }> = []
    try {
      const tokens = String(text || '').toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w && w.length >= 2)
      const uniq: string[] = []
      const seen = new Set<string>()
      for (const w of tokens) { if (!seen.has(w)) { seen.add(w); uniq.push(w) } }
      const capped = uniq.slice(0, 64)
      if (capped.length > 0) {
        const expr = capped.map((t) => `"${t}"`).join(' OR ')
        const raw = searchBm25(dbMain as any, expr, Math.max(1000, BM_CAND * 2))
        const firstField = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
        bm = raw.slice(0, BM_CAND).map((h) => {
          const row = firstField.get(h.note_id) as { value_html?: string } | undefined
          return { note_id: h.note_id, first_field: row?.value_html ?? null, bm25: Number(h.score) }
        })
      }
    } catch { bm = [] }

    type Cand = { id: number; first: string | null; cos?: number; bm25?: number }
    const byId: Map<number, Cand> = new Map()
    for (const r of emb || []) {
      const e = byId.get(r.note_id) || { id: r.note_id, first: r.first_field ?? null }
      const cos = Number(r.rerank || 0)
      e.cos = Math.max(e.cos ?? -Infinity, cos)
      byId.set(r.note_id, e)
    }
    for (const r of bm || []) {
      const e = byId.get(r.note_id) || { id: r.note_id, first: r.first_field ?? null }
      const s = Number(r.bm25 || 0)
      e.bm25 = Math.min(e.bm25 ?? Number.POSITIVE_INFINITY, s)
      byId.set(r.note_id, e)
    }
    if (byId.size === 0) return []

    // Cosines already computed from precomputed vector above; keep fallback minimal

    const bm25ToPercent = (bm25: number, matched: number): number => {
      const s = Math.max(0, -Number(bm25 || 0))
      const tau = 9.0
      const baseAmp = 0.60
      const s0 = 18.0
      const k = 0.45
      const gate = 1 / (1 + Math.exp(-k * (s - s0)))
      const base = baseAmp * (1 - Math.exp(-s / tau))
      const bonus = 0.03 * (1 - Math.exp(-Math.max(0, matched - 1) / 2.0))
      const raw = Math.max(0, base - 0.02 + bonus)
      const pct = Math.min(0.65, raw * gate)
      return pct
    }
    const smoothstep = (e0: number, e1: number, x: number): number => {
      const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-9, e1 - e0)))
      return t * t * (3 - 2 * t)
    }
    const penaltyFactor = (bm25: number, cos: number): number => {
      const s = Math.max(0, -Number(bm25 || 0))
      const pLow = 1 - smoothstep(7.0, 11.0, s)
      const pHeavy = pLow * pLow
      const pModest = Math.max(0, pLow - pHeavy)
      const gateCos = 1 - smoothstep(0.5, 0.6, Math.max(0, Math.min(1, cos)))
      const H = 0.35, M = 0.15
      const reduce = (H * pHeavy + M * pModest) * gateCos
      return Math.max(0, Math.min(1, 1 - reduce))
    }
    const modulated = (cos: number, bm25: number, matched: number): number => {
      const cosn = Math.max(0, Math.min(1, Number(cos || 0)))
      const F = penaltyFactor(bm25, cosn)
      const cosAdj = cosn * F
      const bmPct = bm25ToPercent(bm25, matched)
      return cosAdj + bmPct * (1 - cosAdj)
    }

    const backStmt = dbMain.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord DESC LIMIT 1')
    const matchCount = (first: string | null, back: string | null, terms: string[]): number => {
      const f = String(first || '').toLowerCase()
      const b = String(back || '').toLowerCase()
      let c = 0
      for (const t of terms) { const q = String(t || '').toLowerCase(); if (q && (f.includes(q) || b.includes(q))) c++ }
      return c
    }

    const out: Array<{ note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number; matched?: number }> = []
    for (const e of byId.values()) {
      const back = (backStmt.get(e.id) as { value_html?: string } | undefined)?.value_html ?? null
      const matched = matchCount(e.first || null, back, terms)
      const cos = typeof e.cos === 'number' ? e.cos : 0
      const bm25 = Number(e.bm25 ?? 0)
      const score = modulated(cos, bm25, matched)
      const payload: any = { note_id: e.id, first_field: e.first ?? null, score, bm25, matched }
      payload.cos = typeof e.cos === 'number' ? e.cos : 0
      out.push(payload)
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, Math.max(1, limit))
  } catch { return [] }
}


