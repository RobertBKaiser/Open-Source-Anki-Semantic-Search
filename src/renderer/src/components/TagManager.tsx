import React from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'

type TagRow = { tag: string; notes: number }

type Node = {
  name: string
  full: string
  count: number
  children: Node[]
  expanded?: boolean
}

function buildTree(rows: TagRow[]): Node[] {
  // Collect exact counts per tag
  const exact = new Map<string, number>()
  for (const r of rows) exact.set(r.tag, Number(r.notes) || 0)
  // Create nodes on demand
  const getNode = (full: string): Node => {
    const parts = full.split('::')
    const name = parts[parts.length - 1]
    const parent = parts.length > 1 ? parts.slice(0, -1).join('::') : ''
    let container: Node[]
    if (parent === '') container = roots
    else {
      const p = byFull.get(parent) || getNode(parent)
      container = p.children
    }
    let n = byFull.get(full)
    if (!n) {
      n = { name, full, count: exact.get(full) || 0, children: [] }
      byFull.set(full, n)
      container.push(n)
    }
    return n
  }
  const roots: Node[] = []
  const byFull: Map<string, Node> = new Map()
  // Build structure
  for (const r of rows) {
    const parts = r.tag.split('::')
    let path = ''
    for (let i = 0; i < parts.length; i++) {
      path = i === 0 ? parts[0] : path + '::' + parts[i]
      getNode(path)
    }
  }
  // Inclusive counts: sum children into parents
  const dfs = (n: Node): number => {
    let total = n.count
    for (const c of n.children) total += dfs(c)
    n.count = total
    // sort children
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    return total
  }
  for (const r of roots) dfs(r)
  // sort roots
  roots.sort((a, b) => a.name.localeCompare(b.name))
  return roots
}

type TagManagerProps = {
  open: boolean
  onClose: () => void
  onSelectPrefix: (prefix: string) => void
}

export function TagManager({ open, onClose, onSelectPrefix }: TagManagerProps): React.JSX.Element | null {
  const [tree, setTree] = React.useState<Node[]>([])
  React.useEffect(() => {
    if (!open) return
    try {
      const rows: TagRow[] = ((window as any).api?.listAllTags?.()) || []
      setTree(buildTree(rows))
    } catch { setTree([]) }
  }, [open])

  if (!open) return null

  const Row = ({ node, depth }: { node: Node; depth: number }) => {
    const [exp, setExp] = React.useState<boolean>(Boolean(node.expanded || depth < 2))
    return (
      <div>
        <div className="flex items-center gap-1 px-2 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded" style={{ paddingLeft: depth * 12 }}>
          {node.children.length > 0 ? (
            <button className="w-4 h-4 inline-flex items-center justify-center" onClick={() => setExp((v) => !v)}>
              {exp ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <button className="flex-1 text-left truncate" title={node.full} onClick={() => onSelectPrefix(node.full)}>
            {node.name}
          </button>
          <span className="text-[11px] text-muted-foreground ml-2">{node.count}</span>
        </div>
        {exp && node.children.map((c) => <Row key={c.full} node={c} depth={depth + 1} />)}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 grid grid-cols-[320px_1fr]" onClick={onClose}>
      <div className="bg-background border-r overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-2 border-b flex items-center justify-between">
          <div className="text-sm font-semibold">Tags</div>
          <button className="text-[12px] px-2 py-0.5 rounded border" onClick={onClose}>Close</button>
        </div>
        <div className="p-2">
          <button className="w-full text-left px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 mb-1" onClick={() => onSelectPrefix('')}>All notes</button>
          <div className="text-xs text-muted-foreground px-2 mb-1">Click a tag to filter</div>
          <div>
            {tree.map((n) => <Row key={n.full} node={n} depth={0} />)}
          </div>
        </div>
      </div>
      <div className="bg-black/40" />
    </div>
  )
}
