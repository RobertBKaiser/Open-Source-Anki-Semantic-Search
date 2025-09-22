import React from 'react'
import { ConceptMapDetails, ConceptScope, ConceptTopic, ConceptMapProgress } from '@/types/concept'
import { cn } from '@/lib/utils'
import { ConceptSankey } from './ConceptSankey'
import { ConceptTree } from './ConceptTree'
import { NoteCard, type NoteListItem } from '@/components/note/NoteCard'

function percent(value?: number | null): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return `${Math.round(value * 1000) / 10}%`
}

function plainText(html?: string | null): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[sound:[^\]]+\]/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveBackendModel(): { backend: 'deepinfra' | 'gemma' | 'google'; model: string } {
  const backend = (window.api.getSetting('embedding_backend') as ('deepinfra' | 'gemma' | 'google') | null) || 'deepinfra'
  if (backend === 'gemma') {
    const model = window.api.getSetting('gemma_model_id') || 'onnx-community/embeddinggemma-300m-ONNX'
    return { backend, model }
  }
  if (backend === 'google') {
    const model = window.api.getSetting('google_embed_model') || 'gemini-embedding-001'
    return { backend, model }
  }
  const model = window.api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
  return { backend, model }
}

type NoteList = Array<{ noteId: number; title: string; cos?: number | null; weight?: number | null }>

function assembleTopicNotes(topic: ConceptTopic, count: number): NoteList {
  const limit = Math.max(1, count)
  return topic.notes
    .map((n) => ({
      noteId: n.noteId,
      title: plainText(n.firstField),
      cos: n.cos,
      weight: n.weight,
    }))
    .filter((n) => n.title.length > 0)
    .slice(0, limit)
}

function TopicCard({
  topic,
  depth,
  expanded,
  onToggle,
}: {
  topic: ConceptTopic
  depth: number
  expanded: boolean
  onToggle: (topicId: number) => void
}): React.JSX.Element {
  const notes = React.useMemo(() => assembleTopicNotes(topic, 12), [topic])
  return (
    <div className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', depth > 0 && 'ml-4 mt-2')}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded-t-lg bg-primary/90 px-3 py-2 text-left text-sm font-semibold text-primary-foreground"
        onClick={() => onToggle(topic.topicId)}
        aria-expanded={expanded}
      >
        <div className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{topic.label || `Topic ${topic.topicId}`}</span>
          <div className="flex flex-wrap items-center gap-2 text-xs text-primary-foreground/80">
            <span>{topic.size} notes</span>
            {typeof topic.queryCos === 'number' && !Number.isNaN(topic.queryCos) && (
              <span className="rounded bg-primary-foreground/20 px-1.5 py-[1px]">Query {percent(topic.queryCos)}</span>
            )}
            {typeof topic.score === 'number' && (
              <span className="rounded bg-primary-foreground/20 px-1.5 py-[1px]">Score {(Math.round(topic.score * 100) / 100).toFixed(2)}</span>
            )}
          </div>
        </div>
        <span className="text-xs font-medium uppercase tracking-wide">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <div className="px-3 py-3">
          {Array.isArray(topic.terms) && topic.terms.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1 text-xs text-muted-foreground">
              {topic.terms.slice(0, 8).map((term) => (
                <span key={term.term} className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                  {term.term}
                </span>
              ))}
            </div>
          )}
          {notes.length > 0 ? (
            <div className="space-y-2">
              {notes.map((note) => {
                const item: NoteListItem = {
                  note_id: note.noteId,
                  first_field: note.title,
                  cos: typeof note.cos === 'number' ? note.cos : undefined,
                  rerank: typeof note.cos === 'number' ? note.cos : undefined,
                }
                return (
                  <NoteCard
                    key={note.noteId}
                    n={item}
                    mode={typeof note.cos === 'number' ? 'semantic' : 'default'}
                    selected={false}
                    selectedIds={[]}
                    onSelect={(nid) => { try { window.api.openInAnki?.(nid) } catch {} }}
                    ioRoot={null}
                    variant="full"
                  />
                )
              })}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No note previews available for this topic.</div>
          )}
        </div>
      )}
    </div>
  )
}

