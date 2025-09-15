import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { FixedSizeList as VList, type ListChildComponentProps } from 'react-window'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { NoteCard, type NoteCardMode, type NoteListItem } from '@/components/note/NoteCard'
import { NoteGroup } from '@/components/tags/NoteGroup'
import type { TagGroup as TagGroupType } from '@/components/tags/NoteGroup'
import type { TagGroup } from '@/components/tags/NoteGroup'
// Memoized wrapper to prevent non-selected rows from re-rendering on selection changes
const MemoNoteCard = memo(NoteCard, (prev, next) => {
  // Re-render only if the specific note row selection or mode or note reference changes
  return prev.n === next.n && prev.selected === next.selected && prev.mode === next.mode
})

// Types moved to dedicated components: NoteCard (NoteListItem) and NoteGroup (TagGroup)

type NoteListProps = {
  notes: NoteListItem[]
  selectedId: number | null
  onSelect: (noteId: number) => void
  onEndReached?: () => void
  mode?: NoteCardMode
  selectedIds?: number[]
  onToggleSelect?: (noteId: number, selected: boolean) => void
  aiGrouping?: boolean
  currentQuery?: string
  currentTagPrefix?: string
  onTagPrefixChange?: (prefix: string) => void
}

// (removed) decode/strip helpers; handled inline in PreviewText

// (removed) helpers no longer used by the list preview

// Render preview with cloze inner text colorized, no HTML/cloze syntax visible, media/audio abbreviated
// (removed) previous JSX-based preview renderer

