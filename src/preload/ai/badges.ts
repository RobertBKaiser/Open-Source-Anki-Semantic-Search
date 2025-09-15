import { getDb } from '../db/core'
import { getSetting } from '../db/settings'

export async function classifyBadges(noteIds: number[], queryText: string): Promise<Array<{ note_id: number; category: 'in' | 'out' | 'related' | 'unknown'; category_num?: 0 | 1 | 2 | 3 }>> {
  try {
    if (!Array.isArray(noteIds) || noteIds.length === 0) return []
    const apiKey = getSetting('openai_api_key') || process.env.OPENAI_API_KEY || ''
    const promptId = getSetting('openai_badge_prompt_id') || getSetting('openai_badge_prompt_url') || ''
    if (!apiKey || !promptId) {
      return noteIds.map((id) => ({ note_id: id, category: 'unknown' as const }))
    }
    const frontStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    const strip = (html: string): string => String(html || '')
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\[sound:[^\]]+\]/gi, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    const docs = noteIds.map((id) => ({ id, text: strip(((frontStmt.get(id) as { value_html?: string } | undefined)?.value_html) || '') }))
    const url = 'https://api.openai.com/v1/responses'

    const extractSingleDigitFromJson = (jsonStr: string): number | undefined => {
      try {
        const j = JSON.parse(jsonStr)
        const fields: string[] = []
        if (typeof j?.output_text === 'string') fields.push(j.output_text)
        if (typeof j?.text === 'string') fields.push(j.text)
        if (Array.isArray(j?.output)) {
          for (const item of j.output) {
            const contentArr = Array.isArray(item?.content) ? item.content : []
            for (const c of contentArr) {
              const t = (c?.text?.value || c?.text || '').toString()
              if (t) fields.push(t)
            }
          }
        }
        for (const f of fields) {
          const d = extractSingleDigit(f)
          if (typeof d === 'number') return d
        }
      } catch {}
      return undefined
    }
    const extractSingleDigit = (s: string): number | undefined => {
      const sent = /BEGIN_DIGITS\s*<\s*([0-3])\s*>\s*END_DIGITS/i.exec(s)
      if (sent && sent[1]) return Number(sent[1])
      const m = /\b([0-3])\b/.exec(s)
      return m ? Number(m[1]) : undefined
    }

    const CONCURRENCY = 5
    let idx = 0
    const resultsNum: Array<number | undefined> = new Array(docs.length).fill(undefined)
    async function worker(): Promise<void> {
      while (true) {
        const i = idx
        if (i >= docs.length) return
        idx++
        const d = docs[i]
        const input = [
          'QUERY:',
          String(queryText || ''),
          '',
          'CARD:',
          `id=${d.id} ${d.text}`,
          '',
          'OUTPUT FORMAT:',
          'Return ONLY one integer in [0,3]. Example: 1',
          'Additionally, include the same value between markers as: BEGIN_DIGITS <d> END_DIGITS',
          'No extra text.'
        ].join('\n')
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ prompt: { id: promptId }, input }) })
          if (!res.ok) continue
          const raw = await res.text()
          let digit = extractSingleDigitFromJson(raw)
          if (typeof digit !== 'number') digit = extractSingleDigit(raw)
          resultsNum[i] = typeof digit === 'number' ? Math.max(0, Math.min(3, digit)) : undefined
        } catch {}
      }
    }
    await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()))

    const byId = new Map<number, { category?: 'in' | 'out' | 'related' | 'unknown'; category_num?: 0 | 1 | 2 | 3 }>()
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]
      const num = resultsNum[i]
      const mapped: { category?: 'in' | 'out' | 'related' | 'unknown'; category_num?: 0 | 1 | 2 | 3 } = {}
      if (typeof num === 'number') mapped.category_num = num as 0 | 1 | 2 | 3
      byId.set(d.id, mapped)
    }
    return noteIds.map((id) => {
      const v = byId.get(id)
      if (!v) return { note_id: id, category: 'unknown' as const }
      const cat: 'in' | 'out' | 'related' | 'unknown' = v.category || 'unknown'
      return { note_id: id, category: cat, category_num: v.category_num }
    })
  } catch { return noteIds.map((id) => ({ note_id: id, category: 'unknown' as const })) }
}


