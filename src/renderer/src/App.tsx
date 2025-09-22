import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '@/components/Header'
import { NoteList } from '@/components/NoteList'
import NoteDetailsView from '@/components/NoteDetailsView'
import { SettingsSheet } from '@/components/SettingsSheet'
import { FooterBar } from '@/components/FooterBar'
import { TagManager } from '@/components/TagManager'
import { PdfPage } from '@/components/PdfPage'
// Removed EPUB/PDF reader features

type NoteRow = { note_id: number; first_field: string | null }

// TagGroup type for hierarchical tag groups with expand/collapse functionality
type TagGroup = {
  keyword: string
  notes: any[]
  kcos?: number
  gbm25?: number
  groups?: TagGroup[]
  count?: number
  expanded?: boolean
}

function App(): React.JSX.Element {
  const [route, setRoute] = useState<'notes' | 'pdf'>('notes')
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [openSettings, setOpenSettings] = useState(false)
  const [searching, setSearching] = useState(false)
  const [semanticRunning, setSemanticRunning] = useState(false)
  const [mode, setMode] = useState<'default' | 'exact' | 'fuzzy' | 'rerank' | 'semantic' | 'hybrid'>('default')
  const [cosThreshold, setCosThreshold] = useState<number>(0.5)
  const [semanticBase, setSemanticBase] = useState<any[]>([])
  const [rerankBase, setRerankBase] = useState<any[]>([])
  const [hybridBase, setHybridBase] = useState<any[]>([])
  // EPUB/PDF states removed
  const fuzzyTimerRef = useRef<number | null>(null)
  const lastQueryRef = useRef<string>('')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [totalCount, setTotalCount] = useState<number>(0)
  const [selectedNoteIds, setSelectedNoteIds] = useState<number[]>([])
  const pageSize = 200
  // Single route: notes browser
  const [groupMode, setGroupMode] = useState<'none' | 'ai' | 'concept'>('none')
  const [currentQuery, setCurrentQuery] = useState<string>('')
  // No alternate routes
  const [openTags, setOpenTags] = useState<boolean>(false)
  const [currentTagPrefix, setCurrentTagPrefix] = useState<string>('')

  // Toggle handler: pass grouping flag down; NoteList computes groups
  // No PDF reader route/events

  // Track current query from Header (simple global handoff)
  useEffect(() => {
    const id = window.setInterval(() => {
      try { setCurrentQuery((window as any).__current_query || '') } catch {}
    }, 250)
    return () => window.clearInterval(id)
  }, [])

  // No recompute; handled inside NoteList using currentQuery and visible notes

  // When adjusting threshold, filter current results for semantic, rerank, and hybrid modes
  useEffect(() => {
    if (mode === 'semantic') {
      const filtered = (semanticBase as any[]).filter((r: any) => typeof r.rerank === 'number' && r.rerank >= cosThreshold)
      setNotes(filtered as any)
      setSelectedId(filtered.length ? filtered[0].note_id : null)
    } else if (mode === 'rerank') {
      const arr = rerankBase as any[]
      const values = arr
        .map((x: any) => (typeof x.rerank === 'number' ? x.rerank : -Infinity))
        .filter((x) => Number.isFinite(x))
      if (values.length === 0) {
        // No rerank scores available; don't filter
        setNotes(arr as any)
        setSelectedId(arr.length ? (arr as any)[0].note_id : null)
      } else {
        const min = Math.min(...values)
        const max = Math.max(...values)
        const normalize = (v: number) => (max > min ? (v - min) / (max - min) : 1)
        const filtered = arr.filter((r: any) => typeof r.rerank === 'number' && normalize(r.rerank) >= cosThreshold)
        setNotes(filtered as any)
        setSelectedId(filtered.length ? filtered[0].note_id : null)
      }
    } else if (mode === 'hybrid') {
      const arr = hybridBase as any[]
      const filtered = arr.filter((r: any) => typeof r.score === 'number' && r.score >= cosThreshold)
      setNotes(filtered as any)
      setSelectedId(filtered.length ? filtered[0].note_id : null)
    }
  }, [cosThreshold, mode, semanticBase, rerankBase, hybridBase])

  // EPUB library removed

  useEffect(() => {
    try {
      const count = window.api?.countNotes?.() ?? 0
      setTotalCount(count)
      const rows = window.api?.listNotes?.(pageSize, 0) ?? []
      setNotes(rows)
      if (rows.length && !selectedId) setSelectedId(rows[0].note_id)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load notes:', err)
      setNotes([])
    }
  }, [])

  // Badge classification handler – classifies current visible notes via OpenAI
  useEffect(() => {
    function onClassify(e: any) {
      try {
        const query = String(e?.detail?.query || '')
        const visible = notes.map((n) => n.note_id)
        if (!visible.length) return
        ;(async () => {
          const res = await (window as any).api?.classifyBadges?.(visible, query)
          // eslint-disable-next-line no-console
          console.log('classifyBadges: received payload', res)
          if (!Array.isArray(res)) return
          const byId = new Map<number, any>()
          for (const r of res) byId.set(Number(r.note_id), r)
          const updated = notes.map((n) => {
            const r = byId.get(n.note_id)
            if (!r) return n
            // Prefer numeric labels (0..3) if provided
            if (typeof r.category_num === 'number') {
              const num = Math.max(0, Math.min(3, Number(r.category_num)))
              return { ...(n as any), badge_num: num }
            }
            // Fallback to named categories (legacy)
            const raw = String(r.category ?? r.badge ?? '').trim().toLowerCase()
            let cat: 'in' | 'out' | 'related' | undefined
            if (raw === 'in' || raw === 'red') cat = 'in'
            else if (raw === 'related' || raw === 'blue') cat = 'related'
            else if (raw === 'out' || raw === 'black') cat = 'out'
            return typeof cat === 'string' ? { ...(n as any), rerank_category: cat } : n
          })
          // eslint-disable-next-line no-console
          console.log('classifyBadges: applied to notes (first item)', updated[0])
          setNotes(updated as any)
        })()
      } catch {}
    }
    window.addEventListener('classify-badges', onClassify as any)
    return () => window.removeEventListener('classify-badges', onClassify as any)
  }, [notes])

  const loadMoreDefault = () => {
    if (isSearchMode) return
    if (notes.length >= totalCount) return
    try {
      const more = window.api?.listNotes?.(pageSize, notes.length) ?? []
      if (more.length) setNotes((prev) => prev.concat(more))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load more notes:', err)
    }
  }

  const [selectedDetails, setSelectedDetails] = useState<any>(null)
  useEffect(() => {
    let canceled = false
    let rafId: any = null
    let timer: any = null
    try { if (localStorage.getItem('debug.perf') === '1') { performance.mark('sel_effect_start'); console.time('details_load_total') } } catch {}
    const run = () => {
      try {
        try { if (localStorage.getItem('debug.perf') === '1') console.time('details_getNoteDetails_sync') } catch {}
        const d = selectedId ? window.api?.getNoteDetails?.(selectedId) ?? null : null
        try { if (localStorage.getItem('debug.perf') === '1') console.timeEnd('details_getNoteDetails_sync') } catch {}
        if (!canceled) setSelectedDetails(d)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to load note details:', err)
        if (!canceled) setSelectedDetails(null)
      }
    }
    if (selectedId) {
      try {
        if (typeof window.requestAnimationFrame === 'function') {
          rafId = window.requestAnimationFrame(() => run())
        } else {
          timer = window.setTimeout(run, 0)
        }
      } catch {
        timer = window.setTimeout(run, 0)
      }
    } else {
      setSelectedDetails(null)
    }
    return () => {
      try { if (localStorage.getItem('debug.perf') === '1') console.timeEnd('details_load_total') } catch {}
      canceled = true
      if (rafId) window.cancelAnimationFrame(rafId)
      if (timer) window.clearTimeout(timer)
    }
  }, [selectedId])

  const badgeCounts = useMemo(() => {
    const counts = [0, 0, 0, 0]
    for (const n of notes as any) {
      const b = (n as any)?.badge_num
      if (typeof b === 'number' && b >= 0 && b <= 3) counts[b]++
    }
    return counts
  }, [notes])

  const [grouped, setGrouped] = useState<boolean>(false)
  const onToggleGroupByBadge = () => {
    setNotes((prev: any) => {
      const arr = [...(prev as any[])]
      if (!grouped) {
        arr.sort((a: any, b: any) => {
          const aa = typeof a.badge_num === 'number' ? a.badge_num : 99
          const bb = typeof b.badge_num === 'number' ? b.badge_num : 99
          return aa - bb
        })
      } else {
        // Ungroup: restore relevance ordering depending on current mode
        if (mode === 'rerank' || mode === 'semantic') {
          arr.sort((a: any, b: any) => (b?.rerank ?? -Infinity) - (a?.rerank ?? -Infinity))
        } else if (mode === 'fuzzy') {
          // For fuzzy, prefer bm25 ascending if available, otherwise RRF desc
          arr.sort((a: any, b: any) => {
            const ab = typeof a.bm25 === 'number' ? a.bm25 : Number.POSITIVE_INFINITY
            const bbv = typeof b.bm25 === 'number' ? b.bm25 : Number.POSITIVE_INFINITY
            if (ab !== bbv) return ab - bbv
            return (b?.rrf ?? 0) - (a?.rrf ?? 0)
          })
        }
      }
      return arr as any
    })
    setGrouped((g) => !g)
  }

  const groupSelectBadge = (badge: 0 | 1 | 2 | 3) => {
    setSelectedNoteIds((prev) => {
      const set = new Set(prev)
      for (const n of notes as any) {
        if ((n as any)?.badge_num === badge) set.add(n.note_id)
      }
      return Array.from(set)
    })
  }

  const groupUnselectBadge = (badge: 0 | 1 | 2 | 3) => {
    setSelectedNoteIds((prev) => {
      const set = new Set(prev)
      for (const n of notes as any) {
        if ((n as any)?.badge_num === badge) set.delete(n.note_id)
      }
      return Array.from(set)
    })
  }

  return (
    <div className="h-screen grid grid-rows-[auto_1fr_auto] bg-background">
      <Header
        searching={searching}
        semanticRunning={semanticRunning}
        selectedIds={selectedNoteIds}
        mode={mode}
        cosThreshold={cosThreshold}
        onChangeCosThreshold={setCosThreshold}
        onEmbedSearch={async (q) => {
          try {
            setSearching(true)
            setMode('semantic')
            // Start with no filtering so raw embedding results are visible
            setCosThreshold(0)
            const queryVal = q || (document.querySelector('input[placeholder=\"Search notes...\"]') as HTMLInputElement)?.value || ''
            
            // Check if API key is configured
            const apiKey = window.api?.getSetting?.('deepinfra_api_key') || ''
            if (!apiKey) {
              // eslint-disable-next-line no-console
              console.warn('DeepInfra API key not configured. Please set it in Settings.')
              // Show user-friendly message by setting empty results
              setSemanticBase([])
              setNotes([])
              setSelectedId(null)
              return
            }
            
            const results = await window.api?.embedSearch?.(queryVal, 200)
            if (Array.isArray(results)) {
              setSemanticBase(results as any)
              setNotes(results as any)
              setSelectedId(results.length ? (results as any)[0].note_id : null)
              
              // Log results for debugging
              // eslint-disable-next-line no-console
              console.log(`Semantic search returned ${results.length} results for query: "${queryVal}"`)
            } else {
              // eslint-disable-next-line no-console
              console.warn('Semantic search returned invalid results:', results)
              setSemanticBase([])
              setNotes([])
              setSelectedId(null)
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Embed search failed:', err)
            setSemanticBase([])
            setNotes([])
            setSelectedId(null)
          } finally {
            setSearching(false)
          }
        }}
        onHybrid={async (q) => {
          try {
            setSearching(true)
            setMode('hybrid')
            setSemanticBase([])
            setRerankBase([])
            setHybridBase([])
            // Start with no filtering so full hybrid results are visible
            setCosThreshold(0)
            const queryVal = q || (document.querySelector('input[placeholder=\"Search notes...\"]') as HTMLInputElement)?.value || ''
            const results = await (window as any).api?.hybridSemanticModulated?.(queryVal, 200)
            if (Array.isArray(results)) {
              setHybridBase(results as any)
              setNotes(results as any)
              setSelectedId(results.length ? (results as any)[0].note_id : null)
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Hybrid search failed:', err)
          } finally {
            setSearching(false)
          }
        }}
        onUnsuspend={async (ids) => {
          if (!ids || ids.length === 0) return
          try {
            setSearching(true)
            const res = await window.api?.unsuspendNotes?.(ids)
            // eslint-disable-next-line no-console
            console.log('Unsuspend result:', res)
            // Clear selection on success
            if (res?.ok) setSelectedNoteIds([])
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Unsuspend failed:', err)
          } finally {
            setSearching(false)
          }
        }}
        onSearch={(q) => {
          try {
            setSearching(true)
            setMode('exact')
            setSemanticBase([])
            const trimmed = (q || '').trim()
            if (trimmed.length === 0) {
              // Return to default list mode
              setIsSearchMode(false)
              setMode('default')
              const count = window.api?.countNotes?.() ?? 0
              setTotalCount(count)
              const rows = window.api?.listNotes?.(pageSize, 0) ?? []
              setNotes(rows)
              setSelectedId(rows.length ? rows[0].note_id : null)
              return
            }
            setIsSearchMode(true)
            const rows = window.api?.searchNotes?.(trimmed, 250, 0) ?? []
            setNotes(rows)
            setSelectedId(rows.length ? rows[0].note_id : null)
            // If no exact results, schedule an automatic fuzzy search with a larger debounce
            if (rows.length === 0) {
              if (fuzzyTimerRef.current) window.clearTimeout(fuzzyTimerRef.current)
              lastQueryRef.current = q
              fuzzyTimerRef.current = window.setTimeout(() => {
                try {
                  setSearching(true)
                  setMode('fuzzy')
                  const frows = window.api?.fuzzySearch?.(lastQueryRef.current, 250) ?? []
                  // Only apply if query hasn't changed in the interim
                  if (lastQueryRef.current === q) {
                    setNotes(frows)
                    setSelectedId(frows.length ? frows[0].note_id : null)
                  }
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error('Auto-fuzzy failed:', err)
                } finally {
                  setSearching(false)
                }
              }, 700)
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Search failed:', err)
          } finally {
            setSearching(false)
          }
        }}
        onFuzzy={(q, exclude) => {
          try {
            setSearching(true)
            setMode('fuzzy')
            setSemanticBase([])
            const queryVal = q || (document.querySelector('input[placeholder=\"Search notes...\"]') as HTMLInputElement)?.value || ''
            const rows = window.api?.fuzzySearch?.(queryVal, 200, exclude) ?? []
            setNotes(rows)
            setSelectedId(rows.length ? rows[0].note_id : null)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Fuzzy search failed:', err)
          } finally {
            setSearching(false)
          }
        }}
        onSemantic={async (q) => {
          try {
            setSemanticRunning(true)
            setMode('rerank')
            setSemanticBase([])
            setRerankBase([])
            const queryVal = q || (document.querySelector('input[placeholder=\"Search notes...\"]') as HTMLInputElement)?.value || ''
            // First get fuzzy candidates
            const candidates = window.api?.fuzzySearch?.(queryVal, 200) ?? []
            // Then rerank them semantically via DeepInfra
            const reranked = await window.api?.semanticRerank?.(queryVal, 200)
            if (Array.isArray(reranked) && reranked.length) {
              // Ensure sort strictly by reranker score when available
              const sorted = reranked
                .slice()
                .sort((a: any, b: any) => (b?.rerank ?? -Infinity) - (a?.rerank ?? -Infinity))
              setRerankBase(sorted as any)
              setNotes(sorted)
              setSelectedId(sorted[0].note_id)
            } else {
              setNotes(candidates)
              setSelectedId(candidates.length ? candidates[0].note_id : null)
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Semantic rerank failed:', err)
          } finally {
            setSemanticRunning(false)
          }
        }}
        onOpenSettings={() => setOpenSettings(true)}
        badgeCounts={badgeCounts}
        grouped={grouped}
        onToggleGroupByBadge={onToggleGroupByBadge}
        onGroupSelectBadge={groupSelectBadge}
        onGroupUnselectBadge={groupUnselectBadge}
        onChangeGroupMode={(mode) => setGroupMode(mode)}
        groupMode={groupMode}
        onToggleConceptMap={() => setGroupMode((prev) => (prev === 'concept' ? 'none' : 'concept'))}
        conceptMapActive={groupMode === 'concept'}
        onBm25FromTerms={(terms) => {
          try {
            setSearching(true)
            if (mode === 'fuzzy') {
              if (!terms || terms.length === 0) { setSearching(false); return }
              const rows = (window as any).api?.searchByBm25Terms?.(terms, 200) ?? []
              setNotes(rows)
              setSelectedId(rows.length ? rows[0].note_id : null)
            } else if (mode === 'rerank' || mode === 'semantic' || mode === 'hybrid') {
              const ids = (notes || []).map((n) => n.note_id)
              if (!terms || terms.length === 0 || ids.length === 0) {
                // Restore original semantic/rerank order
                if (mode === 'semantic' && Array.isArray(semanticBase) && semanticBase.length) {
                  setNotes(semanticBase as any)
                  setSelectedId((semanticBase as any)[0]?.note_id ?? null)
                } else if (mode === 'rerank' && Array.isArray(rerankBase) && rerankBase.length) {
                  setNotes(rerankBase as any)
                  setSelectedId((rerankBase as any)[0]?.note_id ?? null)
                } else if (mode === 'hybrid') {
                  if (Array.isArray(hybridBase) && hybridBase.length) {
                    setNotes(hybridBase as any)
                    setSelectedId((hybridBase as any)[0]?.note_id ?? null)
                  }
                }
              } else {
                const scores = (window as any).api?.bm25ForNotesByTerms?.(terms, ids) ?? []
                const byId = new Map(scores.map((s: any) => [s.note_id, s.bm25]))
                const resorted = notes
                  .slice()
                  .sort((a: any, b: any) => {
                    const sa = byId.has(a.note_id) ? (byId.get(a.note_id) as number) : Infinity
                    const sb = byId.has(b.note_id) ? (byId.get(b.note_id) as number) : Infinity
                    if (sa === sb) return 0
                    return sa - sb
                  })
                setNotes(resorted)
                setSelectedId(resorted.length ? resorted[0].note_id : null)
              }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('BM25 from terms failed:', err)
          } finally {
            setSearching(false)
          }
        }}
        onOpenTags={() => setOpenTags(true)}
        onOpenPdf={() => setRoute('pdf')}
      />
      {route === 'pdf' ? (
        <div className="h-full min-h-0">
          <PdfPage onBack={() => setRoute('notes')} />
        </div>
      ) : (
        <>
          {/* Notes browser */}
          <div className="grid grid-cols-[2fr_1fr] h-full min-h-0 px-4 pb-2 gap-2 mt-2">
            <div className="rounded-lg border bg-card overflow-hidden">
              <NoteList
                notes={notes}
                selectedId={selectedId}
                onSelect={useCallback((noteId: number) => {
                  try { if (localStorage.getItem('debug.perf') === '1') performance.mark('sel_click') } catch {}
                  setSelectedId((prev) => (prev === noteId ? prev : noteId))
                }, [])}
                onEndReached={loadMoreDefault}
                mode={mode}
                selectedIds={selectedNoteIds}
                onToggleSelect={useCallback((noteId: number, checked: boolean) => {
                  setSelectedNoteIds((prev) => {
                    const set = new Set(prev)
                    if (checked) set.add(noteId)
                    else set.delete(noteId)
                    return Array.from(set)
                  })
                }, [])}
                groupMode={groupMode}
                currentQuery={currentQuery}
                currentTagPrefix={currentTagPrefix}
                onTagPrefixChange={(prefix) => {
                  setCurrentTagPrefix(prefix)
                  try {
                    if (!prefix) {
                      const initial = (window as any).api?.listNotes?.(pageSize, 0) ?? []
                      setNotes(initial)
                      setSelectedId(initial.length ? initial[0].note_id : null)
                    } else {
                      const arr = (window as any).api?.getNotesByTagPrefix?.(prefix, 2000, 0) ?? []
                      setNotes(arr)
                      setSelectedId(arr.length ? arr[0].note_id : null)
                    }
                  } catch {}
                }}
              />
            </div>
            <div className="rounded-lg border bg-card overflow-hidden">
              <NoteDetailsView data={selectedDetails} />
            </div>
          </div>
          <SettingsSheet open={openSettings} onClose={() => setOpenSettings(false)} />
          <TagManager
            open={openTags}
            onClose={() => setOpenTags(false)}
            onSelectPrefix={(prefix) => {
              setOpenTags(false)
              setCurrentTagPrefix(prefix)
              try {
                if (!prefix) {
                  const initial = (window as any).api?.listNotes?.(pageSize, 0) ?? []
                  setNotes(initial)
                  setSelectedId(initial.length ? initial[0].note_id : null)
                } else {
                  const arr = (window as any).api?.getNotesByTagPrefix?.(prefix, 2000, 0) ?? []
                  setNotes(arr)
                  setSelectedId(arr.length ? arr[0].note_id : null)
                }
                setGroups([])
              } catch {}
            }}
          />
        </>
      )}
      <FooterBar left={<span>{route === 'pdf' ? 'PDF' : 'Ready'}</span>} right={<span>{isSearchMode ? 'Search mode' : 'Browse mode'}</span>} />
    </div>
  )
}

export default App
