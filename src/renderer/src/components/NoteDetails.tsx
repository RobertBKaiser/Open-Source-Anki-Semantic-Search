import React from 'react'
import renderMathInElement from 'katex/contrib/auto-render/auto-render'
import 'katex/dist/katex.min.css'

type Field = { field_name: string; value_html: string; ord: number | null }

type NoteDetailsData = {
  note: { note_id: number; model_name: string; mod: number | null }
  fields: Field[]
  tags: string[]
}

type NoteDetailsProps = {
  data: NoteDetailsData | null
}

const MEDIA_DIR = '/Users/buckykaiser/Library/Application Support/Anki2/Omniscience/collection.media'

function rewriteMediaHtml(html: string): string {
  let out = html
  const toFileUrl = (rel: string): string => `file://${encodeURI(`${MEDIA_DIR}/${rel}`)}`
  // Helper to rewrite generic src attributes (supports single/double/no quotes)
  const rewriteTagSrc = (tag: string) => {
    const re = new RegExp(`<${tag}([^>]*?)src=(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))([^>]*)>`, 'gi')
    out = out.replace(re, (_m, pre: string, dq?: string, sq?: string, bare?: string, post?: string) => {
      const src = dq || sq || bare || ''
      const s = /^(?:https?:|file:|data:|blob:)/i.test(src) ? src : toFileUrl(src)
      const isVideo = tag.toLowerCase() === 'video'
      const needsControls = /(audio|video)/i.test(tag) && !/controls/i.test(String(pre) + String(post))
      const hasStyle = /style=/i.test(String(pre) + String(post))
      const style = isVideo ? ' style=\"max-width:100%\"' : ''
      const ctrl = needsControls ? ' controls' : ''
      return `<${tag}${pre}src=\"${s}\"${post}${hasStyle ? '' : style}${ctrl}>`
    })
  }
  // Replace <img>, <audio>, <video>
  rewriteTagSrc('img')
  rewriteTagSrc('audio')
  rewriteTagSrc('video')
  // Replace <source src=...>
  out = out.replace(/<source([^>]*?)src=(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))([^>]*?)>/gi, (_m, pre: string, dq?: string, sq?: string, bare?: string, post?: string) => {
    const src = dq || sq || bare || ''
    const s = /^(?:https?:|file:|data:|blob:)/i.test(src) ? src : toFileUrl(src)
    return `<source${pre}src=\"${s}\"${post}>`
  })
  // Replace <audio> and <video> src and nested <source>
  // (handled by rewriteTagSrc and source rewrite)
  // Convert [sound:...] to audio or video based on file extension
  out = out.replace(/\[sound:([^\]]+)\]/g, (_m, file) => {
    const s = toFileUrl(file)
    const lower = String(file).toLowerCase()
    const isVideo = /\.(mp4|m4v|webm|mov|avi)$/i.test(lower)
    if (isVideo) return `<video controls src=\"${s}\" style=\"max-width:100%\"></video>`
    return `<audio controls src=\"${s}\"></audio>`
  })
  return out
}

function HtmlWithMath({ html }: { html: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = rewriteMediaHtml(html)
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
        trust: true,
      })
    } catch {}
  }, [html])
  return <div ref={ref} />
}

// Helpers to colorize clozes like in the note list
function hasVisibleContent(html: string): boolean {
  if (!html) return false
  const hasMedia = /<img\b|<video\b|<audio\b|\[sound:[^\]]+\]/i.test(html)
  if (hasMedia) return true
  const text = cleanText(html)
  return text.length > 0
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripHtml(input: string): string {
  return input.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, '')
}

function cleanText(input: string): string {
  const decoded = decodeEntities(stripHtml(input))
  const noMustache = decoded.replace(/\{\{[^}]+\}\}/g, '')
  return noMustache.replace(/\s+/g, ' ').trim()
}

function getClozeColor(n: number): string {
  const colors = ['#9b5de5', '#3a86ff', '#00c853', '#ff8f00', '#00e5ff', '#ff006e']
  return colors[(n - 1) % colors.length]
}

