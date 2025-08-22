import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '@/components/Header'
import { NoteList } from '@/components/NoteList'
import { NoteDetails } from '@/components/NoteDetails'
import { SettingsSheet } from '@/components/SettingsSheet'
import { FooterBar } from '@/components/FooterBar'

type NoteRow = { note_id: number; first_field: string | null }

function App(): React.JSX.Element {
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [openSettings, setOpenSettings] = useState(false)
  const [searching, setSearching] = useState(false)
  const [semanticRunning, setSemanticRunning] = useState(false)
  const [showingSemantic, setShowingSemantic] = useState(false)
  const [mode, setMode] = useState<'default' | 'exact' | 'fuzzy' | 'rerank' | 'semantic'>('default')
  const [cosThreshold, setCosThreshold] = useState<number>(0.5)
  const [semanticBase, setSemanticBase] = useState<any[]>([])
  const [rerankBase, setRerankBase] = useState<any[]>([])
  const fuzzyTimerRef = useRef<number | null>(null)
  const lastQueryRef = useRef<string>('')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [totalCount, setTotalCount] = useState<number>(0)
  const [selectedNoteIds, setSelectedNoteIds] = useState<number[]>([])
  const pageSize = 200

  // When adjusting threshold, filter current results for semantic and rerank modes
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
      const min = values.length ? Math.min(...values) : 0
      const max = values.length ? Math.max(...values) : 1
      const normalize = (v: number) => (max > min ? (v - min) / (max - min) : 1)
      const filtered = arr.filter((r: any) => typeof r.rerank === 'number' && normalize(r.rerank) >= cosThreshold)
      setNotes(filtered as any)
      setSelectedId(filtered.length ? filtered[0].note_id : null)
    }
  }, [cosThreshold, mode, semanticBase, rerankBase])

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

  const selected = useMemo(() => {
    try {
      return selectedId ? window.api?.getNoteDetails?.(selectedId) ?? null : null
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load note details:', err)
      return null
    }
  }, [selectedId])

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
            setCosThreshold(0.5)
            const queryVal = q || (document.querySelector('input[placeholder="Search notes..."]') as HTMLInputElement)?.value || ''
            const results = await window.api?.embedSearch?.(queryVal, 200)
            if (Array.isArray(results)) {
              setSemanticBase(results as any)
              const filtered = (results as any).filter((r: any) => typeof r.rerank === 'number' && r.rerank >= 0.5)
              setNotes(filtered)
              setSelectedId(filtered.length ? filtered[0].note_id : null)
              setShowingSemantic(filtered.length > 0)
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Embed search failed:', err)
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
            setShowingSemantic(false)
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
            const rows = window.api?.searchNotes?.(trimmed, 2000, 0) ?? []
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
                  const frows = window.api?.fuzzySearch?.(lastQueryRef.current, 2000) ?? []
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
            setShowingSemantic(false)
            setMode('fuzzy')
            setSemanticBase([])
            const queryVal = q || (document.querySelector('input[placeholder="Search notes..."]') as HTMLInputElement)?.value || ''
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
            const queryVal = q || (document.querySelector('input[placeholder="Search notes..."]') as HTMLInputElement)?.value || ''
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
              setShowingSemantic(true)
            } else {
              setNotes(candidates)
              setSelectedId(candidates.length ? candidates[0].note_id : null)
              setShowingSemantic(false)
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Semantic rerank failed:', err)
          } finally {
            setSemanticRunning(false)
          }
        }}
        onOpenSettings={() => setOpenSettings(true)}
      />
       <div className="px-4 py-2 text-xs text-muted-foreground">
         {isSearchMode ? `${notes.length} results` : `${notes.length} of ${totalCount} notes`}
       </div>
      <div className="grid grid-cols-[2fr_1fr] h-full min-h-0 px-4 pb-2 gap-2">
        <div className="rounded-lg border bg-card overflow-hidden">
          <NoteList
            notes={notes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onEndReached={loadMoreDefault}
            mode={mode}
            selectedIds={selectedNoteIds}
            onToggleSelect={(noteId, checked) => {
              setSelectedNoteIds((prev) => {
                const set = new Set(prev)
                if (checked) set.add(noteId)
                else set.delete(noteId)
                return Array.from(set)
              })
            }}
          />
        </div>
        <div className="rounded-lg border bg-card overflow-hidden">
          <NoteDetails data={selected} />
        </div>
      </div>
      <SettingsSheet open={openSettings} onClose={() => setOpenSettings(false)} />
      <FooterBar left={<span>Ready</span>} right={<span>{isSearchMode ? 'Search mode' : 'Browse mode'}</span>} />
    </div>
  )
}

export default App
