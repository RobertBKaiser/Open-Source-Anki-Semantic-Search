import { getDb } from '../db/core'
import { getSetting } from '../db/settings'
import { stripHtmlToText } from '../utils/text'

export async function extractFrontKeyIdeasLLM(noteId: number, maxItems: number = 10): Promise<string[]> {
  try {
    const apiKey = getSetting('openai_api_key') || process.env.OPENAI_API_KEY || ''
    const promptId = getSetting('openai_kw_prompt_id') || 'pmpt_68b5ad09507c8195999c456bd50afd3809e0e005559ce008'
    if (!apiKey || !promptId) return []
    const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const src = (frontStmt.get(noteId) as { value_html?: string } | undefined)?.value_html || ''
    const text = stripHtmlToText(src)
    if (!text) return []
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ prompt: { id: promptId, version: '1' }, input: text })
    })
    if (!res.ok) return []
    const json = await res.json() as any
    let output = ''
    try {
      output = String(json?.output_text || '')
      if (!output && Array.isArray(json?.output)) {
        const textPieces: string[] = []
        for (const item of json.output) {
          const content = Array.isArray(item?.content) ? item.content : []
          for (const c of content) {
            const t = (c?.text?.value || c?.text || '').toString()
            if (t) textPieces.push(t)
          }
        }
        output = textPieces.join(' ').trim()
      }
    } catch {}
    if (!output) return []
    const parts = output.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
    const uniq: string[] = []
    const seen = new Set<string>()
    for (const p of parts) {
      const key = p.toLowerCase()
      if (!seen.has(key)) { seen.add(key); uniq.push(p) }
      if (uniq.length >= maxItems) break
    }
    return uniq
  } catch { return [] }
}


