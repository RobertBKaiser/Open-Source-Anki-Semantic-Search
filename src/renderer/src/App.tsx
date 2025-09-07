import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '@/components/Header'
import { NoteList } from '@/components/NoteList'
import { NoteDetails } from '@/components/NoteDetails'
import { SettingsSheet } from '@/components/SettingsSheet'
import { FooterBar } from '@/components/FooterBar'
import { EpubViewer } from '@/components/EpubViewer'
import { EpubLibrary, type LibraryBook } from '@/components/EpubLibrary'
import { EpubNotesPanel } from '@/components/EpubNotesPanel'
import { PDFReader } from '@/components/PDFReader'
import ePub from 'epubjs'

type NoteRow = { note_id: number; first_field: string | null }

function App(): React.JSX.Element {
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
  const [epubFile, setEpubFile] = useState<File | null>(null)
  const [epubUrl, setEpubUrl] = useState<string | null>(null)
  const [epubBuffer, setEpubBuffer] = useState<ArrayBuffer | null>(null)
  const [epubView, setEpubView] = useState<'library' | 'reader'>('library')
  const [library, setLibrary] = useState<LibraryBook[]>([])
  const [epubRelated, setEpubRelated] = useState<any[]>([])
  const fuzzyTimerRef = useRef<number | null>(null)
  const lastQueryRef = useRef<string>('')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [totalCount, setTotalCount] = useState<number>(0)
  const [selectedNoteIds, setSelectedNoteIds] = useState<number[]>([])
  const pageSize = 200
  const [route, setRoute] = useState<'notes' | 'epub' | 'pdf'>('notes')
  const [keywordGrouping, setKeywordGrouping] = useState<boolean>(false)
  const [groups, setGroups] = useState<Array<{ keyword: string; notes: any[]; kcos?: number; gbm25?: number }>>([])
  const [currentQuery, setCurrentQuery] = useState<string>('')
  useEffect(() => { (window as any).__route = route }, [route])
  const pdfFileRef = useRef<HTMLInputElement | null>(null)

  // Helper to fetch the current displayed notes list
  const resortedNotesCurrent = () => (notes || []).slice()

  // Recompute keyword groups from current notes using preload helpers
  const recomputeGroups = async (current: any[]) => {
    try {
      const ids = current.map((n: any) => n.note_id)
      if (ids.length === 0) { setGroups([]); return }
      const per = (window as any).api?.extractKeywordsForNotes?.(ids, 6, 500) || []
      const keyFor = (s: string) => String(s || '').toLowerCase()
      // Collect unique candidate keywords across all notes (original casing preserved via first occurrence)
      const displayFor = new Map<string, string>()
      const uniqTerms: string[] = []
      for (const row of per) {
        const kws = Array.isArray(row?.keywords) ? row.keywords : []
        for (const k of kws) {
          const lk = keyFor(k)
          if (!displayFor.has(lk)) { displayFor.set(lk, k); uniqTerms.push(k) }
        }
      }
      // Cap to top 24 to keep it responsive
      const candTerms = uniqTerms.slice(0, 24)
      // Build 2- and 3-term combos from the first few terms to bound complexity
      const seed = uniqTerms.slice(0, Math.min(6, uniqTerms.length))
      const combos: Array<{ label: string; terms: string[] }> = []
      for (let i = 0; i < seed.length; i++) {
        for (let j = i + 1; j < seed.length; j++) {
          combos.push({ label: `${seed[i]} + ${seed[j]}`, terms: [seed[i], seed[j]] })
          for (let k = j + 1; k < seed.length; k++) {
            combos.push({ label: `${seed[i]} + ${seed[j]} + ${seed[k]}`, terms: [seed[i], seed[j], seed[k]] })
          }
        }
      }
      // Assign each note to the keyword with highest cosine similarity and collect full cosine matrix
      const bestForNote = new Map<number, { term: string; cos: number }>()
      const cosMatrix = new Map<string, Map<number, number>>()
      for (const term of candTerms) {
        const cosArr = await (window as any).api?.embedCosForTermAgainstNotes?.(term, ids)
        const byId: Map<number, number> = new Map<number, number>((cosArr || []).map((r: any) => [Number(r.note_id), Number(r.cos) || -1]))
        cosMatrix.set(keyFor(term), byId)
        for (const id of ids) {
          const c = byId.get(id) ?? -1
          const cur = bestForNote.get(id)
          if (!cur || c > cur.cos) bestForNote.set(id, { term, cos: c })
        }
      }
      // Evaluate combos (mean vector of member keywords)
      for (const combo of combos) {
        const cosArr = await (window as any).api?.embedCosForTermsComboAgainstNotes?.(combo.terms, ids)
        const byId: Map<number, number> = new Map<number, number>((cosArr || []).map((r: any) => [Number(r.note_id), Number(r.cos) || -1]))
        cosMatrix.set(keyFor(combo.label), byId)
        for (const id of ids) {
          const c = byId.get(id) ?? -1
          const cur = bestForNote.get(id)
          if (!cur || c > cur.cos) bestForNote.set(id, { term: combo.label, cos: c })
        }
      }
      // Overlap selection thresholds
      const MIN_COS = 0.4
      const DELTA = 0.05
      const RATIO = 0.9
      const overlapsByNote = new Map<number, Array<{ keyword: string; cos: number }>>()
      for (const id of ids) {
        const best = bestForNote.get(id)
        const list: Array<{ keyword: string; cos: number }> = []
        if (best) {
          const bestCos = best.cos
          for (const t of candTerms) {
            const lk = keyFor(t)
            const c = cosMatrix.get(lk)?.get(id) ?? -1
            if (lk === keyFor(best.term)) continue
            if (c >= MIN_COS && (bestCos - c <= DELTA || c >= RATIO * bestCos)) {
              list.push({ keyword: displayFor.get(lk) || t, cos: c })
            }
          }
          // Include combos for overlap display
          for (const combo of combos) {
            const lk = keyFor(combo.label)
            const c = cosMatrix.get(lk)?.get(id) ?? -1
            if (lk === keyFor(best.term)) continue
            if (c >= MIN_COS && (bestCos - c <= DELTA || c >= RATIO * bestCos)) {
              list.push({ keyword: combo.label, cos: c })
            }
          }
          list.sort((a, b) => b.cos - a.cos)
        }
        overlapsByNote.set(id, list.slice(0, 2))
      }

      // Build groups from primary assignment
      const groupsMap = new Map<string, any[]>()
      for (const n of current) {
        const pick = bestForNote.get(n.note_id)
        const key = pick ? keyFor(pick.term) : keyFor((per.find((r: any) => r.note_id === n.note_id)?.keywords || ['misc'])[0])
        if (!groupsMap.has(key)) groupsMap.set(key, [])
        const gcos = cosMatrix.get(key)?.get(n.note_id) ?? -1
        const overlaps = overlapsByNote.get(n.note_id) || []
        groupsMap.get(key)!.push({ ...(n as any), __gcos: gcos, __overlaps: overlaps })
      }

      // Sort groups by semantic similarity (cosine) between keyword and the query; fallback to BM25 when no embeddings
      const grp = Array.from(groupsMap.entries()).map(([lkey, gnotes]) => ({ keyword: displayFor.get(lkey) || lkey, lkey, notes: gnotes }))
      const cosList = await (window as any).api?.cosineForTerms?.(grp.map((g) => g.keyword), currentQuery)
      if (Array.isArray(cosList) && cosList.length) {
        const cosBy = new Map(cosList.map((c: any) => [String(c.term).toLowerCase(), Number(c.cos) || -1]))
        // Compute BM25 per group (min across its notes) vs current query terms for sorting and display
        const qTerms = ((window as any).api?.extractQueryKeywords?.(currentQuery) || []) as string[]
        const withScores = grp.map((g) => {
          let gbm25 = Infinity
          if (Array.isArray(qTerms) && qTerms.length > 0) {
            const idsG = g.notes.map((n: any) => n.note_id)
            const scores = (window as any).api?.bm25ForNotesByTerms?.(qTerms, idsG) || []
            for (const r of scores) { gbm25 = Math.min(gbm25, Number(r?.bm25 ?? Infinity)) }
          }
          return { g, kcos: (cosBy.get(g.keyword.toLowerCase()) ?? -1), gbm25 }
        })
        // Sort by BM25 ascending; tie-breaker by cosine desc
        withScores.sort((a, b) => (a.gbm25 - b.gbm25) || ((b.kcos ?? -1) - (a.kcos ?? -1)))
        setGroups(withScores.map((x) => ({ keyword: x.g.keyword, notes: x.g.notes, kcos: x.kcos, gbm25: Number.isFinite(x.gbm25) ? x.gbm25 : undefined })))
      } else {
        // Fallback: min BM25 relative to the overall query terms (lowest first)
        const qTerms = ((window as any).api?.extractQueryKeywords?.(currentQuery) || []) as string[]
        if (Array.isArray(qTerms) && qTerms.length > 0) {
          const byMinBm25 = grp.map((g) => {
            const ids = g.notes.map((n: any) => n.note_id)
            const scores = (window as any).api?.bm25ForNotesByTerms?.(qTerms, ids) || []
            const min = scores.reduce((m: number, r: any) => Math.min(m, Number(r?.bm25 ?? Infinity)), Infinity)
            return { g, min }
          })
          byMinBm25.sort((a: any, b: any) => a.min - b.min)
          setGroups(byMinBm25.map((x: any) => ({ keyword: x.g.keyword, notes: x.g.notes, gbm25: Number.isFinite(x.min) ? x.min : undefined })))
        } else {
          setGroups(grp.map(({ keyword, notes }) => ({ keyword, notes })))
        }
      }
    } catch {
      setGroups([])
    }
  }

  useEffect(() => {
    function openPdf() { setRoute('pdf') }
    window.addEventListener('open-pdf-reader', openPdf)
    return () => window.removeEventListener('open-pdf-reader', openPdf)
  }, [])

  // Track current query from Header (simple global handoff)
  useEffect(() => {
    const id = window.setInterval(() => {
      try { setCurrentQuery((window as any).__current_query || '') } catch {}
    }, 250)
    return () => window.clearInterval(id)
  }, [])

  // Recompute groups when toggled on, when notes change, or when query changes
  useEffect(() => {
    if (keywordGrouping) { void recomputeGroups(notes as any) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordGrouping, notes, currentQuery])

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

  // Load EPUB library from settings on mount
  useEffect(() => {
    try {
      const raw = (window as any).api?.getSetting?.('epub_library')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setLibrary(parsed as LibraryBook[])
      }
    } catch {
      // ignore
    }
  }, [])

  // Persist library when it changes
  useEffect(() => {
    try {
      ;(window as any).api?.setSetting?.('epub_library', JSON.stringify(library))
    } catch {
      // ignore
    }
  }, [library])

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

  const selected = useMemo(() => {
    try {
      return selectedId ? window.api?.getNoteDetails?.(selectedId) ?? null : null
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load note details:', err)
      return null
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
        readerActive={route !== 'notes'}
        route={route}
        onEnterReader={() => setRoute('epub')}
        onExitReader={() => setRoute('notes')}
        onOpenEpub={route==='epub' ? async (file) => {
          // Add to library and show library view; extract cover and persist
          try {
            const filePath = (file as any).path as string | undefined
            const url = filePath ? `file://${filePath}` : URL.createObjectURL(file)
            const title = file.name.replace(/\.epub$/i, '')
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

            async function blobToDataUrl(blob: Blob): Promise<string> {
              return await new Promise<string>((resolve) => {
                const reader = new FileReader()
                reader.onload = () => resolve(String(reader.result || ''))
                reader.readAsDataURL(blob)
              })
            }

            async function extractCover(): Promise<string | null> {
              try {
                const ab = await file.arrayBuffer()
                const book = ePub(ab)
                try { await (book as any).opened } catch {}
                // Strategy 1: coverUrl()
                try {
                  if (typeof (book as any).coverUrl === 'function') {
                    const c = await (book as any).coverUrl()
                    if (c) {
                      const resp = await fetch(c)
                      if (resp.ok) {
                        const blob = await resp.blob()
                        return await blobToDataUrl(blob)
                      }
                    }
                  }
                } catch {}
                // Strategy 2: manifest metadata
                try {
                  const pkg = (book as any).packaging || {}
                  const manifest = pkg.manifest || {}
                  const meta = pkg.metadata || {}
                  let href: string | null = null
                  if (meta.cover && manifest[meta.cover]?.href) href = manifest[meta.cover].href
                  if (!href) {
                    for (const id in manifest) {
                      const item = manifest[id]
                      const props = String(item?.properties || '')
                      const t = String(item?.type || '')
                      const h = String(item?.href || '')
                      if ((/cover-image/i.test(props) || /cover/i.test(id) || /cover/i.test(h)) && t.startsWith('image/')) {
                        href = h
                        break
                      }
                    }
                  }
                  if (href) {
                    const blob = await (book as any).archive?.getBlob?.(href)
                    if (blob) return await blobToDataUrl(blob)
                  }
                } catch {}
                // Strategy 3: first image resource
                try {
                  const resources = (book as any).resources?.resources || {}
                  for (const key of Object.keys(resources)) {
                    const r = resources[key]
                    const t = String(r?.type || '')
                    if (t.startsWith('image/')) {
                      const blob = await (book as any).archive?.getBlob?.(r.href || key)
                      if (blob) return await blobToDataUrl(blob)
                    }
                  }
                } catch {}
              } catch {}
              return null
            }

            const coverDataUrl = await extractCover()

            const entry: LibraryBook = { id, title, path: url, coverDataUrl, progressPct: 0, lastCfi: null }
            setLibrary((prev) => prev.concat([entry]))
            setEpubFile(null)
            setEpubUrl(null)
            setRoute('epub')
            setEpubView('library')
          } catch {
            // ignore
          }
        } : undefined}
        onEmbedSearch={async (q) => {
          try {
            setSearching(true)
            setMode('semantic')
            // Start with no filtering so raw embedding results are visible
            setCosThreshold(0)
            const queryVal = q || (document.querySelector('input[placeholder=\"Search notes...\"]') as HTMLInputElement)?.value || ''
            const results = await window.api?.embedSearch?.(queryVal, 200)
            if (Array.isArray(results)) {
              setSemanticBase(results as any)
              setNotes(results as any)
              setSelectedId(results.length ? (results as any)[0].note_id : null)
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Embed search failed:', err)
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
        onToggleKeywordGrouping={() => setKeywordGrouping((v) => !v)}
        keywordGrouping={keywordGrouping}
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
              // If grouping is active, recompute groups after reorder
              if (keywordGrouping) {
                recomputeGroups(resortedNotesCurrent())
              }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('BM25 from terms failed:', err)
          } finally {
            setSearching(false)
          }
        }}
      />
      {/* Hidden PDF input when on PDF route (if needed later) */}
      {route==='pdf' && (
        <input ref={pdfFileRef} type="file" accept="application/pdf" className="hidden" />
      )}
      {/* View switcher */}
      {route === 'pdf' ? (
        <div className="px-4 pb-2 h-full min-h-0"><PDFReader /></div>
      ) : route === 'epub' ? (
        // previous epub block
        (epubView === 'library' || (!epubFile && !epubUrl)) ? (
          <div className="h-full min-h-0 px-4 pb-2">
            <div className="rounded-lg border bg-card overflow-hidden h-full">
              <EpubLibrary
                books={library}
                onOpen={async (b) => {
                  try {
                    setEpubFile(null)
                    setEpubUrl(b.path)
                    // Read the file through preload to avoid file:// CSP/permissions
                    const ab = await (window as any).api?.readFileBinary?.(b.path)
                    if (ab) setEpubBuffer(ab as ArrayBuffer)
                  } catch {}
                  setEpubView('reader')
                }}
                onDelete={(b) => {
                  setLibrary((prev) => prev.filter((x) => x.id !== b.id))
                }}
              />
            </div>
          </div>
        ) : (
        <div className="grid grid-cols-[3fr_2fr] h-full min-h-0 px-4 pb-2 gap-2">
          <div className="rounded-lg border bg-card overflow-hidden">
            {epubFile || epubUrl || epubBuffer ? <EpubViewer file={epubFile || undefined} url={epubUrl || undefined} buffer={epubBuffer || undefined as any} onSemanticFromSelection={async (text) => {
              try {
                setSemanticRunning(true)
                const reranked = await (window as any).api?.semanticRerankSmall?.(text)
                if (Array.isArray(reranked)) {
                  setEpubRelated(reranked as any)
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('Semantic from selection failed:', err)
              } finally {
                setSemanticRunning(false)
              }
            }} onVisibleText={async (visible) => {
              try {
                // Query related notes for current visible section text
                const reranked = await (window as any).api?.semanticRerankSmall?.(visible)
                if (Array.isArray(reranked)) {
                  setEpubRelated(reranked as any)
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('Related notes update failed:', err)
              }
            }} /> : <div className="p-4 text-sm text-muted-foreground">Open an EPUB to start reading.</div>}
          </div>
          <div className="rounded-lg border bg-card overflow-hidden">
            <EpubNotesPanel items={epubRelated as any} onSelect={setSelectedId} />
          </div>
        </div>
        )
      ) : (
        // Notes browser
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
              groups={keywordGrouping ? groups : undefined}
            />
          </div>
          <div className="rounded-lg border bg-card overflow-hidden">
        <NoteDetails data={selected} />
      </div>
        </div>
      )}
      <SettingsSheet open={openSettings} onClose={() => setOpenSettings(false)} />
      <FooterBar left={<span>Ready</span>} right={<span>{route === 'notes' ? (isSearchMode ? 'Search mode' : 'Browse mode') : route === 'epub' ? 'EPUB reader' : 'PDF reader'}</span>} />
    </div>
  )
}

export default App