function renderFieldPreview(value: string | null): React.ReactNode {
  if (!value) return null
  let source = value
    .replace(/<img [^>]*src="[^"]+"[^>]*>/gi, '🖼️')
    .replace(/\[sound:[^\]]+\]/gi, '🔊')

  const parts: React.ReactNode[] = []
  const pushPart = (node: React.ReactNode) => { if (parts.length > 0) parts.push(' '); parts.push(node) }
  let lastIndex = 0
  const regex = /\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    const start = match.index
    const full = match[0]
    const num = Number(match[1])
    const inner = match[2] || ''
    if (start > lastIndex) {
      const plain = source.slice(lastIndex, start)
      const cleaned = cleanText(plain)
      if (cleaned) pushPart(cleaned)
    }
    const colored = cleanText(inner)
    if (colored) {
      pushPart(
        <span key={`c-${start}`} style={{ color: getClozeColor(num), fontWeight: 600 }}>
          {colored}
        </span>
      )
    }
    lastIndex = start + full.length
  }
  if (lastIndex < source.length) {
    const tail = cleanText(source.slice(lastIndex))
    if (tail) pushPart(tail)
  }
  if (parts.length === 0) return cleanText(source)
  return parts
}

export function NoteDetails({ data }: NoteDetailsProps): React.JSX.Element {
  if (!data) return <div className="p-4 text-sm text-muted-foreground">Select a note to view details.</div>
  const { note, fields, tags } = data
  // rerank scores removed; classification now comes from OpenAI badge service
  return (
    <div className="min-h-0 h-full overflow-y-auto p-4 space-y-4">
      <div className="space-y-2">
        {fields.filter((f) => hasVisibleContent(f.value_html)).map((f) => (
          <div key={f.field_name} className="border rounded-md p-3">
            <div className="font-medium mb-2">{f.field_name}</div>
            <HtmlWithMath html={f.value_html} />
          </div>
        ))}
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <div>ID: {note.note_id}</div>
        <div>Model: {note.model_name}</div>
        <div>Last Modified: {note.mod ? new Date(note.mod * 1000).toLocaleString() : '—'}</div>
        <div>Tags: {tags.join(', ') || '—'}</div>
        {/* Rerank bars removed since category now comes from OpenAI badge classification. */}
        {false && (() => {
          const vin = 0
          const vout = 0
          const vrel = 0
          const max = Math.max(vin, vout, vrel, 1)
          const pct = (v: number) => Math.max(0, Math.min(100, Math.round((v / max) * 100)))
          const barCls = 'h-3 rounded'
          const trackCls = 'w-32 h-3 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden'
          return (
            <div className="mt-2 space-y-2">
              <div className="text-[11px] font-medium">Rerank scores</div>
              <div className="flex items-center gap-3">
                <div className={trackCls}>
                  <div className={barCls} style={{ width: `${pct(vin)}%`, backgroundColor: '#ff3b30' }} />
                </div>
                <div className={trackCls}>
                  <div className={barCls} style={{ width: `${pct(vout)}%`, backgroundColor: '#000000' }} />
                </div>
                <div className={trackCls}>
                  <div className={barCls} style={{ width: `${pct(vrel)}%`, backgroundColor: '#3b82f6' }} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 text-[11px]">
                <div className="flex items-center justify-between"><span>Facts in</span><span>{vin.toFixed(3)}</span></div>
                <div className="flex items-center justify-between"><span>Not in</span><span>{vout.toFixed(3)}</span></div>
                <div className="flex items-center justify-between"><span>Related</span><span>{vrel.toFixed(3)}</span></div>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Related notes by BM25 similarity with concept filters */}
      <RelatedByBm25 noteId={note.note_id} />
    </div>
  )
}

function RelatedByBm25({ noteId }: { noteId: number }): React.JSX.Element | null {
  const [items, setItems] = React.useState<Array<{ note_id: number; first_field: string | null; score: number; metric: 'bm25' | 'cos' | 'hyb' }>>([])
  const [loading, setLoading] = React.useState<boolean>(true)
  const [concepts, setConcepts] = React.useState<string[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [mode, setMode] = React.useState<'bm25' | 'semantic' | 'hybrid'>('hybrid')
  const [noteSel, setNoteSel] = React.useState<Set<number>>(new Set())
  const [detailId, setDetailId] = React.useState<number | null>(null)

  React.useEffect(() => {
    let alive = true
    try {
      const ks = (window as any).api?.getTopKeywordsForNote?.(noteId, 8) || []
      if (alive) setConcepts(ks)
    } catch {
      if (alive) setConcepts([])
    }
    return () => { alive = false }
  }, [noteId])

  const reload = React.useCallback(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        const terms = Array.from(selected)
        if (mode === 'bm25') {
          const res = (window as any).api?.getRelatedByBm25?.(noteId, 20, terms.length ? terms : undefined) || []
          if (alive) setItems(res.map((r: any) => ({ note_id: r.note_id, first_field: r.first_field, score: Number(r.bm25 || 0), metric: 'bm25' })))
        } else if (mode === 'semantic') {
          // Semantic: if terms selected, use embedding terms; else use note embedding
          if (terms.length > 0) {
            const er = (await (window as any).api?.getRelatedByEmbeddingTerms?.(terms, 20)) || []
            if (alive) setItems(er.map((x: any) => ({ note_id: x.note_id, first_field: x.first_field, score: Number(x.cos || 0), metric: 'cos' })))
          } else {
            const er = (await (window as any).api?.getRelatedByEmbedding?.(noteId, 0.7, 20)) || []
            if (alive) setItems(er.map((x: any) => ({ note_id: x.note_id, first_field: x.first_field, score: Number(x.cos || 0), metric: 'cos' })))
          }
        } else {
          // Hybrid (default): Build a query from selected terms or from the note's front text, then run hybrid
          let q = ''
          if (terms.length > 0) {
            q = terms.join(' ')
          } else {
            try {
              const d = (window as any).api?.getNoteDetails?.(noteId)
              if (d && Array.isArray(d.fields) && d.fields.length > 0) {
                const html = String(d.fields[0]?.value_html || '')
                q = html
                  .replace(/<br\s*\/?\s*>/gi, ' ')
                  .replace(/<[^>]*>/g, ' ')
                  .replace(/\[sound:[^\]]+\]/gi, ' ')
                  .replace(/&nbsp;/g, ' ')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&amp;/g, '&')
                  .replace(/\s+/g, ' ')
                  .trim()
              }
            } catch {}
          }
          if (!q) q = terms.join(' ')
          try {
            const res = (await (window as any).api?.hybridSemanticModulated?.(q, 200)) || []
            // Filter: remove self, keep only score >= 0.90 (90%), and take top 20
            const filtered = res
              .filter((x: any) => x && x.note_id !== noteId && typeof x.score === 'number' && x.score >= 0.90)
              .slice(0, 20)
            if (alive) setItems(filtered.map((x: any) => ({ note_id: x.note_id, first_field: x.first_field, score: Number(x.score || 0), metric: 'hyb' })))
          } catch {
            if (alive) setItems([])
          }
        }
      } catch {
        if (alive) setItems([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [noteId, selected, mode])

  React.useEffect(() => {
    const dispose = reload()
    return () => { dispose && dispose() }
  }, [reload])

  return (
    <div className="rounded-lg border bg-zinc-50 dark:bg-zinc-900/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Related notes</div>
        <div className="inline-flex items-center gap-1 text-[11px] rounded-md p-0.5 border bg-white/60 dark:bg-zinc-900/30">
          <button
            className={`px-2 py-0.5 rounded ${mode === 'hybrid' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' : 'text-foreground'}`}
            onClick={() => setMode('hybrid')}
            title="Hybrid (BM25-modulated semantic)"
          >Hybrid</button>
          <button
            className={`px-2 py-0.5 rounded ${mode === 'bm25' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' : 'text-foreground'}`}
            onClick={() => setMode('bm25')}
            title="BM25 on first field"
          >BM25</button>
          <button
            className={`px-2 py-0.5 rounded ${mode === 'semantic' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : 'text-foreground'}`}
            onClick={() => setMode('semantic')}
            title="Semantic (embeddings)"
          >Semantic</button>
        </div>
      </div>
      {concepts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {concepts.map((c) => {
            const active = selected.has(c)
            return (
              <button
                key={c}
                className={`text-[12px] rounded-full px-2 py-0.5 border ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 border-sky-200 dark:border-sky-800'}`}
                onClick={() => {
                  const next = new Set(selected)
                  if (next.has(c)) next.delete(c)
                  else next.add(c)
                  setSelected(next)
                }}
                title={c}
              >
                {c}
              </button>
            )
          })}
          {selected.size > 0 && (
            <button
              className="text-[12px] rounded-full px-2 py-0.5 border bg-amber-600 text-white border-amber-600"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          )}
          {noteSel.size > 0 && (
            <button
              className="ml-auto text-[12px] rounded-full px-2 py-0.5 border bg-emerald-600 text-white border-emerald-600"
              title="Unsuspend selected notes"
              onClick={async () => {
                try {
                  await (window as any).api?.unsuspendNotes?.(Array.from(noteSel))
                  // eslint-disable-next-line no-console
                  console.log('Unsuspended notes:', Array.from(noteSel))
                  setNoteSel(new Set())
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.error('Unsuspend failed', e)
                }
              }}
            >
              Unsuspend ({noteSel.size})
            </button>
          )}
        </div>
      )}
      {loading && (
        <div className="text-[12px] text-muted-foreground">Loading related notes…</div>
      )}
      {!loading && items.length === 0 && (
        <div className="text-[12px] text-muted-foreground">No related notes found.</div>
      )}
      <div className="divide-y rounded-md border bg-white/50 dark:bg-transparent">
        {items.map((r) => (
          <div
            key={r.note_id}
            className="px-3 py-2 hover:bg-white/60 dark:hover:bg-zinc-900 rounded-md cursor-pointer"
            onClick={() => setDetailId(r.note_id)}
          >
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={noteSel.has(r.note_id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const next = new Set(noteSel)
                  if ((e.target as HTMLInputElement).checked) next.add(r.note_id)
                  else next.delete(r.note_id)
                  setNoteSel(next)
                }}
                title="Select for Unsuspend"
              />
              <div className="text-sm flex-1 leading-relaxed">{renderFieldPreview(r.first_field)}</div>
              {r.metric === 'hyb' ? (
                <span className="shrink-0 text-[11px] rounded-md px-1.5 py-0.5 bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300" title="Hybrid similarity (BM25-modulated)">
                  Similarity {(Math.max(0, Math.min(1, Number(r.score))) * 100).toFixed(1)}%
                </span>
              ) : r.metric === 'cos' ? (
                <span className="shrink-0 text-[11px] rounded-md px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" title="Embedding cosine similarity">
                  Similarity {(Math.max(0, Math.min(1, Number(r.score))) * 100).toFixed(1)}%
                </span>
              ) : (
                <span className="shrink-0 text-[11px] rounded-md px-1.5 py-0.5 bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300" title="FTS5 bm25 (lower is better)">
                  BM25 {Number(r.score).toFixed(2)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      {detailId !== null && (
        <DetailOverlay
          noteId={detailId}
          onClose={() => { setDetailId(null) }}
        />
      )}
    </div>
  )
}

function DetailOverlay({ noteId, onClose }: { noteId: number; onClose: () => void }): React.JSX.Element {
  const [data, setData] = React.useState<any | null>(null)
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const d = await (window as any).api?.getNoteDetails?.(noteId)
        if (alive) setData(d)
      } catch { if (alive) setData(null) }
    })()
    return () => { alive = false }
  }, [noteId])
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-auto py-8 px-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-auto bg-background border rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b bg-zinc-50/60 dark:bg-zinc-900/30">
          <div className="text-sm font-semibold">Note {noteId}</div>
          <button className="text-[12px] rounded-md px-2 py-0.5 border bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700" onClick={onClose}>Close</button>
        </div>
        <div className="p-4 space-y-3">
          {data ? (
            data.fields
              .filter((f: any) => hasVisibleContent(f.value_html))
              .map((f: any) => (
                <div key={f.field_name} className="border rounded-md p-3">
                  <div className="font-medium mb-2">{f.field_name}</div>
                  <HtmlWithMath html={f.value_html} />
                </div>
              ))
          ) : (
            <div className="text-muted-foreground text-xs">Loading…</div>
          )}
          {/* Related notes inside overlay */}
          <div className="mt-2">
            <RelatedByBm25 noteId={noteId} />
          </div>
        </div>
      </div>
    </div>
  )
}
