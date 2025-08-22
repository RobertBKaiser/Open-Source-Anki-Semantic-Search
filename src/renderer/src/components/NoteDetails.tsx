import React from 'react'

type Field = { field_name: string; value_html: string; ord: number | null }

type NoteDetailsData = {
  note: { note_id: number; model_name: string; mod: number | null }
  fields: Field[]
  tags: string[]
}

type NoteDetailsProps = {
  data: NoteDetailsData | null
}

const MEDIA_DIR = '/Users/buckykaiser/Library/Application Support/Anki2/Omniscience/collection.media'

function rewriteMediaHtml(html: string): string {
  // Replace <img src="file"> with absolute media path; convert [sound:...] to an audio element placeholder
  const img = html.replace(/<img ([^>]*?)src=\"([^\"]+)\"([^>]*?)>/g, (_m, pre, src, post) => {
    const abs = `${MEDIA_DIR}/${src}`
    return `<img ${pre}src=\"${abs}\"${post}>`
  })
  const audio = img.replace(/\[sound:([^\]]+)\]/g, (_m, file) => {
    const abs = `${MEDIA_DIR}/${file}`
    return `<audio controls src=\"${abs}\"></audio>`
  })
  return audio
}

export function NoteDetails({ data }: NoteDetailsProps): React.JSX.Element {
  if (!data) return <div className="p-4 text-sm text-muted-foreground">Select a note to view details.</div>
  const { note, fields, tags } = data
  return (
    <div className="min-h-0 h-full overflow-y-auto p-4 space-y-4">
      <div className="space-y-2">
        {fields.map((f) => (
          <div key={f.field_name} className="border rounded-md p-3">
            <div className="font-medium mb-2">{f.field_name}</div>
            <div dangerouslySetInnerHTML={{ __html: rewriteMediaHtml(f.value_html) }} />
          </div>
        ))}
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <div>ID: {note.note_id}</div>
        <div>Model: {note.model_name}</div>
        <div>Last Modified: {note.mod ? new Date(note.mod * 1000).toLocaleString() : '—'}</div>
        <div>Tags: {tags.join(', ') || '—'}</div>
      </div>
    </div>
  )
}


