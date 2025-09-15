import React from 'react'
import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import { FieldCard, prettyName } from '@/components/details/FieldCard'
import { HtmlWithMathLazy, cleanText } from '@/components/details/HtmlWithMath'
import { RelatedNotes } from '@/components/details/RelatedNotes'
import MetaPill from '@/components/details/MetaPill'

type Field = { field_name: string; value_html: string; ord: number | null }
type NoteDetailsData = {
  note: { note_id: number; model_name: string; mod: number | null }
  fields: Field[]
  tags: string[]
}

type NoteDetailsProps = {
  data: NoteDetailsData | null
}

function hasVisibleContent(html: string): boolean {
  if (!html) return false
  const hasMedia = /<img\b|<video\b|<audio\b|\[sound:[^\]]+\]/i.test(html)
  if (hasMedia) return true
  const text = cleanText(html)
  return text.length > 0
}

const HIDE_FIELDS = ['ankihub_id', 'ankihub id', 'ankihub-note-id', 'ankihub note id']
const hideField = (n: string) => HIDE_FIELDS.includes(String(n || '').toLowerCase())

export function NoteDetailsView({ data }: NoteDetailsProps): React.JSX.Element {
  if (!data) return <div className="p-4 text-sm text-muted-foreground">Select a note to view details.</div>
  const { note, fields, tags } = data
  // Phase rendering to reduce INP: render first field immediately, defer rest and meta
  const firstVisibleIdx = React.useMemo(() => fields.findIndex((f) => !hideField(f.field_name) && hasVisibleContent(f.value_html)), [fields])
  const firstField = firstVisibleIdx >= 0 ? fields[firstVisibleIdx] : null
  const restFields = React.useMemo(() => {
    if (firstVisibleIdx < 0) return [] as Field[]
    const arr = fields.filter((_, idx) => idx !== firstVisibleIdx).filter((f) => !hideField(f.field_name) && hasVisibleContent(f.value_html))
    return arr
  }, [fields, firstVisibleIdx])
  const [showRest, setShowRest] = React.useState(false)
  const [showMeta, setShowMeta] = React.useState(false)
  React.useEffect(() => {
    setShowRest(false)
    setShowMeta(false)
    const id1 = window.requestAnimationFrame(() => setShowMeta(true))
    const id2 = window.requestAnimationFrame(() => setShowRest(true))
    return () => { try { window.cancelAnimationFrame(id1) } catch {} try { window.cancelAnimationFrame(id2) } catch {} }
  }, [note.note_id])
  const [showAllTags, setShowAllTags] = React.useState(false)
  const [showFullPaths, setShowFullPaths] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [openTag, setOpenTag] = React.useState<string | null>(null)
  const TAG_MAX = 14

  const timeAgo = React.useMemo(() => {
    if (!note.mod) return '—'
    const now = Date.now()
    const dt = now - note.mod * 1000
    const s = Math.floor(dt / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    const d = Math.floor(h / 24)
    if (d > 0) return `${d} day${d === 1 ? '' : 's'} ago`
    if (h > 0) return `${h} hour${h === 1 ? '' : 's'} ago`
    if (m > 0) return `${m} min ago`
    return `${s} sec ago`
  }, [note.mod])

  const tagStyle = React.useCallback((t: string) => {
    let h = 0
    for (let i = 0; i < t.length; i++) h = (h * 33 + t.charCodeAt(i)) % 360
    const bg = `hsl(${h}, 90%, 92%)`
    const fg = `hsl(${h}, 45%, 26%)`
    const br = `hsl(${h}, 80%, 85%)`
    return { backgroundColor: bg, color: fg, borderColor: br } as React.CSSProperties
  }, [])

  return (
    <div className="min-h-0 h-full overflow-y-auto p-4 space-y-4">
      <div className="flex flex-col gap-2">
        {firstField && (
          <FieldCard key={firstField.field_name} name={firstField.field_name} html={firstField.value_html} noteId={note.note_id} />
        )}
        {!firstField && (
          <div className="rounded-md border p-3 bg-white/60 dark:bg-zinc-900/20 h-16 animate-pulse" />
        )}
        {showRest ? (
          restFields.map((f) => (
            <FieldCard key={f.field_name} name={f.field_name} html={f.value_html} noteId={note.note_id} />
          ))
        ) : (
          restFields.length > 0 ? <div className="rounded-md border p-3 bg-white/60 dark:bg-zinc-900/20 h-16 animate-pulse" /> : null
        )}
      </div>

      {showMeta ? (
      <div className="rounded-md border bg-white/60 dark:bg-zinc-900/30 p-3 text-[13px]">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4 text-foreground items-start">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">ID</span>
            <MetaPill
              mono
              title={`Note ID ${note.note_id}`}
              actionIcon={<ExternalLinkIcon className="w-3.5 h-3.5" />}
              actionTitle="Open this note in Anki"
              actionAriaLabel="Open in Anki"
              onAction={() => { try { window.api.openInAnki(note.note_id) } catch {} }}
            >
              {note.note_id}
            </MetaPill>
          </div>
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Note Type</span>
            <MetaPill variant="sky" title={note.model_name}>{note.model_name}</MetaPill>
          </div>
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Last Modified</span>
            <MetaPill tooltip={note.mod ? new Date(note.mod * 1000).toLocaleString() : '—'}>{timeAgo}</MetaPill>
          </div>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Tags</div>
            {Array.isArray(tags) && tags.length > 0 && (
              <button
                className="text-[11px] px-1.5 py-0.5 rounded border bg-white hover:bg-zinc-50 dark:bg-zinc-900/30 dark:hover:bg-zinc-800/40"
                onClick={() => setShowFullPaths((v) => !v)}
                title={showFullPaths ? 'Show condensed tags' : 'Show full tag paths'}
              >{showFullPaths ? 'Condense' : 'Full paths'}</button>
            )}
          </div>
          {Array.isArray(tags) && tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {(showAllTags ? tags : tags.slice(0, TAG_MAX)).map((t) => {
                const parts = String(t || '').split('::')
                const tail = parts[parts.length - 1] || t
                const label = showFullPaths ? t : tail
                return (
                  <button
                    key={t}
                    className="inline-flex items-center max-w-full px-2 py-0.5 rounded-full border text-[12px] hover:opacity-90"
                    style={tagStyle(t)}
                    onClick={() => setOpenTag(t)}
                    title={`Show notes tagged: ${t}`}
                  >
                    <span className="truncate" title={t}>{label}</span>
                  </button>
                )
              })}
              {tags.length > TAG_MAX && (
                <button
                  className="text-[12px] px-1.5 py-0.5 rounded border bg-white hover:bg-zinc-50 dark:bg-zinc-900/30 dark:hover:bg-zinc-800/50"
                  onClick={() => setShowAllTags((v) => !v)}
                >
                  {showAllTags ? 'Show less' : `+${tags.length - TAG_MAX} more`}
                </button>
              )}
            </div>
          ) : (
            <div className="text-muted-foreground">—</div>
          )}
        </div>
      </div>
      ) : (
        <div className="rounded-md border bg-white/60 dark:bg-zinc-900/30 p-3 text-[13px] h-24 animate-pulse" />
      )}

      <RelatedNotes noteId={note.note_id} />
    </div>
  )
}

export default NoteDetailsView


