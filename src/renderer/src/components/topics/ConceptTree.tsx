import React from 'react'
import type { ConceptMapDetails, ConceptTopic } from '@/types/concept'
import { cn } from '@/lib/utils'

type TNode = {
  id: number
  label: string
  size: number
  children: TNode[]
}

function buildForest(details: ConceptMapDetails): TNode {
  const byId = new Map<number, ConceptTopic>()
  for (const t of details.topics) byId.set(t.topicId, t)
  const children = new Map<number, number[]>()
  const allIds = new Set<number>()
  for (const t of details.topics) {
    allIds.add(t.topicId)
    const pid = t.parentId != null ? Number(t.parentId) : null
    if (pid != null) {
      const arr = children.get(pid) || []
      arr.push(t.topicId)
      children.set(pid, arr)
    }
  }
  const roots: number[] = []
  for (const id of allIds) {
    const t = byId.get(id)!
    if (t.parentId == null || !byId.has(Number(t.parentId))) roots.push(id)
  }
  const build = (id: number): TNode => ({
    id,
    label: byId.get(id)?.label || String(id),
    size: byId.get(id)?.size || 1,
    children: (children.get(id) || []).map(build),
  })
  return {
    id: -1,
    label: 'All topics',
    size: details.run.noteCount,
    children: roots.map(build),
  }
}

type LNode = TNode & { x: number; y: number; depth: number }

type LayoutOptions = {
  minColumnWidth?: number
  rowGap?: number
  labelPadding?: number
}

function layoutTree(
  root: TNode,
  containerWidth: number,
  options: LayoutOptions = {}
): { nodes: LNode[]; links: Array<{ s: LNode; t: LNode }>; width: number } {
  const { minColumnWidth = 220, rowGap = 32, labelPadding = 260 } = options
  const nodes: LNode[] = []
  const links: Array<{ s: LNode; t: LNode }> = []
  const maxDepth = (function depth(n: TNode): number {
    if (!n.children || n.children.length === 0) return 0
    return 1 + Math.max(...n.children.map(depth))
  })(root)
  const columns = Math.max(1, maxDepth + 1)
  const columnWidth = Math.max(minColumnWidth, Math.floor(containerWidth / columns))
  const dx = columnWidth
  const width = Math.max(containerWidth, columnWidth * columns + labelPadding)
  let row = 0

  function assignLeaves(n: TNode, depth: number): LNode {
    const ln: LNode = { ...n, depth, x: depth * dx, y: 0 }
    if (!n.children || n.children.length === 0) {
      ln.y = row * rowGap
      row += 1
    } else {
      const childLayouts = n.children.map((c) => assignLeaves(c, depth + 1))
      const y = Math.floor(childLayouts.reduce((s, c) => s + c.y, 0) / childLayouts.length)
      ln.y = y
      for (const c of childLayouts) links.push({ s: ln, t: c })
    }
    nodes.push(ln)
    return ln
  }

  assignLeaves(root, 0)
  return { nodes, links, width }
}

export function ConceptTree({
  details,
  className,
  onOpenTopicNotes,
}: {
  details: ConceptMapDetails
  className?: string
  onOpenTopicNotes?: (topic: ConceptTopic) => void
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [w, setW] = React.useState<number>(900)
  React.useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const tree = React.useMemo(() => buildForest(details), [details])
  const { nodes, links, width: layoutWidth } = React.useMemo(
    () => layoutTree(tree, Math.max(900, w - 40), { minColumnWidth: 240, rowGap: 36, labelPadding: 320 }),
    [tree, w]
  )

  const height = Math.max(200, nodes.reduce((m, n) => Math.max(m, n.y), 0) + 80)
  const svgWidth = layoutWidth + 40
  const svgHeight = height + 40

  const byId = new Map(details.topics.map((t) => [t.topicId, t]))
  const onClickNode = (id: number) => {
    const t = byId.get(id)
    if (t && onOpenTopicNotes) onOpenTopicNotes(t)
  }

  return (
    <div ref={containerRef} className={cn('w-full rounded border bg-card', className)}>
      <div className="w-full overflow-x-auto">
        <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}>
          <g transform={`translate(20,20)`}>
            {links.map((l, i) => (
              <path
                key={`e-${i}`}
                d={`M ${l.s.x},${l.s.y} C ${(l.s.x + l.t.x) / 2},${l.s.y} ${(l.s.x + l.t.x) / 2},${l.t.y} ${l.t.x},${l.t.y}`}
                stroke="#c0c0c0"
                strokeWidth={1}
                fill="none"
              />
            ))}
            {nodes.map((n, i) => (
              <g key={`n-${i}`} transform={`translate(${n.x - 10},${n.y - 6})`} className="cursor-pointer" onClick={() => n.id >= 0 && onClickNode(n.id)}>
                <rect width={20} height={12} rx={3} ry={3} fill={n.id < 0 ? '#94a3b8' : '#3b82f6'} />
                {n.id >= 0 && (
                  <text x={28} y={10} fontSize={12} fill="#111827">
                    {n.label} <tspan fill="#6b7280">({n.size})</tspan>
                  </text>
                )}
                {n.id < 0 && (
                  <text x={28} y={10} fontSize={12} fill="#111827">All topics</text>
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
      <div className="px-3 py-2 text-[11px] text-muted-foreground">Click a node to preview its notes.</div>
    </div>
  )
}
