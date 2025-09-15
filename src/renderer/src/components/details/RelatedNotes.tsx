import React from 'react'
import { NoteCard, type NoteListItem } from '@/components/note/NoteCard'

type RelItem = {
  note_id: number
  first_field: string | null
  score: number
  metric: 'bm25' | 'cos' | 'hyb'
  cos?: number
  bm25?: number
}

// User feedback: minimize INP by prioritizing cached results and deferring heavy work
export function RelatedNotes({ noteId }: { noteId: number }): React.JSX.Element {
  const [items, setItems] = React.useState<RelItem[]>([])
  const [loading, setLoading] = React.useState<boolean>(true)
  const [concepts, setConcepts] = React.useState<string[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [mode, setMode] = React.useState<'bm25' | 'semantic' | 'hybrid'>('bm25')
  const [noteSel, setNoteSel] = React.useState<Set<number>>(new Set())
  const [detailId, setDetailId] = React.useState<number | null>(null)

  React.useEffect(() => {
    let alive = true
    try {
      const ks = (window as any).api?.getTopKeywordsForNote?.(noteId, 8) || []
      if (alive) setConcepts(ks)
    } catch { if (alive) setConcepts([]) }
    return () => { alive = false }
  }, [noteId])

  const cacheRef = React.useRef<Map<string, RelItem[]>>(new Map())
  const keyFor = (nid: number, m: 'bm25' | 'semantic' | 'hybrid', sel: Set<string>) => `${nid}|${m}|${Array.from(sel).sort().join('|')}`

  const reload = React.useCallback(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        const terms = Array.from(selected)
        const cacheKey = keyFor(noteId, mode, selected)
        const cached = cacheRef.current.get(cacheKey)
        if (cached) { if (alive) setItems(cached); return }
        if (mode === 'bm25') {
          // Defer synchronous bm25 query to next frame to avoid blocking click-to-paint
          const res = await new Promise<any[]>((resolve) => {
            try {
              if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(() => resolve((window as any).api?.getRelatedByBm25?.(noteId, 20, terms.length ? terms : undefined) || []))
              } else {
                setTimeout(() => resolve((window as any).api?.getRelatedByBm25?.(noteId, 20, terms.length ? terms : undefined) || []), 0)
              }
            } catch {
              resolve((window as any).api?.getRelatedByBm25?.(noteId, 20, terms.length ? terms : undefined) || [])
            }
          })
          const out: RelItem[] = res.map((r: any) => ({
            note_id: r.note_id,
            first_field: r.first_field,
            score: Number(r.bm25 || 0),
            metric: 'bm25',
            bm25: Number(r.bm25 || 0)
          }))
          if (alive) { setItems(out); cacheRef.current.set(cacheKey, out) }
        } else if (mode === 'semantic') {
          if (terms.length > 0) {
            const er = (await (window as any).api?.getRelatedByEmbeddingTerms?.(terms, 20)) || []
            const out: RelItem[] = er.map((x: any) => ({
              note_id: x.note_id,
              first_field: x.first_field,
              score: Number(x.cos || 0),
              metric: 'cos',
              cos: Number(x.cos || 0)
            }))
            if (alive) { setItems(out); cacheRef.current.set(cacheKey, out) }
          } else {
            const er = (await (window as any).api?.getRelatedByEmbedding?.(noteId, 0.7, 20)) || []
            const out: RelItem[] = er.map((x: any) => ({
              note_id: x.note_id,
              first_field: x.first_field,
              score: Number(x.cos || 0),
              metric: 'cos',
              cos: Number(x.cos || 0)
            }))
            if (alive) { setItems(out); cacheRef.current.set(cacheKey, out) }
          }
        } else {
          try {
            let res: Array<{ note_id: number; first_field: string | null; score: number }> = []
            if (terms.length > 0) {
              const q = terms.join(' ')
              res = (await (window as any).api?.hybridSemanticModulated?.(q, 200)) || []
            } else {
              res = (await (window as any).api?.hybridSemanticModulatedFromNote?.(noteId, 200)) || []
            }
            const top = (res as Array<{ note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number }>)
              .filter((x) => x && x.note_id !== noteId && typeof x.score === 'number' && x.score >= 0.7)
              .slice(0, 20)
            const out: RelItem[] = top.map((x: { note_id: number; first_field: string | null; score: number; cos?: number; bm25?: number }) => ({
              note_id: x.note_id,
              first_field: x.first_field,
              score: Number(x.score || 0),
              metric: 'hyb',
              cos: typeof x.cos === 'number' ? Number(x.cos) : undefined,
              bm25: typeof x.bm25 === 'number' ? Number(x.bm25) : undefined
            }))
            if (alive) { setItems(out); cacheRef.current.set(cacheKey, out) }
          } catch { if (alive) setItems([]) }
        }
      } catch { if (alive) setItems([]) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [noteId, selected, mode])

  React.useEffect(() => {
    const cacheKey = keyFor(noteId, mode, selected)
    const cached = cacheRef.current.get(cacheKey)
    if (cached) { setItems(cached); setLoading(false); return }
    const dispose = reload()
    return () => { dispose && dispose() }
  }, [noteId, mode, selected, reload])

  React.useEffect(() => {
    let cleanup: (() => void) | null = null
    let timer: number | null = null
    let lastScrollTs = 0
    const SCROLL_QUIET_MS = 500
    const schedule = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (Date.now() - lastScrollTs >= SCROLL_QUIET_MS) cleanup = reload()
      }, SCROLL_QUIET_MS) as unknown as number
    }
    const onScroll = (e: CustomEvent<{ ts: number }>) => { lastScrollTs = Number(e?.detail?.ts || Date.now()); schedule() }
    try { window.addEventListener('note-list-scrolling', onScroll as EventListener) } catch {}
    return () => {
      try { window.removeEventListener('note-list-scrolling', onScroll as EventListener) } catch {}
      if (timer) window.clearTimeout(timer)
      if (cleanup) cleanup()
    }
  }, [reload])

  return (
    <div className="rounded-lg border bg-zinc-50 dark:bg-zinc-900/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Related notes</div>
        <div className="inline-flex items-center gap-1 text-[11px] rounded-md p-0.5 border bg-white/60 dark:bg-zinc-900/30">
          <button
            className={`px-2 py-0.5 rounded ${mode === 'hybrid' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : 'text-foreground'}`}
            onClick={() => setMode('hybrid')}
            title="Hybrid (BM25-modulated semantic)"
          >Hybrid</button>
          <button
            className={`px-2 py-0.5 rounded ${mode === 'bm25' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' : 'text-foreground'}`}
            onClick={() => setMode('bm25')}
            title="BM25 on first field"
          >BM25</button>
          <button
            className={`px-2 py-0.5 rounded ${mode === 'semantic' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' : 'text-foreground'}`}
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
        </div>
      )}
      {loading && (
        <div className="text-[12px] text-muted-foreground">Loading related notes…</div>
      )}
      {!loading && items.length === 0 && (
        <div className="text-[12px] text-muted-foreground">No related notes found.</div>
      )}
      <div className="divide-y rounded-md border bg-white/50 dark:bg-transparent">
        {items.map((r) => {
          const n: NoteListItem = {
            note_id: r.note_id,
            first_field: r.first_field,
            score: r.score,
            // Carry through cos/bm25 when available (hybrid) and also set for pure modes
            cos: typeof r.cos === 'number' ? r.cos : (r.metric === 'cos' ? r.score : undefined),
            bm25: typeof r.bm25 === 'number' ? r.bm25 : (r.metric === 'bm25' ? r.score : undefined),
            // For semantic mode, NoteCard expects 'rerank' for Similarity%
            rerank: r.metric === 'cos' ? (typeof r.cos === 'number' ? r.cos : r.score) : undefined
          }
          return (
            <div key={r.note_id} className="px-1 py-0.5">
              <NoteCard
                n={n}
                mode={r.metric === 'bm25' ? 'exact' : r.metric === 'cos' ? 'semantic' : 'hybrid'}
                selected={false}
                selectedIds={[]}
                onSelect={(nid) => setDetailId(nid)}
                ioRoot={null}
                variant="full"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}


