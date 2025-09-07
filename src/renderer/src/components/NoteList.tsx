import React, { useEffect, useMemo, useRef } from 'react'
import renderMathInElement from 'katex/contrib/auto-render/auto-render'
import 'katex/dist/katex.min.css'

type NoteListItem = {
  note_id: number
  first_field: string | null
  bm25?: number
  trigrams?: number
  combined?: number
  cos?: number
  rrf?: number
  jaccard?: number
  where?: 'front' | 'back' | 'both'
  rerank?: number
  rerank_in?: number
  rerank_out?: number
  rerank_related?: number
  rerank_category?: 'in' | 'out' | 'related'
}

type NoteListProps = {
  notes: NoteListItem[]
  selectedId: number | null
  onSelect: (noteId: number) => void
  onEndReached?: () => void
  mode?: 'default' | 'exact' | 'fuzzy' | 'rerank' | 'semantic' | 'hybrid'
  selectedIds?: number[]
  onToggleSelect?: (noteId: number, selected: boolean) => void
  groups?: Array<{ keyword: string; notes: NoteListItem[]; kcos?: number; gbm25?: number }>
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripHtml(input: string): string {
  // Replace line breaks with spaces, then strip all remaining tags
  return input.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, '')
}

function cleanText(input: string): string {
  const decoded = decodeEntities(stripHtml(input))
  const noMustache = decoded.replace(/\{\{[^}]+\}\}/g, '')
  return noMustache.replace(/\s+/g, ' ').trim()
}

function getClozeColor(n: number): string {
  // Bright, high-contrast hues roughly matching: purple, blue, green, orange, teal, pink
  const colors = ['#9b5de5', '#3a86ff', '#00c853', '#ff8f00', '#00e5ff', '#ff006e']
  return colors[(n - 1) % colors.length]
}

// Render preview with cloze inner text colorized, no HTML/cloze syntax visible, media/audio abbreviated
function renderFieldPreview(value: string | null): React.ReactNode {
  if (!value) return null
  // First, abbreviate media/audio so placeholders survive HTML stripping
  let source = value
    .replace(/<img [^>]*src="[^"]+"[^>]*>/gi, '🖼️')
    .replace(/\[sound:[^\]]+\]/gi, '🔊')

  const parts: React.ReactNode[] = []
  const pushPart = (node: React.ReactNode) => {
    if (parts.length > 0) parts.push(' ')
    parts.push(node)
  }
  let lastIndex = 0
  const regex = /\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    const start = match.index
    const full = match[0]
    const num = Number(match[1])
    const inner = match[2] || ''
    // Preceding plain text
    if (start > lastIndex) {
      const plain = source.slice(lastIndex, start)
      const cleaned = cleanText(plain)
      if (cleaned) pushPart(cleaned)
    }
    // Cloze inner text, colorized
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
  // Tail text
  if (lastIndex < source.length) {
    const tail = cleanText(source.slice(lastIndex))
    if (tail) pushPart(tail)
  }

  // If nothing matched, fall back to cleaning everything
  if (parts.length === 0) return cleanText(source)
  return parts
}

