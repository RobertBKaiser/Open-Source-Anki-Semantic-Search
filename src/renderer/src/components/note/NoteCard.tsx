import React from 'react'
import renderMathInElement from 'katex/contrib/auto-render/auto-render'
import 'katex/dist/katex.min.css'

export type NoteListItem = {
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
  score?: number
  __cos_breakdown__?: Array<{ backend: 'deepinfra'|'google'|'gemma'; model: string; cos: number }>
}

export type NoteCardMode = 'default' | 'exact' | 'fuzzy' | 'rerank' | 'semantic' | 'hybrid' | 'select'
export type NoteCardVariant = 'line' | 'full'

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

function PreviewText({ value, ioRoot, variant }: { value: string | null; ioRoot?: Element | null; variant: NoteCardVariant }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const lastHtmlRef = React.useRef<string>('')
  const renderedKeyRef = React.useRef<string>('')
  const rawHtml = React.useMemo(() => {
    const src = String(value || '')
    let html0 = src
      .replace(/<img[^>]*>/gi, '🖼️')
      .replace(/\[sound:[^\]]+\]/gi, ' 🔊 ')
      .replace(/<br\s*\/?\s*>/gi, ' ')
    html0 = html0.replace(/<(?!\/?(?:b|strong|i|em|u|sub|sup|mark|code)\b)[^>]*>/gi, '')
    const colors = ['#9b5de5', '#3a86ff', '#00c853', '#ff8f00', '#00e5ff', '#ff006e']
    html0 = html0.replace(/\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/gi, (_m, n, inner) => {
      const idx = (Number(n) - 1) % colors.length
      const color = colors[idx < 0 ? 0 : idx]
      return `<span style=\"color:${color};font-weight:600\">${inner}</span>`
    })
    let safeHtml = html0
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    safeHtml = safeHtml.replace(/[\u9000-\u9004]/g, '?')
    return safeHtml
  }, [value])

  const hasMath = React.useMemo(() => /\$\$|\\\[|\\\(|(^|[^\\])\$/.test(String(value || '')), [value])

  const schedule = (cb: () => void) => {
    try {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => cb())
        return
      }
    } catch {}
    const rif = (window as any).requestIdleCallback as any
    if (typeof rif === 'function') rif(cb, { timeout: 60 })
    else window.setTimeout(cb, 0)
  }

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const html = rawHtml
    if (lastHtmlRef.current !== html) {
      lastHtmlRef.current = html
      el.innerHTML = html
      renderedKeyRef.current = ''
    }
    let obs: IntersectionObserver | null = null
    const renderNow = () => {
      if (!el || renderedKeyRef.current === html || !hasMath) return
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
          strict: false,
        })
        renderedKeyRef.current = html
      } catch {}
    }
    // Always schedule a render on mount/update; with react-window only visible rows mount
    schedule(renderNow)
    try {
      obs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            schedule(renderNow)
            if (obs && el) obs.unobserve(el)
          }
        }
      }, { root: (ioRoot as any) || null, rootMargin: '100px', threshold: 0 })
      obs.observe(el)
    } catch {
      schedule(renderNow)
    }
    return () => { try { if (obs && el) obs.unobserve(el) } catch {} }
  }, [rawHtml, hasMath, ioRoot])

  return (
    <span
      ref={ref}
      className={`text-sm flex-1 ${variant === 'line' ? 'truncate' : 'whitespace-normal break-words'}`}
      style={variant === 'line' ? undefined : { display: 'inline-block', width: '100%' }}
    />
  )
}

function buildScoreBadges(n: NoteListItem, mode: NoteCardMode): React.ReactNode[] {
  const jacMeta = formatJaccardPercent(n.jaccard)
  const badges: React.ReactNode[] = []

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
    badges.push(
      <span key="badge_num" className={`text-[11px] rounded-md px-1.5 py-0.5 ${cls}`} title="LLM badge (0 best, 3 worst)">
        {label}
      </span>
    )
    return badges
  }

  if (mode === 'semantic') {
    if (typeof n.rerank !== 'undefined' && Number.isFinite(Number(n.rerank))) {
      const breakdown = Array.isArray((n as any).__cos_breakdown__) && (n as any).__cos_breakdown__.length > 0
        ? (n as any).__cos_breakdown__.map((x: any) => `${x.backend}/${x.model}: ${Number(x.cos).toFixed(3)}`).join(' • ')
        : null
      badges.push(
        <span
          key="semantic"
          className="text-[11px] rounded-md px-1.5 py-0.5 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
          title={breakdown || 'Embedding similarity'}
        >
          Similarity: {(Math.max(0, Math.min(1, Number(n.rerank))) * 100).toFixed(1)}%
        </span>
      )
    }
    return badges
  }

  if (mode === 'rerank') {
    if (typeof n.rerank !== 'undefined') {
      badges.push(
        <span
          key="rerank"
          className="text-[11px] rounded-md px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
          title="Semantic reranker relevance score"
        >
          Rerank: {Number(n.rerank).toFixed(3)}
        </span>
      )
    }
    return badges
  }

  if (mode === 'hybrid') {
    const s = typeof (n as any).score === 'number' ? Number((n as any).score) : NaN
    const pct = Number.isFinite(s) ? Math.max(0, Math.min(100, s * 100)) : NaN
    const cos = typeof (n as any).cos === 'number' ? Number((n as any).cos) : NaN
    const bm = typeof (n as any).bm25 === 'number' ? Number((n as any).bm25) : NaN
    const breakdown = Array.isArray((n as any).__cos_breakdown__) && (n as any).__cos_breakdown__.length > 0
      ? (n as any).__cos_breakdown__.map((x: any) => `${x.backend}/${x.model}: ${Number(x.cos).toFixed(3)}`).join(' • ')
      : null
    const tt = `${breakdown ? `${breakdown} • ` : ''}Cosine: ${Number.isFinite(cos) ? cos.toFixed(3) : '—'} • BM25: ${Number.isFinite(bm) ? bm.toFixed(2) : '—'}`
    if (Number.isFinite(pct)) {
      badges.push(
        <span
          key="hybrid"
          className="text-[11px] rounded-md px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
          title={tt}
        >
          Similarity: {pct.toFixed(1)}%
        </span>
      )
    }
    return badges
  }

  if (typeof n.bm25 !== 'undefined') {
    badges.push(
      <span
        key="bm25"
        className="text-[11px] rounded-md px-1.5 py-0.5 bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
        title="FTS5 bm25 (lower is better)"
      >
        BM25: {Number(n.bm25).toFixed(2)}
      </span>
    )
  }

  if (typeof n.trigrams !== 'undefined') {
    badges.push(
      <span
        key="tri"
        className="text-[11px] rounded-md px-1.5 py-0.5 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
        title="Trigram hits (higher is better)"
      >
        Tri: {Number(n.trigrams).toFixed(0)}
      </span>
    )
  }

  if (jacMeta) {
    badges.push(
      <span
        key="jac"
        className={`text-[11px] rounded-md px-1.5 py-0.5 ${jacMeta.cls}`}
        title="Trigram Jaccard similarity (|A∩B| / |A∪B|)"
      >
        Jacc: {jacMeta.label}
      </span>
    )
  }

  return badges
}

