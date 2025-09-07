import React, { useState } from 'react'

type Item = {
  note_id: number
  first_field: string | null
  rerank?: number
}

type EpubNotesPanelProps = {
  items: Item[]
  onSelect?: (id: number) => void
}

export function EpubNotesPanel({ items, onSelect }: EpubNotesPanelProps): React.JSX.Element {
  const [openId, setOpenId] = useState<number | null>(null)
  return (
    <div className="min-h-0 h-full overflow-y-auto divide-y">
      {items.map((n) => (
        <div key={n.note_id} className="p-2">
          <button
            className="w-full text-left"
            onClick={() => {
              setOpenId((prev) => (prev === n.note_id ? null : n.note_id))
              onSelect && onSelect(n.note_id)
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm flex-1 truncate" dangerouslySetInnerHTML={{ __html: n.first_field || '' }} />
              {typeof n.rerank !== 'undefined' && (
                <span className="text-[11px] rounded-md px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                  Rerank: {Number(n.rerank).toFixed(3)}
                </span>
              )}
              <button
                className="text-[11px] ml-2 rounded-md px-2 py-0.5 bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
                title="Unsuspend this note in Anki"
                onClick={async (e) => {
                  e.stopPropagation()
                  try {
                    await (window as any).api?.unsuspendNotes?.([n.note_id])
                  } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('Unsuspend failed:', err)
                  }
                }}
              >
                Unsuspend
              </button>
            </div>
          </button>
          {openId === n.note_id && (
            <div className="mt-2 text-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: n.first_field || '' }} />
          )}
        </div>
      ))}
      {items.length === 0 && (
        <div className="p-3 text-xs text-muted-foreground">No related notes yet</div>
      )}
    </div>
  )
}
