import React from 'react'
import { HtmlWithMathLazy, cleanText } from './HtmlWithMath'

// User rule: include feedback as comments and update/replace when changed
// - FieldCard renders a single field with inline expand and copy

export function FieldCard({ name, html, noteId }: { name: string; html: string; noteId: number }): React.JSX.Element {
  const plain = React.useMemo(() => cleanText(html), [html])
  const isLong = plain.length > 600
  const [expanded, setExpanded] = React.useState(!isLong)
  return (
    <div className="group relative border rounded-md p-3 bg-white/60 dark:bg-zinc-900/20">
      <div className="text-[13px] font-semibold tracking-wide mb-1">{prettyName(name)}</div>
      <div className={`leading-relaxed text-[14px] ${expanded ? '' : 'max-h-40 overflow-hidden relative'}`}>
        {!expanded && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white/90 dark:from-zinc-900/90 to-transparent" />
        )}
        <HtmlWithMathLazy html={html} cacheKey={`${noteId}|${name}`} />
      </div>
      {isLong && (
        <button
          className="mt-2 text-[12px] px-2 py-0.5 rounded border bg-white hover:bg-zinc-50 dark:bg-zinc-900/30 dark:hover:bg-zinc-800/50"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
        <button
          className="text-[11px] px-1.5 py-0.5 rounded border bg-white hover:bg-zinc-50 dark:bg-zinc-900/30 dark:hover:bg-zinc-800/50"
          title="Copy field text"
          onClick={() => {
            try { navigator.clipboard.writeText(plain) } catch {}
          }}
        >Copy</button>
      </div>
    </div>
  )
}

export function prettyName(name: string): string {
  const s = String(name || '')
  return s
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/(^|\s)([a-z])/g, (_m, sp, ch) => sp + String(ch).toUpperCase())
}