export function NoteList({ notes, selectedId, onSelect, onEndReached, mode = 'default', selectedIds = [], onToggleSelect, aiGrouping = false, currentQuery = '', currentTagPrefix = '', onTagPrefixChange }: NoteListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const outerRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number>(400)
  // Dev memory logger (opt-in via localStorage.debug.mem = '1')
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    if (localStorage.getItem('debug.mem') !== '1') return
    type ProcessMemoryInfo = { workingSetSize: number; peakWorkingSetSize?: number; privateBytes?: number; residentSet?: number }
    const getMemInfo = async (): Promise<ProcessMemoryInfo | null> => {
      try {
        const fn = (process as unknown as { getProcessMemoryInfo?: () => Promise<ProcessMemoryInfo> }).getProcessMemoryInfo
        if (typeof fn === 'function') return await fn()
      } catch {}
      return null
    }
    const getHeap = (): { used: number; total: number } | null => {
      try {
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
        if (m) return { used: m.usedJSHeapSize, total: m.totalJSHeapSize }
      } catch {}
      return null
    }
    ;(async () => {
      const pi = await getMemInfo()
      const heap = getHeap()
      try { console.log('[mem] NoteList mount', { process: pi, heap }) } catch {}
    })()
  }, [])
  
  // Global expand/collapse controls - must be at top level to follow Rules of Hooks
  // These hooks are used by the groups rendering but must be declared unconditionally
  const [expandVersion, setExpandVersion] = useState<number>(0)
  const [defaultExpanded, setDefaultExpanded] = useState<boolean>(true)
  
  // Tag navigation state - must be at top level to follow Rules of Hooks
  // This prevents React error #310 (conditional hook calls)
  const [tagGroups, setTagGroups] = useState<TagGroupType[]>([])
  // AI groups computed from current visible notes
  const [aiGroups, setAiGroups] = useState<TagGroupType[]>([])
  // Expanded state for virtualized grouped views
  // Deprecated per new AI grouping UI (reuse Tag NoteGroup UI)
  // const [expandedAiKeys, setExpandedAiKeys] = useState<Set<string>>(new Set())
  const [expandedTagKeys, setExpandedTagKeys] = useState<Set<string>>(new Set())
  
  // Calculate total notes for AI groups using unique note IDs (avoid double-counting across groups)
  const totalNotesAi = useMemo(() => {
    if (!aiGrouping || aiGroups.length === 0) return 0
    const ids = new Set<number>()
    const add = (g: TagGroup): void => {
      if (Array.isArray(g.notes)) g.notes.forEach((n: any) => ids.add(Number(n?.note_id)))
      if (Array.isArray(g.groups)) g.groups.forEach(add)
    }
    aiGroups.forEach(add)
    return ids.size
  }, [aiGrouping, aiGroups])

  // Flatten groups into a single virtualized row list
  type GroupRowHeader = { type: 'header'; key: string; depth: number; label: string; count: number; kcos?: number; gbm25?: number }
  type GroupRowNote = { type: 'note'; note: NoteListItem }
  type GroupRow = GroupRowHeader | GroupRowNote

  const computeGroupUniqueCount = useCallback((g: any): number => {
    const ids = new Set<number>()
    const add = (node: any) => {
      if (Array.isArray(node.notes)) node.notes.forEach((n: any) => ids.add(Number(n?.note_id)))
      if (Array.isArray(node.groups)) node.groups.forEach(add)
    }
    add(g)
    return ids.size
  }, [])

  const flattenGroups = useCallback((groups: any[], expanded: Set<string>, parentKey = '', depth = 0): { rows: GroupRow[]; keys: string[] } => {
    const out: GroupRow[] = []
    const keys: string[] = []
    for (const g of groups) {
      const key = parentKey ? `${parentKey}//${g.keyword}` : String(g.keyword)
      const count = computeGroupUniqueCount(g)
      out.push({ type: 'header', key, depth, label: String(g.keyword || ''), count, kcos: g.kcos, gbm25: g.gbm25 })
      keys.push(key)
      if (expanded.has(key)) {
        if (Array.isArray(g.notes)) {
          for (const n of g.notes) out.push({ type: 'note', note: n })
        }
        if (Array.isArray(g.groups) && g.groups.length > 0) {
          const sub = flattenGroups(g.groups, expanded, key, depth + 1)
          out.push(...sub.rows)
          keys.push(...sub.keys)
        }
      }
    }
    return { rows: out, keys }
  }, [computeGroupUniqueCount])

  // AI rows virtualized view removed; AI grouping now reuses Tag NoteGroup UI

  const tagRowsMemo = useMemo(() => {
    if (!currentTagPrefix || tagGroups.length === 0) return { rows: [] as GroupRow[], keys: [] as string[] }
    return flattenGroups(tagGroups, expandedTagKeys)
  }, [currentTagPrefix, tagGroups, expandedTagKeys, flattenGroups])
  
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setHeight(el.clientHeight || 400)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  
  // Build hierarchical tag groups when currentTagPrefix changes
  useEffect(() => {
    if (!currentTagPrefix || !onTagPrefixChange) {
      setTagGroups([])
      return
    }
    
    let alive = true
    const MAX_DEPTH = 3
    
    const build = async (prefix: string, depth: number): Promise<any[]> => {
      if (depth > MAX_DEPTH) return []
      const children = ((window as any).api?.getChildTags?.(prefix)) || []
      if (!Array.isArray(children) || children.length === 0) {
        const ns = ((window as any).api?.getNotesByTagPrefix?.(prefix, 500, 0)) || []
        const label = String(prefix || '').split('::').pop() || prefix
        return [{ keyword: label, notes: ns, count: ns.length, expanded: depth < 2 }]
      }
      const out: any[] = []
      // Limit children to prevent performance issues
      const limitedChildren = children.slice(0, 20)
      for (const c of limitedChildren) {
        const tail = String(c.tag || '').split('::').pop() || c.tag
        const subs = await build(c.tag, depth + 1)
        // If subs is a single leaf with same label (edge case), keep hierarchy
        if (Array.isArray(subs) && subs.length > 0) {
          // Determine whether leaf: if first item has groups undefined and others too
          const hasGroups = subs.some((s: any) => Array.isArray(s.groups) && s.groups.length > 0)
          const node: any = { 
            keyword: tail, 
            notes: [], 
            groups: subs, 
            count: Number(c.notes || 0),
            expanded: depth < 2 // Auto-expand first two levels
          }
          out.push(node)
        } else {
          // No deeper children; fetch notes directly
          const ns = ((window as any).api?.getNotesByTagPrefix?.(c.tag, 500, 0)) || []
          out.push({ 
            keyword: tail, 
            notes: ns, 
            count: Number(c.notes || ns.length || 0),
            expanded: depth < 2 // Auto-expand first two levels
          })
        }
      }
      return out
    }
    
    ;(async () => {
      try {
        const tree = await build(currentTagPrefix, 1)
        if (!alive) return
        setTagGroups(tree as any)
      } catch {
        if (alive) setTagGroups([])
      }
    })()
    return () => { alive = false }
  }, [currentTagPrefix, onTagPrefixChange])

  // Build AI groups from current visible notes when enabled
  useEffect(() => {
    if (!aiGrouping) { setAiGroups([]); return }
    let alive = true
    ;(async () => {
      try {
        const subset = (notes || []).slice(0, 60)
        const ids = subset.map((n) => n.note_id)
        if (!ids.length) { if (alive) setAiGroups([]); return }
        const res = await (window as any).api?.groupNotesByAI?.(ids, currentQuery)
        const groupsIn: any[] = Array.isArray(res) ? res : (Array.isArray((res as any)?.groups) ? (res as any).groups : [])
        const hierarchyIn: Array<{ label: string; children: string[] }> = Array.isArray((res as any)?.hierarchy) ? (res as any).hierarchy : []
        if (!Array.isArray(groupsIn) || groupsIn.length === 0) { if (alive) setAiGroups([]); return }
        const byId = new Map<number, any>(subset.map((n: any) => [n.note_id, n]))
        // Build hierarchy nodes first
        const nodeMap = new Map<string, TagGroupType>()
        const getNode = (label: string): TagGroupType => {
          const key = String(label || '')
          if (!nodeMap.has(key)) nodeMap.set(key, { keyword: key, notes: [], groups: [] })
          return nodeMap.get(key) as TagGroupType
        }
        const childSet = new Set<string>()
        for (const h of hierarchyIn) {
          const parent = getNode(h.label)
          const children = Array.isArray(h.children) ? h.children : []
          for (const c of children) {
            const child = getNode(String(c))
            parent.groups = parent.groups || []
            if (!parent.groups.includes(child)) parent.groups.push(child)
            childSet.add(child.keyword)
          }
        }
        // Assign notes to their labeled nodes, de-duplicating across labels
        const assigned = new Set<number>()
        for (const g of groupsIn as any[]) {
          const label = String(g?.label || '')
          const node = getNode(label)
          const rawIds = Array.isArray(g?.notes) ? g.notes.map((x: any) => Number(x)) : []
          const filteredIds = rawIds.filter((id: number) => byId.has(id) && !assigned.has(id))
          filteredIds.sort((a: number, b: number) => a - b)
          filteredIds.forEach((id: number) => assigned.add(id))
          if (filteredIds.length > 0) {
            node.notes = (node.notes || []).concat(filteredIds.map((id: number) => byId.get(id)))
          }
        }
        // Leftovers go into an 'Other' root group
        const leftover = ids.filter((id) => byId.has(id) && !assigned.has(id))
        if (leftover.length > 0) {
          const other = getNode('Other')
          other.notes = (other.notes || []).concat(leftover.map((id) => byId.get(id)))
        }
        // Determine roots
        const labels = Array.from(nodeMap.keys())
        const rootLabels = hierarchyIn.length > 0 ? labels.filter((l) => !childSet.has(l)) : labels
        const roots = rootLabels.map((l) => nodeMap.get(l) as TagGroupType)
        // Sort roots alphabetically by label for consistency
        roots.sort((a: any, b: any) => String(a.keyword).localeCompare(String(b.keyword)))
        if (alive) setAiGroups(roots)
      } catch {
        if (alive) setAiGroups([])
      }
    })()
    return () => { alive = false }
  }, [aiGrouping, notes, currentQuery])

  const ITEM_SIZE = 36
  const MAX_NOTES_PER_GROUP = 100 // Performance limit for non-virtualized rendering
  const VIRTUALIZATION_THRESHOLD = 50 // Use virtualization when more than this many notes
  
  // Performance optimizations for large note lists:
  // - Virtualization for notes > VIRTUALIZATION_THRESHOLD
  // - Memoized components to prevent unnecessary re-renders
  // - Limited depth (MAX_DEPTH = 3) and children (20 per level) in tag hierarchy
  // - Truncation of large groups (50 groups max, 30 tag groups max)
  // - Performance monitoring with total note counts

  // Memoized virtualized note renderer for performance
  const VirtualizedNotesRenderer = memo(({ 
    notes, 
    height = 200 
  }: { 
    notes: NoteListItem[]
    height?: number 
  }) => {
    const sortedNotes = useMemo(() => 
      notes.slice().sort((a: any, b: any) => (b?.__gcos ?? -1) - (a?.__gcos ?? -1)),
      [notes]
    )

    if (sortedNotes.length === 0) return null

    return (
      <VList
        height={Math.min(height, sortedNotes.length * ITEM_SIZE)}
        width="100%"
        itemCount={sortedNotes.length}
        itemSize={ITEM_SIZE}
        itemData={{ notes: sortedNotes }}
        itemKey={(index, data) => (data.notes[index]?.note_id ?? index)}
        overscanCount={3} // Reduced from 5 to 3 for better memory efficiency
      >
        {Row}
      </VList>
    )
  })

  // Memoized inline note renderer for small lists (uses NoteCard)
  const InlineNotesRenderer = memo(({ notes }: { notes: NoteListItem[] }) => {
    const sortedNotes = useMemo(() => 
      notes.slice().sort((a: any, b: any) => (b?.__gcos ?? -1) - (a?.__gcos ?? -1)),
      [notes]
    )

    return (
      <>
        {sortedNotes.map((n) => (
          <MemoNoteCard
            key={n.note_id}
            n={n}
            mode={mode}
            selected={selectedId === n.note_id}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            onSelect={onSelect}
            ioRoot={containerRef.current}
            variant="line"
          />
        ))}
      </>
    )
  })
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
  // Duplicated row UI helpers removed: unified via MemoNoteCard
 
  // (PreviewText/ScoreBadges/formatJaccardPercent) were duplicated here; now provided by NoteCard

  const Row = useCallback(({ index, style, data }: ListChildComponentProps<any>) => {
    const n: NoteListItem = data.notes[index]
    const selectedIdFromData: number | null = (data as any)?.selectedId ?? null
    return (
      <div key={n.note_id} style={style} className="border-b">
        <MemoNoteCard
          n={n}
          mode={mode}
          selected={selectedIdFromData === n.note_id}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onSelect={onSelect}
          ioRoot={outerRef.current}
        />
      </div>
    )
  }, [mode, onSelect, onToggleSelect, selectedIds])

  // Note: inline row rendering is handled directly via MemoNoteCard where needed

  // Component to render hierarchical tag groups with improved UI/UX and accessibility
  // - Full-width design extending to the right edge of the note list
  // - Thinner profile with reduced padding and smaller font sizes
  // - More curved corners (rounded-lg) for a softer appearance
  // - Note count displayed on the right side in a rounded badge
  // - Larger toggle target with keyboard support (Enter/Space)
  // - Smooth expand/collapse animation and indentation per depth
  // - Aggregated count badge (notes + nested) positioned on the right
  // - Click anywhere on the header to toggle
  // - Global expand/collapse controls with visual feedback
  // - Better visual hierarchy with proper spacing and gradients
  const TagGroupComponent = React.memo(({ 
    group, 
    depth = 0, 
    expandVersion, 
    defaultExpanded 
  }: { 
    group: TagGroup; 
    depth?: number; 
    expandVersion?: number; 
    defaultExpanded?: boolean 
  }) => {
    const [expanded, setExpanded] = useState<boolean>(Boolean(typeof defaultExpanded === 'boolean' ? defaultExpanded : (group.expanded || depth < 2)))
    const hasSubGroups = Array.isArray(group.groups) && group.groups.length > 0
    const hasNotes = Array.isArray(group.notes) && group.notes.length > 0
    const canExpand = hasSubGroups || hasNotes

    // Respond to parent "expand all / collapse all" commands
    useEffect(() => {
      if (typeof defaultExpanded === 'boolean') setExpanded(defaultExpanded)
    }, [expandVersion, defaultExpanded])

    // Compute aggregated unique note count (union of note_ids across this group and sub-groups)
    const totalCount = useMemo(() => {
      const ids = new Set<number>()
      const add = (g: TagGroup): void => {
        if (Array.isArray(g.notes)) g.notes.forEach((n: any) => ids.add(Number(n?.note_id)))
        if (Array.isArray(g.groups)) g.groups.forEach(add)
      }
      add(group)
      return ids.size
    }, [group])

    // Indentation guide per level
    const indentStyle = { marginLeft: `${Math.max(0, depth) * 12}px` }

    return (
      <div className="mb-1" style={indentStyle}>
        {/* Header - Full width, thinner design */}
        <div className="sticky top-0 z-10">
          <button
            className="w-full text-left"
            onClick={() => canExpand && setExpanded((v) => !v)}
            onKeyDown={(e) => {
              if (!canExpand) return
              if (e.key === 'Enter' || e.key === ' ') { 
                e.preventDefault(); 
                setExpanded((v) => !v) 
              }
            }}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.keyword}`}
          >
            <div className="flex items-center justify-between w-full px-3 py-1 bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-sm hover:shadow-md hover:brightness-105 active:brightness-95 transition-all duration-150 rounded-lg">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {canExpand ? (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-white/10 flex-shrink-0">
                    {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  </span>
                ) : (
                  <span className="w-4 h-4 flex-shrink-0" />
                )}
                <span className="truncate text-xs font-medium" title={group.keyword}>{group.keyword}</span>
                {typeof group.kcos === 'number' && group.kcos >= 0 && (
                  <span className="text-[10px] rounded bg-white/20 px-1 py-[1px] flex-shrink-0">{(group.kcos * 100).toFixed(1)}%</span>
                )}
                {typeof group.gbm25 === 'number' && (
                  <span className="text-[10px] rounded bg-white/20 px-1 py-[1px] flex-shrink-0">BM25 {group.gbm25.toFixed(2)}</span>
                )}
              </div>
              {totalCount > 0 && (
                <span className="text-xs font-semibold bg-white/20 rounded-full px-2 py-0.5 flex-shrink-0 ml-2">
                  {totalCount}
                </span>
              )}
            </div>
          </button>
        </div>

        {/* Content with animation */}
        <div className={`transition-all duration-200 ease-in-out overflow-hidden ${expanded ? 'max-h-[3000px] opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="mt-1 border bg-white/80 dark:bg-zinc-900/40 divide-y shadow-sm">
            {/* Direct notes - always use inline rendering to avoid separate scroll containers */}
            {hasNotes && (
              <InlineNotesRenderer notes={group.notes} />
            )}
            
            {/* Sub-groups - limit depth and use lazy loading */}
            {hasSubGroups && depth < 3 && group.groups!.slice(0, 20).map((subGroup, index) => (
              <TagGroupComponent
                key={`${subGroup.keyword}-${index}`}
                group={subGroup}
                depth={depth + 1}
                expandVersion={expandVersion}
                defaultExpanded={defaultExpanded}
              />
            ))}
            
            {/* Show truncation message for large groups */}
            {hasSubGroups && group.groups!.length > 20 && (
              <div className="px-3 py-2 text-xs text-muted-foreground bg-yellow-50 dark:bg-yellow-900/20 border-t">
                Showing first 20 of {group.groups!.length} sub-groups. Use search to narrow results.
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }, (prev, next) => {
    return prev.group === next.group && prev.depth === next.depth && prev.expandVersion === next.expandVersion && prev.defaultExpanded === next.defaultExpanded
  })

  // Tag navigation breadcrumbs with dropdown functionality (similar to TagNotesOverlay)
  // Shows hierarchical tag path with clickable breadcrumbs and dropdown menus for tag navigation
  const TagNavigation = () => {
    if (!currentTagPrefix || !onTagPrefixChange) return null
    
    const [drop, setDrop] = useState<null | { idx: number; items: Array<{ tag: string; notes: number }>; query: string; rect: { left: number; top: number; bottom: number; width: number } }>(null)
    
    const parts = currentTagPrefix.split('::').filter(Boolean)
    const buildPrefix = (idx: number) => parts.slice(0, idx + 1).join('::')
    const buildParent = (idx: number) => parts.slice(0, Math.max(0, idx)).join('::')
    
    const onCrumbClick = (idx: number, ev: React.MouseEvent) => {
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
      const parent = buildParent(idx)
      try {
        let rows = ((window as any).api?.getChildTags?.(parent)) || []
        if ((!rows || rows.length === 0) && (window as any).api?.listAllTags) {
          // Fallback: compute from full tag list
          const all: Array<{ tag: string; notes: number }> = ((window as any).api?.listAllTags?.()) || []
          const map = new Map<string, number>()
          for (const r of all) {
            const t = String(r.tag || '')
            if (parent) {
              if (t === parent || t.startsWith(parent + '::')) {
                const rest = t.slice(parent.length)
                if (rest.startsWith('::')) {
                  const after = rest.slice(2)
                  const child = after.includes('::') ? after.slice(0, after.indexOf('::')) : after
                  const full = parent + '::' + child
                  map.set(full, (map.get(full) || 0) + Number(r.notes || 0))
                }
              }
            } else {
              const head = t.includes('::') ? t.slice(0, t.indexOf('::')) : t
              map.set(head, (map.get(head) || 0) + Number(r.notes || 0))
            }
          }
          rows = Array.from(map.entries()).map(([tag, notes]) => ({ tag, notes }))
        }
        setDrop({ idx, items: rows || [], query: '', rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } })
      } catch {
        setDrop({ idx, items: [], query: '', rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } })
      }
    }
    
    // Close dropdown on outside click or ESC
    useEffect(() => {
      if (!drop) return
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrop(null) }
      const onClick = (e: MouseEvent) => {
        try {
          const target = e.target as HTMLElement
          // If click is inside our menu, ignore
          if (target.closest && target.closest('.tag-sibling-menu')) return
        } catch {}
        setDrop(null)
      }
      window.addEventListener('keydown', onKey)
      window.addEventListener('mousedown', onClick)
      return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick) }
    }, [drop])
    
    return (
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur border-b px-3 py-2">
        <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Tag</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {parts.map((p, idx) => {
              const full = buildPrefix(idx)
              return (
                <div key={full} className="flex items-center gap-1.5">
                  {idx > 0 && <span className="text-muted-foreground">{` \\ `}</span>}
                  <button
                    className="underline text-sky-700 hover:text-sky-900 dark:text-sky-300 text-[12px] max-w-[28ch] truncate"
                    onClick={(e) => onCrumbClick(idx, e)}
                    title={`Choose a different '${p}' at this level`}
                  >
                    {idx === 0 && !p.startsWith('#') ? `#${p}` : p}
                  </button>
                </div>
              )
            })}
            {/* Blank slot to go deeper if children exist */}
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{` \\ `}</span>
              <button
                className="underline text-sky-700 hover:text-sky-900 dark:text-sky-300 text-[12px]"
                title="Choose a deeper subtag"
                onClick={(e) => onCrumbClick(parts.length, e)}
              >
                ...
              </button>
            </div>
            {/* Clear all button */}
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{` \\ `}</span>
              <button
                className="underline text-sky-700 hover:text-sky-900 dark:text-sky-300 text-[12px]"
                onClick={() => onTagPrefixChange('')}
                title="Clear tag filter"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
        
        {/* Dropdown menu */}
        {drop && (
          <div className="fixed z-50 tag-sibling-menu" style={{ left: drop.rect.left, top: drop.rect.bottom + 6, minWidth: Math.max(220, drop.rect.width) }}>
            <div className="rounded-md border bg-white shadow-xl dark:bg-zinc-900/95 dark:border-zinc-700 p-1">
              <div className="max-h-64 overflow-auto">
                {drop.items.map((s) => {
                  const label = (s.tag.split('::').pop() || s.tag)
                  return (
                    <button
                      key={s.tag}
                      className="w-full text-left text-[12px] px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                      onClick={() => { onTagPrefixChange(s.tag); setDrop(null) }}
                      title={s.tag}
                    >
                      <span className="truncate">{label}</span>
                      <span className="text-[10px] opacity-70 ml-2">{s.notes}</span>
                    </button>
                  )
                })}
                {drop.items.length === 0 && (
                  <div className="text-[12px] text-muted-foreground px-2 py-1">No options</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // AI grouping view (reuse Tag NoteGroup UI). No layout from AI code; only labels and note sets.
  if (aiGrouping && aiGroups.length > 0) {
    return (
      <div ref={containerRef} className="min-h-0 h-full overflow-y-auto">
        <div className="sticky top-0 z-20 bg-background/80 backdrop-blur border-b px-3 py-2 flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">AI Groups</span>
            <span className="text-xs text-muted-foreground">({aiGroups.length} groups, {totalNotesAi} notes)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="text-xs px-3 py-1 rounded-md border bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30 transition-colors"
              onClick={() => { setDefaultExpanded(true); setExpandVersion((v) => v + 1) }}
            >
              <ChevronDown className="w-3 h-3 inline mr-1" />
              Expand All
            </button>
            <button
              className="text-xs px-3 py-1 rounded-md border bg-zinc-50 text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 transition-colors"
              onClick={() => { setDefaultExpanded(false); setExpandVersion((v) => v + 1) }}
            >
              <ChevronRight className="w-3 h-3 inline mr-1" />
              Collapse All
            </button>
          </div>
        </div>
        <div className="px-2 py-2">
          {aiGroups.map((g, idx) => (
            <NoteGroup
              key={`${g.keyword}-${idx}`}
              group={g as any}
              depth={0}
              expandVersion={expandVersion}
              defaultExpanded={defaultExpanded}
              mode={mode as any}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    )
  }

  // Show tag navigation with hierarchical grouping when not in groups mode
  // Includes dropdown menus for tag navigation and hierarchical grouping of notes and sub-tags
  if (currentTagPrefix && onTagPrefixChange) {
    return (
      <div ref={containerRef} className="min-h-0 h-full overflow-y-auto">
        <TagNavigation />
        <VList
          height={height}
          width={'100%'}
          itemCount={tagRowsMemo.rows.length}
          itemSize={ITEM_SIZE}
          itemKey={(index) => {
            const r = tagRowsMemo.rows[index] as any
            return r.type === 'header' ? `th:${r.key}` : `tn:${r.note.note_id}`
          }}
        >
          {({ index, style }) => {
            const row = tagRowsMemo.rows[index] as any
            if (row.type === 'header') {
              const isOpen = expandedTagKeys.has(row.key)
              return (
                <div style={style} className="px-3 py-1 bg-gradient-to-r from-blue-600 to-blue-700 text-white" onClick={() => {
                  const next = new Set(expandedTagKeys)
                  if (isOpen) next.delete(row.key); else next.add(row.key)
                  setExpandedTagKeys(next)
                }}>
                  <div className="flex items-center justify-between" style={{ marginLeft: `${row.depth * 12}px` }}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-white/10 flex-shrink-0">{isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</span>
                      <span className="truncate text-xs font-medium" title={row.label}>{row.label}</span>
                    </div>
                    <span className="text-xs font-semibold bg-white/20 rounded-full px-2 py-0.5 flex-shrink-0 ml-2">{row.count}</span>
                  </div>
                </div>
              )
            }
            const note = row.note as NoteListItem
            return (
              <div style={style} className="border-b">
                <MemoNoteCard
                  n={note}
                  mode={mode}
                  selected={selectedId === note.note_id}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onSelect={onSelect}
                  ioRoot={containerRef.current}
                  variant="line"
                />
              </div>
            )
          }}
        </VList>
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
        itemData={{ notes, selectedId }}
        itemKey={(index, data) => (data.notes[index]?.note_id ?? index)}
        overscanCount={4}
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
