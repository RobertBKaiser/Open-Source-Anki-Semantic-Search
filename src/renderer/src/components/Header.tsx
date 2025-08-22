import React, { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'

type HeaderProps = {
  onSearch: (query: string) => void
  onFuzzy: (query: string, exclude?: string[]) => void
  onSemantic: (query: string) => void
  onEmbedSearch?: (query: string) => void
  onUnsuspend?: (noteIds: number[]) => void
  onOpenSettings: () => void
  searching?: boolean
  semanticRunning?: boolean
  selectedIds?: number[]
  mode?: 'default' | 'exact' | 'fuzzy' | 'rerank' | 'semantic'
  cosThreshold?: number
  onChangeCosThreshold?: (v: number) => void
}

export function Header({ onSearch, onFuzzy, onSemantic, onEmbedSearch, onUnsuspend, onOpenSettings, searching = false, semanticRunning = false, selectedIds = [], mode = 'default', cosThreshold = 0, onChangeCosThreshold }: HeaderProps): React.JSX.Element {
  const [q, setQ] = useState('')
  const [keywords, setKeywords] = useState<string[]>([])
  const [showAllKeywords, setShowAllKeywords] = useState(false)
  const [pendingExcludes, setPendingExcludes] = useState<string[]>([])
  const excludeRef = useRef<string[]>([])
  const debounceRef = useRef<number | null>(null)
  // Debounced real-time search
  useEffect(() => {
    const id = setTimeout(() => onSearch(q), 200)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  // Debounced keyword extraction for UI chips (only when in fuzzy mode)
  useEffect(() => {
    if (mode !== 'fuzzy') {
      setKeywords([])
      return
    }
    const id = setTimeout(() => {
      try {
        const kws = window.api?.extractQueryKeywords?.(q) ?? []
        setKeywords(kws)
      } catch {
        setKeywords([])
      }
    }, 250)
    return () => clearTimeout(id)
  }, [q, mode])
  return (
    <div className="p-2 border-b">
      <div className="flex items-center gap-2">
        {(() => {
          const isMultiline = q.includes('\n')
          if (!isMultiline) {
            return (
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearch(q)}
                placeholder="Search notes..."
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
              placeholder="Search notes..."
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
        <Button
          className={`text-white active:translate-y-[1px] active:shadow-inner ${semanticRunning ? 'bg-orange-400' : 'bg-orange-500 hover:bg-orange-600'}`}
          onClick={() => onSemantic(q)}
          disabled={semanticRunning}
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
        {onEmbedSearch && (
          <Button
            className="bg-purple-600 text-white hover:bg-purple-700 active:translate-y-[1px] active:shadow-inner"
            onClick={() => onEmbedSearch(q)}
          >
            Semantic Search
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
      {(mode === 'semantic' || mode === 'rerank') && (
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="whitespace-nowrap">Cos similarity ≥ {(cosThreshold * 100).toFixed(0)}%</span>
          <Slider
            min={0}
            max={100}
            step={1 as any}
            value={[Math.round(cosThreshold * 100)] as any}
            onValueChange={(vals: number[] | any) => {
              const v = Array.isArray(vals) ? vals[0] : Number(vals)
              onChangeCosThreshold && onChangeCosThreshold(Math.max(0, Math.min(1, Number(v) / 100)))
            }}
            className="w-56"
          />
        </div>
      )}
      {(mode === 'fuzzy' && keywords.length > 0) || (onUnsuspend && selectedIds.length > 0) ? (
        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
          {mode === 'fuzzy' && (() => {
            const VISIBLE = 13
            const display = showAllKeywords ? keywords : keywords.slice(0, VISIBLE)
            const moreCount = Math.max(0, keywords.length - display.length)
            const palette = [
              'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
              'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
              'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
              'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
              'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
              'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
              'bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300',
              'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
            ]
            return (
              <>
                {display.map((k, idx) => {
                  const cls = palette[idx % palette.length]
                  return (
                    <span key={k} className={`text-[11px] rounded-md pl-1.5 pr-0.5 py-0.5 ${cls} flex items-center gap-1`}>
                      <span>{k}</span>
                      <button
                        aria-label={`Remove ${k}`}
                        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-black/10"
                        onClick={() => {
                          // Update local chips immediately
                          const next = keywords.filter((w) => w !== k)
                          setKeywords(next)
                          // Accumulate excludes and debounce the search by 2s
                          excludeRef.current = Array.from(new Set([...(excludeRef.current || []), k]))
                          setPendingExcludes(excludeRef.current)
                          if (debounceRef.current) window.clearTimeout(debounceRef.current)
                          debounceRef.current = window.setTimeout(() => {
                            const excludes = Array.from(new Set(excludeRef.current))
                            onFuzzy(q, excludes)
                            excludeRef.current = []
                            setPendingExcludes([])
                            debounceRef.current = null
                          }, 2000)
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
                {moreCount > 0 && (
                  <button
                    className="text-[11px] rounded-md px-1.5 py-0.5 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                    onClick={() => setShowAllKeywords((v) => !v)}
                    title={showAllKeywords ? 'Collapse keywords' : 'Show all keywords'}
                  >
                    {showAllKeywords ? 'Show less' : `… +${moreCount}`}
                  </button>
                )}
              </>
            )
          })()}
          </div>
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


