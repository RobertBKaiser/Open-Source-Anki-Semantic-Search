import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import renderMathInElement from 'katex/contrib/auto-render/auto-render'
import 'katex/dist/katex.min.css'
import { FixedSizeList as VList, type ListChildComponentProps } from 'react-window'

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

// (removed) decode/strip helpers; handled inline in PreviewText

// (removed) helpers no longer used by the list preview

// Render preview with cloze inner text colorized, no HTML/cloze syntax visible, media/audio abbreviated
// (removed) previous JSX-based preview renderer

export function NoteList({ notes, selectedId, onSelect, onEndReached, mode = 'default', selectedIds = [], onToggleSelect, groups }: NoteListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const outerRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number>(400)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setHeight(el.clientHeight || 400)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ITEM_SIZE = 36
  const onContainerPointerDownCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try {
      const target = e.target as HTMLElement
      if (target && target.closest('input, button, a, textarea, select, [data-ignore-pointer-select]')) return
      const outer = outerRef.current
      if (!outer) return
      const rect = outer.getBoundingClientRect()
      const y = e.clientY - rect.top
      const scrollTop = outer.scrollTop || 0
      const idx = Math.floor((y + scrollTop) / ITEM_SIZE)
      if (idx >= 0 && idx < notes.length) {
        const n = notes[idx]
        if (n) {
          onSelect(n.note_id)
          // Prevent subsequent click from re-triggering selection and re-render
          e.preventDefault()
          e.stopPropagation()
        }
      }
    } catch {}
  }, [notes, onSelect])
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
    const src = String(value || '')
    // 1) Abbreviate media and normalize <br>
    let html0 = src
      .replace(/<img[^>]*>/gi, '🖼️')
      .replace(/\[sound:[^\]]+\]/gi, ' 🔊 ')
      .replace(/<br\s*\/?\s*>/gi, ' ')
    // 2) Whitelist basic inline formatting tags; strip all others except allowed and their closing tags
    html0 = html0.replace(/<(?!\/?(?:b|strong|i|em|u|sub|sup|mark|code)\b)[^>]*>/gi, '')
    // 3) Cloze coloring: turn {{cN::inner::...}} into colored span (preserving inner allowed tags)
    const colors = ['#9b5de5', '#3a86ff', '#00c853', '#ff8f00', '#00e5ff', '#ff006e']
    html0 = html0.replace(/\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/gi, (_m, n, inner) => {
      const idx = (Number(n) - 1) % colors.length
      const color = colors[idx < 0 ? 0 : idx]
      return `<span style="color:${color};font-weight:600">${inner}</span>`
    })
    // 4) Decode basic entities and collapse spaces
    let safeHtml = html0
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    // 5) KaTeX render on a detached element to avoid flicker
    const withMath = useMemo(() => {
      const tmp = document.createElement('span')
      tmp.innerHTML = safeHtml
      try {
        renderMathInElement(tmp, {
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
      return tmp.innerHTML
    }, [safeHtml])
    return <span className="text-sm flex-1 truncate" dangerouslySetInnerHTML={{ __html: withMath }} />
  }

  const PreviewTextMemo = React.memo(PreviewText, (prev, next) => prev.value === next.value)

  const Row = useCallback(({ index, style, data }: ListChildComponentProps<any>) => {
    const n: NoteListItem = data.notes[index]
    return (
      <button
        key={n.note_id}
        style={style}
        onClick={() => onSelect(n.note_id)}
        className={`relative w-full text-left px-3 py-1 truncate border-b ${selectedId === n.note_id ? 'bg-sidebar-accent' : ''}`}
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
               onMouseDown={(e) => e.stopPropagation()}
             />
            <PreviewTextMemo value={n.first_field} />
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
  }, [onSelect, selectedId, selectedIds, onToggleSelect])

  const renderRowInline = (n: NoteListItem) => (
    <button
      key={n.note_id}
      onClick={() => onSelect(n.note_id)}
      className={`relative w-full text-left px-3 py-1 truncate ${selectedId === n.note_id ? 'bg-sidebar-accent' : ''}`}
    >
      {(typeof (n as any).badge_num === 'number' || n.rerank_category) && (
        <span
          className="absolute left-0 top-0 bottom-0 w-[6px] rounded-r-sm"
          style={{
            backgroundColor: (() => {
              const num = (n as any).badge_num
              if (typeof num === 'number') {
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
               onPointerDownCapture={(e) => e.stopPropagation()}
             />
        <PreviewTextMemo value={n.first_field} />
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
                .map((n) => renderRowInline(n))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="min-h-0 h-full" onPointerDownCapture={onContainerPointerDownCapture}>
      <VList
        height={height}
        width={'100%'}
        itemCount={notes.length}
        itemSize={ITEM_SIZE}
        itemData={{ notes }}
        itemKey={(index, data) => (data.notes[index]?.note_id ?? index)}
        overscanCount={20}
        outerRef={outerRef as any}
        onScroll={(() => {
          let last = 0
          return (_ev: any) => {
            const now = Date.now()
            if (now - last > 50) {
              last = now
              try { window.dispatchEvent(new CustomEvent('note-list-scrolling', { detail: { ts: now } })) } catch {}
            }
          }
        })()}
        onItemsRendered={({ visibleStopIndex }) => {
          if (onEndReached && visibleStopIndex >= notes.length - 5) onEndReached()
        }}
      >
        {Row}
      </VList>
    </div>
  )
}