function renderTree(
  topicById: Map<number, ConceptTopic>,
  topicId: number,
  expanded: Set<number>,
  onToggle: (id: number) => void,
  depth = 0
): React.ReactNode {
  const topic = topicById.get(topicId)
  if (!topic) return null
  const isExpanded = expanded.has(topic.topicId)
  return (
    <div key={topic.topicId}>
      <TopicCard topic={topic} depth={depth} expanded={isExpanded} onToggle={onToggle} />
      {isExpanded &&
        topic.children.map((childId) => (
          <div key={childId} className="mt-2">
            {renderTree(topicById, childId, expanded, onToggle, depth + 1)}
          </div>
        ))}
    </div>
  )
}

type Status = 'idle' | 'loading' | 'building' | 'error'

export function ConceptMapPanel({
  scope,
  noteIds,
  query,
  className,
}: {
  scope: ConceptScope
  noteIds?: number[]
  query?: string
  className?: string
}): React.JSX.Element {
  const [view, setView] = React.useState<'list' | 'sankey' | 'tree'>('list')
  const [status, setStatus] = React.useState<Status>('idle')
  const [details, setDetails] = React.useState<ConceptMapDetails | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [runId, setRunId] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<ConceptMapProgress>(() => {
    try {
      return window.api.getConceptMapProgress?.() ?? { stage: 'idle', percent: 0 }
    } catch {
      return { stage: 'idle', percent: 0 }
    }
  })

  React.useEffect(() => {
    if (typeof window.api.subscribeConceptMapProgress !== 'function') return () => {}
    const unsubscribe = window.api.subscribeConceptMapProgress((p) => setProgress(p))
    return () => {
      try { unsubscribe?.() } catch {}
    }
  }, [])

  const topicById = React.useMemo(() => {
    const map = new Map<number, ConceptTopic>()
    if (details?.topics) {
      for (const topic of details.topics) {
        map.set(Number(topic.topicId), topic)
      }
    }
    return map
  }, [details?.topics])

  const rootTopicIds = React.useMemo(() => {
    if (!details) return []
    const unique = new Set<number>()
    for (const tid of details.roots) unique.add(Number(tid))
    return Array.from(unique.values()).sort((a, b) => a - b)
  }, [details?.roots])
  const [expandedTopics, setExpandedTopics] = React.useState<Set<number>>(new Set())

  React.useEffect(() => {
    if (details && Array.isArray(details.topics)) {
      setExpandedTopics(new Set(details.topics.map((t) => t.topicId)))
    }
  }, [details?.run.runId])

  const toggleTopic = React.useCallback((topicId: number) => {
    setExpandedTopics((prev) => {
      const next = new Set(prev)
      if (next.has(topicId)) next.delete(topicId)
      else next.add(topicId)
      return next
    })
  }, [])

  const expandAll = React.useCallback(() => {
    if (!topicById.size) return
    const all = new Set<number>()
    const stack = [...topicById.keys()]
    for (const tid of stack) all.add(tid)
    setExpandedTopics(all)
  }, [topicById])

  const collapseAll = React.useCallback(() => {
    setExpandedTopics(new Set())
  }, [])

  const handleBuild = React.useCallback(async () => {
    const hasExplicitNotes = Array.isArray(noteIds) && noteIds.length > 0
    const useAllNotes = (!hasExplicitNotes) && scope.type === 'global'
    if (!hasExplicitNotes && !useAllNotes) {
      setError('No notes available for concept mapping for this scope.')
      setStatus('error')
      return
    }
    setStatus('building')
    setError(null)
    try {
      const { backend, model } = resolveBackendModel()
      const { runId: newRunId } = await window.api.buildConceptMapForNotes({
        scope,
        noteIds: useAllNotes ? undefined : noteIds,
        query: query ?? undefined,
        backend,
        model,
        maxNotes: useAllNotes ? 0 : undefined,
      })
      setRunId(newRunId)
      const map = await window.api.getConceptMapDetails(newRunId)
      setDetails(map)
      setStatus('idle')
    } catch (err) {
      console.error('Concept map build failed', err)
      setDetails(null)
      setRunId(null)
      const message = err instanceof Error ? err.message : 'Failed to build concept map.'
      setError(message)
      setStatus('error')
    }
  }, [noteIds, query, scope])

  const handleRefresh = React.useCallback(async () => {
    if (!runId) return
    setStatus('loading')
    setError(null)
    try {
      const map = await window.api.getConceptMapDetails(runId)
      setDetails(map)
      setStatus('idle')
    } catch (err) {
      console.error('Concept map fetch failed', err)
      setError('Unable to load concept map.')
      setStatus('error')
    }
  }, [runId])

  return (
    <div className={cn('flex h-full flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">Concept Map</h2>
          <p className="text-xs text-muted-foreground">
            Build a hierarchical topic view over the current note scope using TopicBERT clustering.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {details && details.topics.length > 0 && (
            <>
              <button
                type="button"
                className="rounded border px-2.5 py-1 text-xs font-medium hover:bg-muted"
                onClick={expandAll}
                disabled={status === 'building' || status === 'loading'}
              >
                Expand All
              </button>
              <button
                type="button"
                className="rounded border px-2.5 py-1 text-xs font-medium hover:bg-muted"
                onClick={collapseAll}
                disabled={status === 'building' || status === 'loading'}
              >
                Collapse All
              </button>
              <div className="ml-2" />
              <button
                type="button"
                className={cn(
                  'rounded border px-2.5 py-1 text-xs font-medium',
                  view === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                )}
                onClick={() => setView('list')}
              >
                List
              </button>
              <button
                type="button"
                className={cn(
                  'rounded border px-2.5 py-1 text-xs font-medium',
                  view === 'sankey' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                )}
                onClick={() => setView('sankey')}
              >
                Sankey
              </button>
              <button
                type="button"
                className={cn(
                  'rounded border px-2.5 py-1 text-xs font-medium',
                  view === 'tree' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                )}
                onClick={() => setView('tree')}
              >
                Tree
              </button>
            </>
          )}
          {runId && (
            <button
              type="button"
              className="rounded border px-3 py-1 text-xs font-medium hover:bg-muted"
              onClick={handleRefresh}
              disabled={status === 'loading' || status === 'building'}
            >
              Refresh
            </button>
          )}
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50"
            onClick={handleBuild}
            disabled={status === 'building'}
          >
            {status === 'building' ? 'Building…' : 'Build Map'}
          </button>
        </div>
      </div>
      {progress.stage !== 'idle' && (
        <div className="rounded border px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-foreground">
            <span className="capitalize">{progress.stage.replace(/_/g, ' ')}</span>
            <span>{typeof progress.percent === 'number' ? `${Math.round(progress.percent)}%` : ''}</span>
          </div>
          <div className="mt-1 h-2 rounded bg-muted">
            <div
              className="h-full rounded bg-primary transition-all"
              style={{ width: `${Math.max(0, Math.min(100, progress.percent ?? 0))}%` }}
            />
          </div>
          {progress.message && <div className="mt-1 text-[11px] text-muted-foreground">{progress.message}</div>}
        </div>
      )}
      {error && <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
      {details ? (
        <div className="flex-1 overflow-auto pr-2">
          <div className="space-y-3">
            <div className="rounded border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <div>
                Notes: <span className="font-semibold text-foreground">{details.run.noteCount}</span>
              </div>
              <div>
                Model: <span className="font-semibold text-foreground">{details.run.backend}/{details.run.model}</span>
              </div>
              <div>
                Built: <span className="font-semibold text-foreground">{new Date(details.run.createdAt * 1000).toLocaleString()}</span>
              </div>
            </div>
            {view === 'sankey' ? (
              <SankeyView details={details} />
            ) : view === 'tree' ? (
              <TreeView details={details} />
            ) : (
              <>
                {rootTopicIds.length === 0 && <div className="text-xs text-muted-foreground">No topics were generated.</div>}
                {rootTopicIds.map((rootId) => (
                  <div key={rootId}>{renderTree(topicById, rootId, expandedTopics, toggleTopic)}</div>
                ))}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 rounded border border-dashed p-4 text-xs text-muted-foreground">
          Click “Build Map” to generate a concept hierarchy. When no filters are active the full note database will be used.
        </div>
      )}
    </div>
  )
}

function SankeyView({ details }: { details: import('@/types/concept').ConceptMapDetails }): React.JSX.Element {
  const [openTopic, setOpenTopic] = React.useState<import('@/types/concept').ConceptTopic | null>(null)
  const onOpenTopicNotes = (t: import('@/types/concept').ConceptTopic) => setOpenTopic(t)
  return (
    <>
      <div className="rounded border">
        <ConceptSankey details={details} onOpenTopicNotes={onOpenTopicNotes} />
      </div>
      {openTopic && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={() => setOpenTopic(null)}>
          <div className="max-h-[80vh] w-[720px] overflow-auto rounded bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="font-semibold text-lg">{openTopic.label}</div>
              <button className="rounded border px-2 py-1 text-xs" onClick={() => setOpenTopic(null)}>Close</button>
            </div>
            <div className="text-xs text-muted-foreground mb-2">{openTopic.size} notes</div>
            {openTopic.notes && openTopic.notes.length > 0 ? (
              <div className="space-y-2">
                {openTopic.notes.slice(0, 100).map((n) => {
                  const item: NoteListItem = {
                    note_id: n.noteId,
                    first_field: n.firstField ?? '',
                    cos: typeof n.cos === 'number' ? n.cos : undefined,
                    rerank: typeof n.cos === 'number' ? n.cos : undefined,
                  }
                  return (
                    <NoteCard
                      key={n.noteId}
                      n={item}
                      mode={typeof n.cos === 'number' ? 'semantic' : 'default'}
                      selected={false}
                      selectedIds={[]}
                      onSelect={(nid) => { try { window.api.openInAnki?.(nid) } catch {} }}
                      ioRoot={null}
                      variant="full"
                    />
                  )
                })}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No note previews on this topic (grouping node).</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function TreeView({ details }: { details: import('@/types/concept').ConceptMapDetails }): React.JSX.Element {
  const [openTopic, setOpenTopic] = React.useState<import('@/types/concept').ConceptTopic | null>(null)
  const onOpenTopicNotes = (t: import('@/types/concept').ConceptTopic) => setOpenTopic(t)
  return (
    <>
      <ConceptTree details={details} onOpenTopicNotes={onOpenTopicNotes} />
      {openTopic && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={() => setOpenTopic(null)}>
          <div className="max-h-[80vh] w-[720px] overflow-auto rounded bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="font-semibold text-lg">{openTopic.label}</div>
              <button className="rounded border px-2 py-1 text-xs" onClick={() => setOpenTopic(null)}>Close</button>
            </div>
            <div className="text-xs text-muted-foreground mb-2">{openTopic.size} notes</div>
            {openTopic.notes && openTopic.notes.length > 0 ? (
              <div className="space-y-2">
                {openTopic.notes.slice(0, 100).map((n) => {
                  const item: NoteListItem = {
                    note_id: n.noteId,
                    first_field: n.firstField ?? '',
                    cos: typeof n.cos === 'number' ? n.cos : undefined,
                    rerank: typeof n.cos === 'number' ? n.cos : undefined,
                  }
                  return (
                    <NoteCard
                      key={n.noteId}
                      n={item}
                      mode={typeof n.cos === 'number' ? 'semantic' : 'default'}
                      selected={false}
                      selectedIds={[]}
                      onSelect={(nid) => { try { window.api.openInAnki?.(nid) } catch {} }}
                      ioRoot={null}
                      variant="full"
                    />
                  )
                })}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No note previews on this topic (grouping node).</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
