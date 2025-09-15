import React from 'react'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - vite query import returns string
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'

function useDebouncedCallback(fn: (...args: any[]) => void, ms: number) {
  const ref = React.useRef<number | null>(null)
  return React.useCallback((...args: any[]) => {
    if (ref.current) window.clearTimeout(ref.current)
    ref.current = window.setTimeout(() => fn(...args), ms)
  }, [fn, ms])
}

// Format a note preview like Related notes: whitelist tags, color clozes, decode basic entities
function formatPreviewHtml(input: string | null): string {
  const src = String(input || '')
  let html0 = src
    .replace(/<img[^>]*>/gi, '🖼️')
    .replace(/\[sound:[^\]]+\]/gi, ' 🔊 ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
  html0 = html0.replace(/<(?!\/?(?:b|strong|i|em|u|sub|sup|mark|code)\b)[^>]*>/gi, '')
  const colors = ['#9b5de5', '#3a86ff', '#00c853', '#ff8f00', '#00e5ff', '#ff006e']
  html0 = html0.replace(/\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/gi, (_m, n, inner) => {
    const idx = (Number(n) - 1) % colors.length
    const color = colors[idx < 0 ? 0 : idx]
    return `<span style="color:${color};font-weight:600">${inner}</span>`
  })
  let safe = html0
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  safe = safe.replace(/[\u9000-\u9004]/g, '?')
  return safe
}

