import React from 'react'

export type LibraryBook = {
  id: string
  title: string
  path: string
  coverDataUrl?: string | null
  progressPct?: number
  lastCfi?: string | null
}

type EpubLibraryProps = {
  books: LibraryBook[]
  onOpen: (book: LibraryBook) => void
  onDelete?: (book: LibraryBook) => void
}

export function EpubLibrary({ books, onOpen, onDelete }: EpubLibraryProps): React.JSX.Element {
  return (
    <div className="w-full h-full min-h-0 p-6 overflow-auto">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-10">
        {books.map((b) => (
          <div key={b.id} className="group text-left">
            <div className="relative rounded-lg shadow-md overflow-hidden border bg-white">
              <button
                className="absolute inset-0"
                aria-label={`Open ${b.title}`}
                onClick={() => onOpen(b)}
                title={b.title}
              />
              {b.coverDataUrl ? (
                <img src={b.coverDataUrl} alt={b.title} className="w-full h-[300px] object-cover" />
              ) : (
                <div className="w-full h-[300px] flex items-center justify-center bg-zinc-100">
                  <span className="px-4 text-zinc-700 text-sm line-clamp-3 text-center">{b.title}</span>
                </div>
              )}
              {onDelete && (
                <button
                  className="absolute top-2 right-2 bg-white/90 border rounded px-2 py-1 text-xs hover:bg-white"
                  onClick={(e) => { e.stopPropagation(); onDelete(b) }}
                  title="Delete book"
                >
                  Delete
                </button>
              )}
            </div>
            <div className="mt-2 text-sm text-zinc-700 line-clamp-2">{b.title}</div>
            <div className="mt-1 text-xs text-zinc-500">{Math.round(b.progressPct || 0)}%</div>
          </div>
        ))}
        {books.length === 0 && (
          <div className="text-sm text-zinc-500">No books yet. Use “Import Book” to add one.</div>
        )}
      </div>
    </div>
  )
}


