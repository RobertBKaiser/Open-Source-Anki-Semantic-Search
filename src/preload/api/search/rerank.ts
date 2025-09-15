import { getSetting } from '../../db/settings'
import { getDb } from '../../db/core'
import { fuzzySearch } from './fuzzy'
import { embedSearch } from './embed'

export async function semanticRerank(query: string, limit = 100): Promise<Array<{ note_id: number; first_field: string | null; bm25?: number; trigrams?: number; combined: number; rrf: number; where?: 'front' | 'back' | 'both'; rerank?: number }>> {
  const q = String(query || '').trim()
  if (!q) return []
  const defaultInstruction = 'Given a search query, retrieve relevant anki cards.'
  const instruction = getSetting('deepinfra_instruction') || defaultInstruction
  const apiKey = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN || ''
  const url = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-8B'

  const MAX_BM25 = 100
  const MAX_EMB = 100
  const allFuzzy = fuzzySearch(q, Math.max(limit, 400))
  const fallbackList = allFuzzy.length === 0 ? listNotes(limit, 0) : []
  const withBm = (allFuzzy.length ? allFuzzy : fallbackList).filter((c: any) => typeof c.bm25 === 'number') as any[]
  const bmTop = withBm.sort((a, b) => (a.bm25 as number) - (b.bm25 as number)).slice(0, MAX_BM25)
  let embTop: Array<{ note_id: number; first_field: string | null; rerank: number }> = []
  try { embTop = await embedSearch(q, MAX_EMB) } catch {}

  const chosenIds = new Set<number>()
  bmTop.forEach((c: any) => chosenIds.add(c.note_id))
  embTop.forEach((e: any) => chosenIds.add(e.note_id))
  const fuzzyById = new Map<number, any>()
  for (const c of allFuzzy) fuzzyById.set(c.note_id, c)

  const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
  const strip = (html: string): string => html
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[sound:[^\]]+\]/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  const chosen: Array<{ id: number; text: string; first: string | null }> = []
  chosenIds.forEach((id) => {
    const f = fuzzyById.get(id)
    const html = (f?.first_field as string | null) ?? ((frontStmt.get(id) as { value_html?: string } | undefined)?.value_html ?? null)
    const text = strip(String(html || ''))
    if (text) chosen.push({ id, text, first: html })
  })
  if (chosen.length === 0) return allFuzzy as any

  const MAX_RERANK = 200
  const docs = chosen.slice(0, MAX_RERANK)
  const documents = docs.map((c) => c.text)
  const queries = documents.map(() => q)

  if (!apiKey) {
    const head = docs.map((d) => {
      const f = fuzzyById.get(d.id)
      return { note_id: d.id, first_field: d.first, bm25: f?.bm25, trigrams: f?.trigrams, combined: f?.rrf ?? 0, rrf: f?.rrf ?? 0, where: f?.where, rerank: 0 }
    })
    const tail = allFuzzy.filter((c) => !chosenIds.has(c.note_id))
    const tailSorted = tail.slice().sort((a, b) => {
      const ab = typeof a.bm25 === 'number' ? a.bm25 : Number.POSITIVE_INFINITY
      const bb = typeof b.bm25 === 'number' ? b.bm25 : Number.POSITIVE_INFINITY
      return ab - bb
    })
    return head.concat(tailSorted as any)
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ queries, documents, instruction }) })
    if (!res.ok) return allFuzzy as any
    const json = (await res.json()) as { scores: number[] }
    const scores = Array.isArray(json?.scores) ? json.scores : []
    const headScored = docs.map((d, i) => {
      const f = fuzzyById.get(d.id)
      const r = Number.isFinite(scores[i]) ? (scores[i] as number) : -Infinity
      return { note_id: d.id, first_field: d.first, bm25: f?.bm25, trigrams: f?.trigrams, combined: f?.rrf ?? 0, rrf: f?.rrf ?? 0, where: f?.where, rerank: r }
    })
    const headSorted = headScored.sort((a, b) => (b.rerank ?? -Infinity) - (a.rerank ?? -Infinity))
    const tail = allFuzzy.filter((c) => !docs.some((d) => d.id === c.note_id))
    const tailSorted = tail.slice().sort((a, b) => {
      const ab = typeof a.bm25 === 'number' ? a.bm25 : Number.POSITIVE_INFINITY
      const bb = typeof b.bm25 === 'number' ? b.bm25 : Number.POSITIVE_INFINITY
      return ab - bb
    })
    return headSorted.concat(tailSorted as any)
  } catch { return allFuzzy as any }
}

function listNotes(limit = 200, offset = 0): Array<{ note_id: number; first_field: string | null }>{
  const stmt = getDb().prepare(
    `SELECT n.note_id,
            (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
       FROM notes n
      ORDER BY n.note_id DESC
      LIMIT ? OFFSET ?`
  )
  return stmt.all(limit, offset)
}

export async function semanticRerankSmall(query: string): Promise<Array<{ note_id: number; first_field: string | null; rerank?: number }>> {
  const q = String(query || '').trim()
  if (!q) return []
  const BM25_TOP = 5
  const EMBED_TOP = 5
  let fuzzy = fuzzySearch(q, 200)
  const withBm = fuzzy.filter((c: any) => typeof c.bm25 === 'number') as any[]
  const bmTop = withBm.sort((a, b) => (a.bm25 as number) - (b.bm25 as number)).slice(0, BM25_TOP)
  let embedTop: Array<{ note_id: number; first_field: string | null; rerank: number }> = []
  try { embedTop = await embedSearch(q, EMBED_TOP) } catch {}
  const chosenIds = new Set<number>()
  bmTop.forEach((c: any) => chosenIds.add(c.note_id))
  embedTop.forEach((e: any) => chosenIds.add(e.note_id))
  if (chosenIds.size === 0) return []
  const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
  const strip = (html: string): string => html
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[sound:[^\]]+\]/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  const chosen: Array<{ id: number; text: string; first: string | null }> = []
  chosenIds.forEach((id) => {
    const inF = fuzzy.find((c: any) => c.note_id === id)
    const html = (inF?.first_field as string | null) ?? ((frontStmt.get(id) as { value_html?: string } | undefined)?.value_html ?? null)
    const text = strip(String(html || ''))
    if (text) chosen.push({ id, text, first: html })
  })
  if (chosen.length === 0) return []
  const documents = chosen.map((c) => c.text)
  const queries = documents.map(() => q)
  const instruction = getSetting('deepinfra_instruction') || 'Given a search query, retrieve relevant anki cards.'
  const apiKey = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN || ''
  const url = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-8B'
  try {
    if (!apiKey) return chosen.map((c) => ({ note_id: c.id, first_field: c.first, rerank: 0 }))
    const headersSmall: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headersSmall.Authorization = `Bearer ${apiKey}`
    const res = await fetch(url, { method: 'POST', headers: headersSmall, body: JSON.stringify({ queries, documents, instruction }) })
    if (!res.ok) return chosen.map((c) => ({ note_id: c.id, first_field: c.first, rerank: 0 }))
    const json = (await res.json()) as { scores: number[] }
    const scores = Array.isArray(json?.scores) ? json.scores : []
    const out = chosen.map((c, i) => ({ note_id: c.id, first_field: c.first, rerank: Number(scores[i] || 0) }))
    return out.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0))
  } catch { return chosen.map((c) => ({ note_id: c.id, first_field: c.first, rerank: 0 })) }
}


