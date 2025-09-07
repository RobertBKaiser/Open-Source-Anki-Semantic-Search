import React, { useEffect, useRef, useState } from 'react'
import ePub, { Book, Rendition, NavItem } from 'epubjs'

type EpubViewerProps = {
  file?: File | null
  url?: string
  buffer?: ArrayBuffer | null
  onSemanticFromSelection?: (text: string) => void
  onVisibleText?: (text: string) => void
}

export function EpubViewer({ file, url, buffer, onSemanticFromSelection, onVisibleText }: EpubViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  // removed unused 'book' state
  const [toc, setToc] = useState<NavItem[]>([])
  const [tocSel, setTocSel] = useState<string>("")
  const [selText, setSelText] = useState<string>("")

  useEffect(() => {
    const mount = async () => {
      if (!containerRef.current) return
      let b: Book
      if (buffer) {
        const blob = new Blob([buffer], { type: 'application/epub+zip' })
        const blobUrl = URL.createObjectURL(blob)
        b = ePub(blobUrl)
      } else if (file) {
        b = ePub(await file.arrayBuffer())
      } else if (url) {
        b = ePub(url)
      } else {
        return
      }
      // no-op: we don't currently use the book state
      const rendition = b.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'scrolled-doc',
        manager: 'continuous'
      })
      renditionRef.current = rendition
      // Apply a reader theme to improve typography while still respecting publisher CSS
      try {
        const css = `
          @namespace epub "http://www.idpf.org/2007/ops";
          html, body { background: transparent !important; }
          body { max-width: 42rem; margin: 0 auto; padding: 1rem 1rem 2rem; 
                 font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
                 line-height: 1.6; -webkit-hyphens: auto; hyphens: auto; text-rendering: optimizeLegibility; }
          p { margin: 0 0 1em; }
          h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 0.6em; font-weight: 600; }
          h1 { font-size: 1.6rem; } h2 { font-size: 1.4rem; } h3 { font-size: 1.25rem; } h4 { font-size: 1.15rem; }
          img, svg { max-width: 100%; height: auto; display: block; margin: 0.75em auto; }
          figure { margin: 1em 0; } figcaption { font-size: 0.875rem; color: #666; text-align: center; }
          blockquote { margin: 1em 0; padding: 0.5em 1em; border-left: 3px solid #ddd; color: #444; background: rgba(0,0,0,0.02); }
          ul, ol { padding-left: 1.25em; margin: 0 0 1em; }
          code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; }
          pre { white-space: pre-wrap; word-wrap: break-word; background: rgba(0,0,0,0.03); padding: 0.75em; border-radius: 6px; }
          a { color: #2563eb; text-decoration: none; } a:hover { text-decoration: underline; }
        `
        rendition.themes.register('reader', css)
        rendition.themes.select('reader')
        rendition.themes.fontSize('100%')
      } catch {}
      await rendition.display()
      // Selection handler
      try {
        rendition.on('selected', (_cfiRange: string, contents: any) => {
          try {
            const s = contents?.window?.getSelection?.()?.toString?.() || ''
            const t = String(s || '').trim()
            if (t) setSelText(t)
          } catch {
            // ignore
          }
        })
      } catch {}
      // Relocation handler: gather visible text for semantic updates
      try {
        rendition.on('relocated', async (_loc: any) => {
          try {
            const contents: any[] = (rendition as any)?.views?._views?.map((v: any) => v?.contents)?.filter(Boolean) || []
            const textParts: string[] = []
            for (const c of contents) {
              const doc = c?.document
              if (!doc) continue
              const body = doc.body
              const txt = body?.innerText || ''
              if (txt) textParts.push(txt)
            }
            const joined = textParts.join('\n').replace(/\s+/g, ' ').trim()
            if (joined && onVisibleText) onVisibleText(joined)
          } catch {
            // ignore
          }
        })
      } catch {}
      try {
        const nav = await b.loaded.navigation
        const flatten = (items: NavItem[], out: NavItem[] = []): NavItem[] => {
          for (const it of items) { out.push(it); if (Array.isArray(it.subitems)) flatten(it.subitems as any, out) }
          return out
        }
        setToc(flatten(nav.toc || []))
      } catch { setToc([]) }
    }
    mount()
    return () => {
      try { renditionRef.current?.destroy() } catch {}
    }
  }, [file, url, buffer])

  return (
    <div className="w-full h-full min-h-0 flex flex-col">
      <div className="p-2 flex items-center gap-2 border-b">
        <button className="text-xs px-2 py-1 rounded border" onClick={() => renditionRef.current?.prev()}>&lt; Prev</button>
        <button className="text-xs px-2 py-1 rounded border" onClick={() => renditionRef.current?.next()}>Next &gt;</button>
        {toc.length > 0 && (
          <select
            className="text-xs ml-2 border rounded px-2 py-1"
            value={tocSel}
            onChange={(e) => {
              const href = e.target.value
              setTocSel(href)
              if (href) renditionRef.current?.display(href)
            }}
          >
            <option value="" disabled>Table of contents</option>
            {toc.map((i, idx) => (
              <option key={`${i.href}-${idx}`} value={i.href || ''}>{i.label || i.href}</option>
            ))}
          </select>
        )}
        {selText && onSemanticFromSelection && (
          <button
            className="text-xs ml-auto px-2 py-1 rounded bg-orange-500 text-white hover:bg-orange-600"
            onClick={() => { onSemanticFromSelection(selText); setSelText("") }}
            title="Run semantic search on highlighted text"
          >
            Semantic search
          </button>
        )}
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}
