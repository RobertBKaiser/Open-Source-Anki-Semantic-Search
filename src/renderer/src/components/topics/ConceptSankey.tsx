import React from 'react'
import { Sankey, Tooltip, ResponsiveContainer } from 'recharts'
import type { ConceptMapDetails, ConceptTopic } from '@/types/concept'
import { cn } from '@/lib/utils'

type SankeyNode = { name: string; topicId?: number; label?: string; size?: number }
type SankeyLink = { source: number; target: number; value: number }

function buildSankey(details: ConceptMapDetails, includeVirtualRoot: boolean = true): {
  nodes: SankeyNode[]
  links: SankeyLink[]
  rootIndex?: number
} {
  const nodes: SankeyNode[] = []
  const links: SankeyLink[] = []
  const idToIndex = new Map<number, number>()
  const roots: number[] = []
  for (const t of details.topics) {
    const idx = nodes.length
    idToIndex.set(t.topicId, idx)
    nodes.push({
      name: `${t.topicId}: ${t.label}`,
      topicId: t.topicId,
      label: t.label,
      size: t.size,
    })
  }
  const topicIds = new Set(details.topics.map((t) => t.topicId))
  for (const t of details.topics) {
    if (t.parentId != null && topicIds.has(Number(t.parentId))) {
      const s = idToIndex.get(Number(t.parentId))
      const tgt = idToIndex.get(t.topicId)
      if (s != null && tgt != null) links.push({ source: s, target: tgt, value: Math.max(1, t.size || 1) })
    } else {
      roots.push(t.topicId)
    }
  }
  let rootIndex: number | undefined
  if (includeVirtualRoot && roots.length > 0) {
    rootIndex = nodes.length
    nodes.push({ name: 'ROOT' })
    for (const tid of roots) {
      const idx = idToIndex.get(tid)
      if (idx != null) links.push({ source: rootIndex, target: idx, value: Math.max(1, details.topics.find((x) => x.topicId === tid)?.size || 1) })
    }
  }
  return { nodes, links, rootIndex }
}

export function ConceptSankey({
  details,
  className,
  onOpenTopicNotes,
}: {
  details: ConceptMapDetails
  className?: string
  onOpenTopicNotes?: (topic: ConceptTopic) => void
}): React.JSX.Element {
  const { nodes, links } = React.useMemo(() => buildSankey(details, true), [details])

  const handleClick = React.useCallback(
    // Recharts will pass either a node or a link payload.
    (payload: any) => {
      const tid: number | undefined = payload?.payload?.topicId
      if (!tid) return
      const topic = details.topics.find((t) => t.topicId === tid)
      if (topic && onOpenTopicNotes) onOpenTopicNotes(topic)
    },
    [details, onOpenTopicNotes]
  )

  return (
    <div className={cn('w-full h-[520px] rounded border bg-card', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <Sankey
          data={{ nodes, links }}
          nodePadding={24}
          nodeWidth={16}
          margin={{ left: 16, right: 16, top: 16, bottom: 16 }}
          linkCurvature={0.5}
          // @ts-ignore - generic Recharts event type
          onClick={handleClick}
        >
          <Tooltip />
        </Sankey>
      </ResponsiveContainer>
      <div className="px-3 py-2 text-[11px] text-muted-foreground">Click a node to preview its notes.</div>
    </div>
  )
}