export function NoteCard({
  n,
  mode,
  selected,
  selectedIds = [],
  onToggleSelect,
  onSelect,
  ioRoot,
  variant = 'line'
}: {
  n: NoteListItem
  mode: NoteCardMode
  selected: boolean
  selectedIds?: number[]
  onToggleSelect?: (noteId: number, selected: boolean) => void
  onSelect: (noteId: number) => void
  ioRoot?: Element | null
  variant?: NoteCardVariant
}): React.JSX.Element {
  const isFull = variant === 'full'
  const badges = buildScoreBadges(n, mode)

  const chipContainerLine = badges.length > 0 ? (
    <div className="flex items-center gap-1 ml-2">
      {badges}
    </div>
  ) : null

  const metaChipsFull: React.ReactNode[] = []
  if (isFull) {
    metaChipsFull.push(
      <span key="id" className="text-[11px] font-mono rounded-md bg-zinc-100 px-1.5 py-[1px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
        #{n.note_id}
      </span>
    )
    if (Array.isArray((n as any).__overlaps) && (n as any).__overlaps.length > 0) {
      metaChipsFull.push(
        <span key="overlap-label" className="text-[11px] text-muted-foreground">
          Overlaps:
        </span>
      )
      metaChipsFull.push(
        ...(n as any).__overlaps.map((o: any, idx: number) => (
          <span
            key={`overlap-${idx}`}
            className="text-[10px] rounded-md px-1 py-[1px] bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
            title={`Also matches ${o.keyword}`}
          >
            {o.keyword} {(o.cos * 100).toFixed(1)}%
          </span>
        ))
      )
    }
    if (badges.length > 0) {
      metaChipsFull.push(...badges)
    }
  }

  return (
    <button
      type="button"
      key={n.note_id}
      onClick={() => onSelect(n.note_id)}
      className={
        isFull
          ? `relative w-full text-left rounded-lg border px-3 py-2 transition-all duration-150 ${selected ? 'ring-2 ring-blue-400 bg-blue-50 dark:bg-blue-900/20 dark:ring-blue-400/60' : 'bg-white/90 hover:bg-white dark:bg-zinc-900/50 dark:hover:bg-zinc-900/60'}`
          : `relative w-full text-left px-3 py-1 truncate ${selected ? 'bg-sidebar-accent' : 'hover:bg-muted/30'}`
      }
    >
      {(typeof (n as any).badge_num === 'number' || n.rerank_category) && (
        <span
          className={`absolute left-0 top-0 bottom-0 ${isFull ? 'w-[4px] rounded-l-lg' : 'w-[6px] rounded-r-sm'}`}
          style={{
            backgroundColor: (() => {
              const num = (n as any).badge_num
              if (typeof num === 'number') {
                return num === 0 ? '#10b981' : num === 1 ? '#3b82f6' : num === 2 ? '#f59e0b' : '#9ca3af'
              }
              return n.rerank_category === 'in'
                ? '#ff3b30'
                : n.rerank_category === 'out'
                  ? '#000000'
                  : n.rerank_category === 'related'
                    ? '#3b82f6'
                    : 'transparent'
            })()
          }}
        />
      )}
      <div className={isFull ? 'flex flex-col gap-2 text-left' : 'flex items-center gap-2'}>
        <div className={isFull ? 'flex items-start gap-2' : 'flex items-center gap-2'}>
          {mode === 'select' && (
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
          )}
          <PreviewText value={n.first_field} ioRoot={ioRoot} variant={variant} />
          {!isFull && Array.isArray((n as any).__overlaps) && (n as any).__overlaps.length > 0 && (
            <div className="ml-auto flex items-center gap-1">
              {(n as any).__overlaps.map((o: any, idx: number) => (
                <span
                  key={idx}
                  className="text-[10px] rounded-md px-1 py-[1px] bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
                  title={`Also matches ${o.keyword}`}
                >
                  {o.keyword} {(o.cos * 100).toFixed(1)}%
                </span>
              ))}
            </div>
          )}
          {!isFull && chipContainerLine}
        </div>
        {isFull && metaChipsFull.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            {metaChipsFull}
          </div>
        )}
      </div>
    </button>
  )
}
