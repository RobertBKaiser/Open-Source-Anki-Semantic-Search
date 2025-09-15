import React, { useMemo, useState, useEffect } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { NoteCard, type NoteCardMode, type NoteListItem } from '@/components/note/NoteCard'

export type TagGroup = {
  keyword: string
  notes: NoteListItem[]
  kcos?: number
  gbm25?: number
  groups?: TagGroup[]
  count?: number
  expanded?: boolean
}

export function NoteGroup({
  group,
  depth = 0,
  expandVersion,
  defaultExpanded,
  mode,
  selectedId,
  selectedIds = [],
  onToggleSelect,
  onSelect
}: {
  group: TagGroup
  depth?: number
  expandVersion?: number
  defaultExpanded?: boolean
  mode: NoteCardMode
  selectedId: number | null
  selectedIds?: number[]
  onToggleSelect?: (noteId: number, selected: boolean) => void
  onSelect: (noteId: number) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(Boolean(typeof defaultExpanded === 'boolean' ? defaultExpanded : (group.expanded || depth < 2)))
  const hasSubGroups = Array.isArray(group.groups) && group.groups.length > 0
  const hasNotes = Array.isArray(group.notes) && group.notes.length > 0
  useEffect(() => {
    if (typeof defaultExpanded === 'boolean') setExpanded(defaultExpanded)
  }, [expandVersion, defaultExpanded])
  const totalCount = useMemo(() => {
    const own = Number.isFinite(Number(group.count)) ? Number(group.count) : (Array.isArray(group.notes) ? group.notes.length : 0)
    if (!hasSubGroups) return own
    const recur = (g: TagGroup): number => {
      const base = Number.isFinite(Number(g.count)) ? Number(g.count) : (Array.isArray(g.notes) ? g.notes.length : 0)
      if (!Array.isArray(g.groups) || g.groups.length === 0) return base
      return base + g.groups.reduce((s, sg) => s + recur(sg), 0)
    }
    return own + group.groups!.reduce((s, sg) => s + recur(sg), 0)
  }, [group, hasSubGroups])
  const indentStyle = { marginLeft: `${Math.max(0, depth) * 12}px` }
  const canExpand = hasSubGroups || hasNotes
  return (
    <div className="mb-1" style={indentStyle}>
      <div className="sticky top-0 z-10">
        <button
          className="w-full text-left"
          onClick={() => canExpand && setExpanded((v) => !v)}
          onKeyDown={(e) => { if (!canExpand) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
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
      <div className={`transition-all duration-200 ease-in-out overflow-hidden ${expanded ? 'max-h-[3000px] opacity-100' : 'max-h-0 opacity-0'}`}>
        <div className="mt-1 border bg-white/80 dark:bg-zinc-900/40 divide-y shadow-sm">
          {hasNotes && (
            <>
              {group.notes.map((n) => (
                <NoteCard
                  key={n.note_id}
                  n={n}
                  mode={mode}
                  selected={selectedId === n.note_id}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onSelect={onSelect}
                />
              ))}
            </>
          )}
          {hasSubGroups && depth < 3 && group.groups!.slice(0, 20).map((subGroup, index) => (
            <NoteGroup
              key={`${subGroup.keyword}-${index}`}
              group={subGroup}
              depth={depth + 1}
              expandVersion={expandVersion}
              defaultExpanded={defaultExpanded}
              mode={mode}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              onSelect={onSelect}
            />
          ))}
          {hasSubGroups && group.groups!.length > 20 && (
            <div className="px-3 py-2 text-xs text-muted-foreground bg-yellow-50 dark:bg-yellow-900/20 border-t">
              Showing first 20 of {group.groups!.length} sub-groups. Use search to narrow results.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