export function PdfPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [pdfUrl, setPdfUrl] = React.useState<string | null>(null)
  const [fileName, setFileName] = React.useState<string>('')
  const fileRef = React.useRef<HTMLInputElement | null>(null)

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const pdfDocRef = React.useRef<any>(null)
  const totalRef = React.useRef<number>(0)
  const sideRef = React.useRef<Map<number, HTMLElement>>(new Map())

  React.useEffect(() => () => { try { if (pdfUrl) URL.revokeObjectURL(pdfUrl) } catch {} }, [pdfUrl])

  React.useEffect(() => {
    let canceled = false
    ;(async () => {
      try {
        if (!pdfUrl) return
        const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
        try { (GlobalWorkerOptions as any).workerSrc = String(workerUrl) } catch {}
        const loadingTask = getDocument({ url: pdfUrl })
        const doc = await loadingTask.promise
        if (canceled) return
        pdfDocRef.current = doc
        totalRef.current = doc.numPages
        try { const el = containerRef.current; if (el) { el.innerHTML = ''; sideRef.current.clear() } } catch {}
        for (let p = 1; p <= doc.numPages; p++) {
          await renderPageWithSidebar(p)
          await processPageHybrid(p)
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('PDF load failed', e)
      }
    })()
    return () => { canceled = true }
  }, [pdfUrl])

  const PAGE_GUTTER = 340

  async function renderPageWithSidebar(pageNum: number) {
    const doc = pdfDocRef.current
    const host = containerRef.current
    if (!doc || !host) return
    const id = `pdf-page-${pageNum}`
    if (host.querySelector(`#${id}`)) return
    const page = await doc.getPage(pageNum)
    const baseVp = page.getViewport({ scale: 1 })
    const targetWidth = Math.min(1200, (host.clientWidth || 850))
    const scale = Math.max(1.5, targetWidth / baseVp.width)
    const vp = page.getViewport({ scale })

    const wrap = document.createElement('div')
    wrap.id = id
    wrap.style.position = 'relative'
    wrap.style.width = `${Math.floor(vp.width)}px`
    wrap.style.height = `${Math.floor(vp.height)}px`
    wrap.style.margin = '24px auto'
    wrap.style.background = '#ffffff'
    wrap.style.marginRight = `${PAGE_GUTTER + 16}px`

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.floor(vp.width * dpr)
    canvas.height = Math.floor(vp.height * dpr)
    canvas.style.width = `${Math.floor(vp.width)}px`
    canvas.style.height = `${Math.floor(vp.height)}px`
    wrap.appendChild(canvas)

    await page.render({ canvasContext: ctx as any, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise

    const label = document.createElement('div')
    label.textContent = `Page ${pageNum}/${totalRef.current}`
    label.style.position = 'absolute'
    label.style.left = '8px'
    label.style.top = '8px'
    label.style.background = 'rgba(255,255,255,0.8)'
    label.style.padding = '2px 6px'
    label.style.borderRadius = '6px'
    label.style.fontSize = '11px'
    label.style.border = '1px solid rgba(0,0,0,0.1)'
    wrap.appendChild(label)

    const side = document.createElement('div')
    side.style.position = 'absolute'
    side.style.left = `${Math.floor(vp.width) + 16}px`
    side.style.top = '0'
    side.style.width = `${PAGE_GUTTER}px`
    side.style.height = `${Math.floor(vp.height)}px`
    side.style.overflowY = 'auto'
    side.style.pointerEvents = 'auto'
    sideRef.current.set(pageNum, side)
    wrap.appendChild(side)

    host.appendChild(wrap)
  }

  function renderCardsIntoSidebar(pageNum: number, results: Array<{ note_id: number; first_field: string | null; score?: number }>) {
    const side = sideRef.current.get(pageNum)
    if (!side) return
    side.innerHTML = ''
    results.slice(0, 50).forEach((r) => {
      const card = document.createElement('div')
      card.className = 'bg-card border rounded-lg shadow-sm p-3 mb-3'
      const header = document.createElement('div')
      header.className = 'flex items-center justify-between mb-1'
      const left = document.createElement('div')
      left.className = 'text-[10px] font-semibold tracking-wide text-muted-foreground'
      left.textContent = `Page ${pageNum}`
      header.appendChild(left)
      if (typeof (r as any).score === 'number') {
        const badge = document.createElement('div')
        badge.className = 'text-[10px] rounded px-1 py-[1px] bg-blue-100 text-blue-700 border border-blue-200'
        badge.textContent = `${Math.round((r as any).score * 100)}%`
        header.appendChild(badge)
      }
      card.appendChild(header)
      const content = document.createElement('div')
      content.className = 'text-[13px] leading-relaxed whitespace-normal break-words'
      content.innerHTML = formatPreviewHtml((r as any).first_field || '')
      card.appendChild(content)
      const actions = document.createElement('div')
      actions.className = 'mt-2 flex items-center gap-2'
      const openBtn = document.createElement('button')
      openBtn.className = 'text-xs rounded-md px-2 py-0.5 border bg-zinc-50 hover:bg-zinc-100'
      openBtn.textContent = 'Open'
      actions.appendChild(openBtn)
      const pinBtn = document.createElement('button')
      pinBtn.className = 'text-xs rounded-md px-2 py-0.5 border bg-zinc-50 hover:bg-zinc-100'
      pinBtn.textContent = 'Pin'
      actions.appendChild(pinBtn)
      card.appendChild(actions)
      side.appendChild(card)
    })
  }

  async function processPageHybrid(pageNum: number) {
    try {
      const doc = pdfDocRef.current
      if (!doc) return
      const page = await doc.getPage(pageNum)
      const content = await page.getTextContent()
      const text = content.items.map((it: any) => String(it?.str || '')).join(' ').replace(/\s+/g, ' ').trim()
      // eslint-disable-next-line no-console
      console.log(`[PDF] Page ${pageNum}/${totalRef.current} text (first 4000 chars):`, text.slice(0, 4000))
      const results = await (window as any).api?.hybridSemanticModulated?.(text, 40)
      // eslint-disable-next-line no-console
      console.log(`[PDF] Hybrid results for page ${pageNum}:`, results)
      if (Array.isArray(results)) {
        renderCardsIntoSidebar(pageNum, results as any)
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('processPageHybrid failed', e)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b bg-background flex items-center gap-2">
        <button
          className="text-xs rounded-md px-2 py-1 border bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900/40 dark:hover:bg-zinc-800/60"
          onClick={onBack}
          title="Back to Notes"
        >
          ← Back to Notes
        </button>
        <button
          className="ml-2 text-xs rounded-md px-2 py-1 border bg-amber-400 text-black hover:bg-amber-500"
          onClick={() => fileRef.current?.click()}
          title="Open a local PDF file"
        >
          Open PDF…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            try {
              const url = URL.createObjectURL(f)
              setPdfUrl((old) => { try { if (old) URL.revokeObjectURL(old) } catch {}; return url })
              setFileName(f.name || '')
            } catch {}
          }}
        />
        {fileName && (
          <div className="ml-2 text-xs text-muted-foreground truncate" title={fileName}>{fileName}</div>
        )}
        <div className="ml-auto text-[11px] text-muted-foreground">pdf.js mode</div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 overflow-auto">
          <div className="mx-auto my-6 max-w-[850px]">
            {pdfUrl ? (
              <div ref={containerRef} className="min-h-[600px]" />
            ) : (
              <div className="h-[600px] border rounded-md bg-white grid place-items-center text-3xl font-semibold text-amber-600 shadow">PDF</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
