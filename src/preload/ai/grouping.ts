import { getDb } from '../db/core'
import { getSetting } from '../db/settings'

export async function groupNotesByAI(noteIds: number[], queryText: string): Promise<Array<{ label: string; notes: number[] }>> {
  try {
    const allIds = Array.isArray(noteIds) ? noteIds.filter((n) => Number.isFinite(Number(n))) : []
    const MAX = 60
    const ids = allIds.slice(0, MAX)
    if (ids.length === 0) return []
    const apiKey = getSetting('openai_api_key') || process.env.OPENAI_API_KEY || ''
    const promptId = 'pmpt_68b5ad09507c8195999c456bd50afd3809e0e005559ce008'
    if (!apiKey || !promptId) return []

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

    const lines: string[] = []
    for (const id of ids) {
      const html = (frontStmt.get(id) as { value_html?: string } | undefined)?.value_html || ''
      const text = strip(html)
      lines.push(`${id}) ${text}`)
    }

    const input = [
      'SEARCH QUERY:',
      String(queryText || ''),
      '',
      'NOTES (numbered by note identifier):',
      ...lines
    ].join('\n')

    const url = 'https://api.openai.com/v1/responses'
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ prompt: { id: promptId }, input }) })
    if (!res.ok) return []
    const raw = await res.json() as any

    const collectText = (j: any): string => {
      try {
        if (typeof j?.output_text === 'string' && j.output_text.trim()) return j.output_text
        const parts: string[] = []
        if (Array.isArray(j?.output)) {
          for (const item of j.output) {
            const contentArr = Array.isArray(item?.content) ? item.content : []
            for (const c of contentArr) {
              const t = (c?.text?.value || c?.text || '').toString()
              if (t) parts.push(t)
            }
          }
        }
        return parts.join(' ').trim()
      } catch { return '' }
    }
    const text = collectText(raw)
    let groups: Array<{ label: string; notes: number[] }> = []
    try {
      const start = text.indexOf('[')
      const end = text.lastIndexOf(']')
      const jsonStr = start >= 0 && end > start ? text.slice(start, end + 1) : text
      const parsed = JSON.parse(jsonStr)
      if (Array.isArray(parsed)) {
        groups = parsed.map((g: any) => ({ label: String(g?.label || ''), notes: Array.isArray(g?.notes) ? g.notes.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n)) : [] }))
      }
    } catch {}
    if (!Array.isArray(groups) || groups.length === 0) return [{ label: 'Other', notes: ids.slice().sort((a, b) => a - b) }]

    const seen = new Set<number>()
    const cleaned: Array<{ label: string; notes: number[] }> = []
    for (const g of groups) {
      const uniqueNotes = Array.from(new Set((g.notes || []).map((n) => Number(n)))).filter((n) => ids.includes(n))
      uniqueNotes.forEach((n) => seen.add(n))
      cleaned.push({ label: String(g.label || '').trim() || 'Other', notes: uniqueNotes.slice().sort((a, b) => a - b) })
    }
    const missing = ids.filter((n) => !seen.has(n))
    if (missing.length > 0) cleaned.push({ label: 'Other', notes: missing.slice().sort((a, b) => a - b) })
    const nonEmpty = cleaned.filter((g) => Array.isArray(g.notes) && g.notes.length > 0)
    nonEmpty.sort((a, b) => a.label.localeCompare(b.label))
    return nonEmpty
  } catch { return [] }
}