export function NoteList({ notes, selectedId, onSelect, onEndReached, mode = 'default', selectedIds = [], onToggleSelect, groups }: NoteListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || !onEndReached) return
    const handler = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
        onEndReached()
      }
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [onEndReached])
  function formatJaccardPercent(j?: number): { label: string; cls: string } | null {
    if (typeof j !== 'number' || Number.isNaN(j)) return null
    const pct = Math.max(0, Math.min(100, Math.round(j * 100)))
    const label = `${pct}%`
    const cls = pct >= 66
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
      : pct >= 33
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
        : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
    return { label, cls }
  }

  function ScoreBadges(n: any): React.ReactNode {
    const jacMeta = formatJaccardPercent(n.jaccard)
    // Numeric badge chip (0..3)
    if (typeof (n as any).badge_num === 'number') {
      const bn = Number((n as any).badge_num)
      const label = bn === 0 ? 'Hit' : bn === 1 ? 'Very Related' : bn === 2 ? 'Somewhat Related' : 'Not Related'
      const cls = bn === 0
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
        : bn === 1
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
          : bn === 2
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
            : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
      return (
        <div className="flex items-center gap-1 ml-2">
          <span className={`text-[11px] rounded-md px-1.5 py-0.5 ${cls}`} title="LLM badge (0 best, 3 worst)">
            {label}
          </span>
        </div>
      )
    }
    if (mode === 'semantic') {
      return (
        <div className="flex items-center gap-1 ml-2">
          {typeof n.rerank !== 'undefined' && (
            <span
              className="text-[11px] rounded-md px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
              title="Embedding cosine similarity"
            >
              Cos: {Number(n.rerank).toFixed(3)}
            </span>
          )}
        </div>
      )
    }
    if (mode === 'rerank') {
      return (
        <div className="flex items-center gap-1 ml-2">
          {typeof n.rerank !== 'undefined' && (
            <span
              className="text-[11px] rounded-md px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
              title="Semantic reranker relevance score"
            >
              Rerank: {Number(n.rerank).toFixed(3)}
            </span>
          )}
        </div>
      )
    }
    if (mode === 'hybrid') {
      return (
        <div className="flex items-center gap-1 ml-2">
          {typeof (n as any).score === 'number' && (() => {
            const s = Number((n as any).score)
            const pct = Math.max(0, Math.min(100, s * 100))
            const cos = typeof (n as any).cos === 'number' ? Number((n as any).cos) : NaN
            const bm = typeof (n as any).bm25 === 'number' ? Number((n as any).bm25) : (typeof (n as any).bm25 === 'undefined' && typeof (n as any).bm25 !== 'number' && typeof (n as any).bm25 !== 'undefined' ? Number.NaN : Number((n as any).bm25))
            const tt = `Cosine: ${Number.isFinite(cos) ? cos.toFixed(3) : '—'} • BM25: ${Number.isFinite(bm) ? bm.toFixed(2) : '—'}`
            return (
              <span
                className="text-[11px] rounded-md px-1.5 py-0.5 bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300"
                title={tt}
              >
                Similarity: {pct.toFixed(1)}%
              </span>
            )
          })()}
        </div>
      )
    }
    return (
      <div className="flex items-center gap-1 ml-2">
        {typeof n.bm25 !== 'undefined' && (
          <span
            className="text-[11px] rounded-md px-1.5 py-0.5 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            title="FTS5 bm25 (lower is better)"
          >
            BM25: {Number(n.bm25).toFixed(2)}
          </span>
        )}
        {typeof n.trigrams !== 'undefined' && (
          <span
            className="text-[11px] rounded-md px-1.5 py-0.5 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            title="Trigram hits (higher is better)"
          >
            Tri: {Number(n.trigrams).toFixed(0)}
          </span>
        )}
        {jacMeta && (
          <span
            className={`text-[11px] rounded-md px-1.5 py-0.5 ${jacMeta.cls}`}
            title="Trigram Jaccard similarity (|A∩B| / |A∪B|)"
          >
            Jacc: {jacMeta.label}
          </span>
        )}
        {typeof n.rrf !== 'undefined' && (
          <span
            className="text-[11px] rounded-md px-1.5 py-0.5 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            title="Reciprocal Rank Fusion score"
          >
            RRF: {Number(n.rrf).toFixed(3)}
          </span>
        )}
        {n.where && (
          <span
            className="text-[11px] rounded-md px-1.5 py-0.5 bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
            title="Where the match was found"
          >
            {n.where}
          </span>
        )}
      </div>
    )
  }

  function PreviewText({ value }: { value: string | null }) {
    const ref = useRef<HTMLSpanElement | null>(null)
    const nodes = useMemo(() => renderFieldPreview(value), [value])
    useEffect(() => {
      const el = ref.current
      if (!el) return
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
    }, [nodes])
    return <span ref={ref} className="text-sm flex-1 truncate">{nodes}</span>
  }

  const renderRow = (n: NoteListItem) => (
        <button
          key={n.note_id}
          onClick={() => onSelect(n.note_id)}
          className={`relative w-full text-left px-3 py-1 truncate ${selectedId === n.note_id ? 'bg-sidebar-accent' : ''}`}
        >
          {/* Left color badge for classification (shows when set) */}
          {(typeof (n as any).badge_num === 'number' || n.rerank_category) && (
            <span
              className="absolute left-0 top-0 bottom-0 w-[6px] rounded-r-sm"
              style={{
                backgroundColor: (() => {
                  const num = (n as any).badge_num
                  if (typeof num === 'number') {
                    // 0 green, 1 blue, 2 amber, 3 gray
                    return num === 0 ? '#10b981' : num === 1 ? '#3b82f6' : num === 2 ? '#f59e0b' : '#9ca3af'
                  }
                  return n.rerank_category === 'in' ? '#ff3b30' : n.rerank_category === 'out' ? '#000000' : n.rerank_category === 'related' ? '#3b82f6' : 'transparent'
                })()
              }}
            />
          )}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              data-note-select
              value={n.note_id}
              className="shrink-0"
              checked={selectedIds.includes(n.note_id)}
              onChange={(e) => {
                e.stopPropagation()
                onToggleSelect && onToggleSelect(n.note_id, (e.target as HTMLInputElement).checked)
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <PreviewText value={n.first_field} />
            {/* Overlap chips */}
            {Array.isArray((n as any).__overlaps) && (n as any).__overlaps.length > 0 && (
              <div className="ml-auto flex items-center gap-1">
                {(n as any).__overlaps.map((o: any, idx: number) => (
                  <span key={idx} className="text-[10px] rounded-md px-1 py-[1px] bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300" title={`Also matches ${o.keyword}`}>
                    {o.keyword} {(o.cos * 100).toFixed(1)}%
                  </span>
                ))}
              </div>
            )}
            {ScoreBadges(n)}
          </div>
        </button>
  )

  if (Array.isArray(groups) && groups.length > 0) {
    return (
      <div ref={containerRef} className="min-h-0 h-full overflow-y-auto">
        {groups.map((g) => (
          <div key={g.keyword} className="mb-3">
            <div className="sticky top-0 z-10 px-3 py-1.5 text-xs font-semibold">
              <span className="inline-flex items-center gap-2 rounded-full px-2 py-0.5 bg-blue-600 text-white shadow">
                <span>{g.keyword}</span>
                {typeof g.kcos === 'number' && g.kcos >= 0 && (
                  <span className="text-[10px] rounded bg-white/20 px-1 py-[1px]">{(g.kcos * 100).toFixed(1)}%</span>
                )}
                {typeof g.gbm25 === 'number' && (
                  <span className="text-[10px] rounded bg-white/20 px-1 py-[1px]">BM25 {g.gbm25.toFixed(2)}</span>
                )}
              </span>
            </div>
            <div className="mt-1 rounded-lg border bg-white/70 dark:bg-zinc-900/30 divide-y shadow-sm">
              {g.notes
                .slice()
                .sort((a: any, b: any) => (b?.__gcos ?? -1) - (a?.__gcos ?? -1))
                .map((n) => renderRow(n))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="min-h-0 h-full overflow-y-auto divide-y">
      {notes.map((n) => renderRow(n))}
    </div>
  )
}
