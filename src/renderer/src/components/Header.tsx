import React, { useEffect, useState } from 'react'
import { Settings, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'

type HeaderProps = {
  onSearch: (query: string) => void
  onFuzzy: (query: string, exclude?: string[]) => void
  onSemantic: (query: string) => void
  onEmbedSearch?: (query: string) => void
  onHybrid?: (query: string) => void
  onUnsuspend?: (noteIds: number[]) => void
  onOpenSettings: () => void
  onOpenTags?: () => void
  searching?: boolean
  semanticRunning?: boolean
  selectedIds?: number[]
  mode?: 'default' | 'exact' | 'fuzzy' | 'rerank' | 'semantic' | 'hybrid'
  cosThreshold?: number
  onChangeCosThreshold?: (v: number) => void
  // Badge tools
  badgeCounts?: number[]
  grouped?: boolean
  onToggleGroupByBadge?: () => void
  onGroupSelectBadge?: (badge: 0 | 1 | 2 | 3) => void
  onGroupUnselectBadge?: (badge: 0 | 1 | 2 | 3) => void
  groupMode?: 'none' | 'ai' | 'concept'
  onChangeGroupMode?: (mode: 'none' | 'ai' | 'concept') => void
  onToggleConceptMap?: () => void
  conceptMapActive?: boolean
}

export function Header({
  onSearch,
  onFuzzy,
  onSemantic,
  onEmbedSearch,
  onHybrid,
  onUnsuspend,
  onOpenSettings,
  onOpenTags,
  searching = false,
  semanticRunning = false,
  selectedIds = [],
  mode = 'default',
  cosThreshold = 0,
  onChangeCosThreshold,
  badgeCounts = [],
  grouped = false,
  onToggleGroupByBadge,
  onGroupSelectBadge,
  onGroupUnselectBadge,
  groupMode = 'none',
  onChangeGroupMode,
  onToggleConceptMap,
  conceptMapActive = false,
  onOpenPdf,
}: HeaderProps & { onOpenPdf?: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  // No route menu
  const [activeBadges, setActiveBadges] = useState<number[]>([])
  // Debounced real-time search
  useEffect(() => {
    const id = setTimeout(() => { onSearch(q); (window as any).__current_query = q }, 200)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  return (
    <div className="p-2 border-b sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex items-center gap-2 relative">
        {/* Hamburger for Tag Manager */}
        <button
          className="inline-flex items-center justify-center w-8 h-8 rounded border bg-white hover:bg-zinc-50 dark:bg-zinc-900/30 dark:hover:bg-zinc-800/50"
          title="Open Tag Manager"
          onClick={() => onOpenTags && onOpenTags()}
        >
          <Menu className="w-4 h-4" />
        </button>
        {onOpenPdf && (
          <button
            className="inline-flex items-center justify-center w-8 h-8 rounded border bg-amber-400/90 text-black hover:bg-amber-400"
            title="Open PDF page"
            onClick={() => onOpenPdf?.()}
          >
            <span className="text-[10px] font-bold">PDF</span>
          </button>
        )}
        {(() => {
          const isMultiline = q.includes('\n')
          if (!isMultiline) {
            return (
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearch(q)}
                placeholder={'Search notes...'}
                className="flex-1 px-3 py-2 rounded-md bg-background border"
              />
            )
          }
          const rows = Math.min(8, Math.max(1, q.split(/\n/).length))
          return (
            <textarea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSearch(q)
              }}
              placeholder={'Search notes...'}
              rows={rows}
              className="flex-1 px-3 py-2 rounded-md bg-background border resize-y"
            />
          )
        })()}
        <Button
          className="bg-blue-600 text-white hover:bg-blue-700 active:translate-y-[1px] active:shadow-inner"
          onClick={() => onFuzzy(q)}
          disabled={semanticRunning}
        >
          Fuzzy Search
        </Button>
        {onEmbedSearch && (
          <Button
            className="bg-orange-600 text-white hover:bg-orange-700 active:translate-y-[1px] active:shadow-inner"
            onClick={() => onEmbedSearch(q)}
          >
            Semantic Search
          </Button>
        )}
        {onHybrid && (
          <Button
            className="bg-purple-600 text-white hover:bg-purple-700 active:translate-y-[1px] active:shadow-inner"
            onClick={() => onHybrid(q)}
          >
            Hybrid
          </Button>
        )}
        {onToggleConceptMap && (
          <Button
            className={`text-white active:translate-y-[1px] active:shadow-inner ${conceptMapActive ? 'bg-emerald-600 hover:bg-emerald-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
            onClick={() => onToggleConceptMap?.()}
          >
            Concept Map
          </Button>
        )}
      {searching && (
        <span className="flex items-center gap-2 text-xs text-muted-foreground select-none">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          Searching…
        </span>
      )}
      <Button variant="ghost" size="icon" onClick={onOpenSettings}>
        <Settings className="h-5 w-5" />
      </Button>
      </div>
      {(mode === 'semantic' || mode === 'rerank' || mode === 'hybrid') && (() => {
        const pctFloat = Math.max(0, Math.min(100, (cosThreshold || 0) * 100))
        const pctLabel = pctFloat.toFixed(1)
        const colorCls = mode === 'rerank'
          ? '[&_[data-slot=\\"slider-range\\"]]:bg-orange-500 [&_[data-slot=\\"slider-thumb\\"]]:border-orange-500'
          : mode === 'semantic'
            ? '[&_[data-slot=\\"slider-range\\"]]:bg-purple-600 [&_[data-slot=\\"slider-thumb\\"]]:border-purple-600'
            : '[&_[data-slot=\\"slider-range\\"]]:bg-teal-600 [&_[data-slot=\\"slider-thumb\\"]]:border-teal-600'
        return (
          <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground flex-nowrap">
            <div className={`relative shrink-0 ${colorCls}`} style={{ width: '13rem' }}>
              <Slider
                min={0}
                max={100}
                step={0.1 as any}
                value={[pctFloat] as any}
                onValueChange={(vals: number[] | any) => {
                  const v = Array.isArray(vals) ? vals[0] : Number(vals)
                  onChangeCosThreshold && onChangeCosThreshold(Math.max(0, Math.min(1, Number(v) / 100)))
                }}
                className="w-56"
              />
              <div
                className="absolute -top-5 translate-x-[-50%] rounded px-1 py-[1px] bg-zinc-800 text-white"
                style={{ left: `${pctFloat}%` }}
              >
                ≥ {pctLabel}%
              </div>
              <div className="relative mt-1 h-3 text-[10px] text-muted-foreground/70 select-none">
                {[0,25,50,75,100].map((p) => (
                  <span key={p} className="absolute -translate-x-1/2" style={{ left: `${p}%` }}>{p}</span>
                ))}
              </div>
            </div>
            {/* Post-search filtering buttons */}
            <div className="flex items-center gap-2 ml-4">
              <Button
                className={`text-white active:translate-y-[1px] active:shadow-inner ${semanticRunning ? 'bg-orange-400' : 'bg-orange-500 hover:bg-orange-600'}`}
                onClick={() => onSemantic(q)}
                disabled={semanticRunning}
                size="sm"
              >
                {semanticRunning ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    Reranking…
                  </span>
                ) : (
                  'Reranking'
                )}
              </Button>
              <Button
                className="bg-black text-white hover:bg-black/90 active:translate-y-[1px] active:shadow-inner"
                onClick={() => {
                  const event = new CustomEvent('classify-badges', { detail: { query: q } })
                  window.dispatchEvent(event)
                }}
                size="sm"
              >
                Classify Badges
              </Button>
            </div>
            {/* Inline badge toggles */}
            {Array.isArray(badgeCounts) && badgeCounts.some((c) => c > 0) && (
              <div className="flex items-center gap-2 whitespace-nowrap overflow-x-auto no-scrollbar ml-4">
                <button
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 border shadow-sm bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900/40 dark:hover:bg-zinc-800/60 transition-colors"
                  onClick={() => onToggleGroupByBadge && onToggleGroupByBadge()}
                  title={grouped ? 'Ungroup notes' : 'Group notes by badge'}
                >
                  {grouped ? 'Ungroup' : 'Group'}
                </button>
                {[0,1,2,3].map((b) => {
                  const active = activeBadges.includes(b)
                  const colorOn = b===0? 'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800' : b===1? 'bg-blue-100 text-blue-700 ring-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-800' : b===2? 'bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800' : 'bg-zinc-200 text-zinc-700 ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700'
                  const colorOff = 'bg-transparent text-foreground'
                  const ringCls = active ? 'ring-1' : 'border'
                  const label = b===0? 'Hit' : b===1? 'Very' : b===2? 'Some' : 'Not'
                  return (
                    <button
                      key={b}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] shadow-sm transition-colors ${ringCls} ${active ? colorOn : colorOff}`}
                      title={`Toggle select badge ${b}`}
                      onClick={() => {
                        setActiveBadges((prev) => {
                          const has = prev.includes(b)
                          if (has) { onGroupUnselectBadge && onGroupUnselectBadge(b as 0|1|2|3); return prev.filter((x) => x !== b) }
                          onGroupSelectBadge && onGroupSelectBadge(b as 0|1|2|3); return [...prev, b]
                        })
                      }}
                    >
                      <span className="font-medium">{label}</span>
                      <span className="opacity-70">{badgeCounts[b]||0}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {/* Grouping mode toggle */}
            <button
              className="ml-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 border shadow-sm bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900/40 dark:hover:bg-zinc-800/60 transition-colors"
              onClick={() => {
                const next = groupMode === 'none' ? 'ai' : groupMode === 'ai' ? 'concept' : 'none'
                onChangeGroupMode && onChangeGroupMode(next)
              }}
              title={groupMode === 'none' ? 'Show AI groups' : groupMode === 'ai' ? 'Show concept map' : 'Show note list'}
            >
              {groupMode === 'none' && 'Group: Off'}
              {groupMode === 'ai' && 'Group: AI'}
              {groupMode === 'concept' && 'Group: Concept Map'}
            </button>
          </div>
        )
      })()}
      {(onUnsuspend && selectedIds.length > 0) ? (
        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2"></div>
          {onUnsuspend && selectedIds.length > 0 ? (
            <button
              className="text-[11px] rounded-md px-2 py-0.5 bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => onUnsuspend(selectedIds)}
              title="Unsuspend selected notes"
            >
              Unsuspend ({selectedIds.length})
            </button>
          ) : null}
        </div>
      ) : null}
      {/* No separate Unsuspend button below; rendered inline to the right only when there is a selection */}
    </div>
  )
}
