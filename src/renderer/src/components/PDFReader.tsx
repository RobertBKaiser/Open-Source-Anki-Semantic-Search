import React from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'

// Configure worker for Vite/Electron
try {
  // @ts-ignore
  GlobalWorkerOptions.workerSrc = /* @vite-ignore */ new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
} catch {}

export function PDFReader(): React.JSX.Element {
  const [fileName, setFileName] = React.useState<string>('')
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const viewerElRef = React.useRef<HTMLDivElement | null>(null)
  const viewerRef = React.useRef<any>(null)
  const eventBusRef = React.useRef<any>(null)
  const docRef = React.useRef<PDFDocumentProxy | null>(null)
  const [scalePct, setScalePct] = React.useState<number>(100)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const hasEmbedKeyRef = React.useRef<boolean>(true)
  const currentPageRef = React.useRef<number>(0)
  const [, setPanelLoading] = React.useState<boolean>(false)
  const debugByPageRef = React.useRef<Map<number, string>>(new Map())
  const [, setDebugText] = React.useState<string>('')
  // global panel no longer used; keep local per-page gutters
  // const [related, setRelated] = React.useState<Array<{ note_id: number; first_field: string | null; rerank: number }>>([])
  // const [loadingRelated, setLoadingRelated] = React.useState<boolean>(false)
  // leftover from section overlays; not used now
  // const overlaysRef = React.useRef<HTMLElement[]>([])
  const guttersRef = React.useRef<Map<number, HTMLDivElement>>(new Map())
  const pageDoneRef = React.useRef<Set<number>>(new Set())
  const resultsCacheRef = React.useRef<Map<number, Array<{ note_id: number; first_field: string | null; rerank: number }>>>(new Map())
  const queueRef = React.useRef<number[]>([])
  const enqueuedRef = React.useRef<Set<number>>(new Set())
  const processingRef = React.useRef<boolean>(false)

  const appendDebug = (idx: number, line: string) => {
    const prev = debugByPageRef.current.get(idx) || ''
    const next = prev ? `${prev}\n${line}` : line
    debugByPageRef.current.set(idx, next)
    if (idx === currentPageRef.current) setDebugText(next)
  }

  const enqueuePage = (idx: number) => {
    if (idx < 0) return
    if (pageDoneRef.current.has(idx) || enqueuedRef.current.has(idx)) return
    enqueuedRef.current.add(idx)
    queueRef.current.push(idx)
    // eslint-disable-next-line no-console
    console.log('[PDFReader] enqueuePage', idx + 1)
    appendDebug(idx, `Enqueued page ${idx + 1}`)
    void processQueue()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // remove outstanding page adornments (used when reloading a PDF)
  // (removed) clearOverlays helper was used for section overlays; not needed now

  // helpers removed in this mode; keep empty computeSections below

  const computeSections = React.useCallback(() => {
    // Disabled in page-gutter mode
  }, [])

  // Create/position a gutter to the right of a page element
  const ensurePageGutter = (pageEl: HTMLElement, pageIndex: number): HTMLDivElement => {
    let gutter = guttersRef.current.get(pageIndex)
    if (!gutter) {
      gutter = document.createElement('div')
      gutter.className = 'pdf-page-gutter'
      gutter.style.position = 'absolute'
      gutter.style.top = '0px'
      gutter.style.width = '280px'
      gutter.style.pointerEvents = 'auto'
      gutter.style.zIndex = '40'
      gutter.style.background = 'transparent'
      pageEl.appendChild(gutter)
      guttersRef.current.set(pageIndex, gutter)
    }
    const left = pageEl.clientWidth + 12
    gutter.style.left = `${left}px`
    gutter.style.height = `${pageEl.clientHeight}px`
    gutter.style.overflowY = 'auto'
    gutter.style.overflowX = 'hidden'
    return gutter
  }

  // Render note items into a given gutter
  const renderPageResults = (gutter: HTMLDivElement, results: Array<{ note_id: number; first_field: string | null; rerank: number }>) => {
    gutter.innerHTML = ''
    const title = document.createElement('div')
    title.textContent = 'Related notes'
    title.style.fontSize = '12px'
    title.style.fontWeight = '600'
    title.style.margin = '0 0 6px 0'
    title.style.color = 'var(--foreground, #111)'
    gutter.appendChild(title)
    results.forEach((r) => {
      const item = document.createElement('div')
      item.className = 'pdf-gutter-item'
      item.style.border = '1px solid rgba(0,0,0,0.12)'
      item.style.borderRadius = '8px'
      item.style.padding = '6px'
      item.style.margin = '0 0 8px 0'
      item.style.background = 'white'
      const score = typeof r.rerank === 'number' ? `${Math.round(r.rerank * 1000) / 10}%` : ''
      item.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><div style="font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(r.first_field||'').replace(/\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/gi, (_m,n,inner)=>`<span style='color:${['#9b5de5','#3a86ff','#00c853','#ff8f00','#00e5ff','#ff006e'][((Number(n)-1)%6)]};font-weight:600'>${String(inner).replace(/<[^>]*>/g,'')}</span>`)}</div>${score?`<span style='font-size:11px;background:rgba(99,102,241,.12);color:#6366f1;padding:2px 6px;border-radius:8px;'>${score}</span>`:''}</div>`
      gutter.appendChild(item)
    })
  }

  // Observe visible pages, enqueue sequential jobs, and update current page
  React.useEffect(() => {
    const container = containerRef.current
    if (!container || !docRef.current) return
    const observer = new IntersectionObserver((entries) => {
      let bestIdx = currentPageRef.current
      let bestRatio = 0
      for (const e of entries) {
        const pageEl = e.target as HTMLElement
        const pageAttr = pageEl.getAttribute('data-page-number')
        const idx = pageAttr ? Number(pageAttr) - 1 : -1
        if (idx < 0) continue
        ensurePageGutter(pageEl, idx)
        if (e.intersectionRatio > bestRatio) { bestRatio = e.intersectionRatio; bestIdx = idx }
        if (e.isIntersecting) enqueuePage(idx)
      }
      if (bestIdx !== currentPageRef.current) {
        currentPageRef.current = bestIdx
        // Right-side panel removed; results still cached per page
      }
    }, { root: container, rootMargin: '0px 0px 0px 0px', threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] })
    const scanAndObserve = () => {
      const pages = Array.from(container.querySelectorAll('.page')) as HTMLElement[]
      pages.forEach(p => observer.observe(p))
    }
    scanAndObserve()
    const mo = new MutationObserver(() => scanAndObserve())
    mo.observe(container, { childList: true, subtree: true })
    return () => { mo.disconnect(); observer.disconnect() }
  }, [fileName])

  async function processQueue(): Promise<void> {
    if (processingRef.current) return
    processingRef.current = true
    try {
      while (queueRef.current.length > 0) {
        const idx = queueRef.current.shift() as number
        try {
          const d = docRef.current
          if (!d) continue
          const page = await d.getPage(idx + 1)
          const tc = await page.getTextContent()
          const text = (tc.items as any[])
            .map((it) => String((it as any)?.str || '').trim())
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .slice(0, 20000)
          if (!text || !hasEmbedKeyRef.current) { pageDoneRef.current.add(idx); continue }
          const query = text.slice(0, 1200)
          if (idx === currentPageRef.current) setPanelLoading(true)
          debugByPageRef.current.set(idx, `Page ${idx+1} query (first 300 chars):\n` + query.slice(0,300))
          if (idx === currentPageRef.current) setDebugText(debugByPageRef.current.get(idx) || '')
          // eslint-disable-next-line no-console
          console.log('[PDFReader] enqueue job', idx+1, 'query.len=', query.length)
          let results: any = null
          try {
            results = await Promise.race([
              (window as any).api?.embedSearch?.(query, 30),
              new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 12000))
            ])
          } catch {}
          if (results === '__timeout__' || !Array.isArray(results) || results.length === 0) {
            try {
              const sr = await (window as any).api?.semanticRerankSmall?.(query)
              if (Array.isArray(sr)) results = sr.map((r: any) => ({ note_id: r.note_id, first_field: r.first_field, rerank: r.rerank || 0 }))
            } catch {}
          }
          const arr = Array.isArray(results) ? results : []
          // eslint-disable-next-line no-console
          console.log('[PDFReader] job done', idx+1, 'results=', Array.isArray(results) ? results.length : String(results))
          debugByPageRef.current.set(idx, (debugByPageRef.current.get(idx) || '') + `\nResults: ${arr.length}`)
          if (idx === currentPageRef.current) setDebugText(debugByPageRef.current.get(idx) || '')
          resultsCacheRef.current.set(idx, arr)
          const pageEl = containerRef.current?.querySelector(`.page[data-page-number="${idx + 1}"]`) as HTMLElement | null
          if (pageEl) {
            const gutter = ensurePageGutter(pageEl, idx)
            renderPageResults(gutter, arr)
          }
          pageDoneRef.current.add(idx)
          if (idx === currentPageRef.current) setPanelLoading(false)
        } catch {
          // ignore job error
          if (idx === currentPageRef.current) setPanelLoading(false)
        }
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      processingRef.current = false
    }
  }

  // Init PDFViewer once
  React.useEffect(() => {
    (async () => {
      if (!containerRef.current || !viewerElRef.current || viewerRef.current) return
      const mod: any = await import('pdfjs-dist/web/pdf_viewer.mjs')
      const eventBus = new mod.EventBus()
      eventBusRef.current = eventBus
      const viewer = new mod.PDFViewer({
        container: containerRef.current,
        viewer: viewerElRef.current,
        eventBus,
        textLayerMode: 2
      })
      viewerRef.current = viewer
    })()
  }, [])

  // Wire global Import PDF button
  React.useEffect(() => {
    const handler = () => { try { fileInputRef.current?.click() } catch {} }
    window.addEventListener('pdf-import-click', handler)
    return () => window.removeEventListener('pdf-import-click', handler)
  }, [])

  // Check for DeepInfra key so we can warn/skip gracefully
  React.useEffect(() => {
    try {
      const key = (window as any).api?.getSetting?.('deepinfra_api_key')
      hasEmbedKeyRef.current = !!key
    } catch {
      hasEmbedKeyRef.current = true
    }
  }, [])

  const fitWidth = () => {
    const v = viewerRef.current
    if (!v) return
    v.currentScaleValue = 'page-width'
    setScalePct(Math.round((v.currentScale || 1) * 100))
  }

  const onPick = async (f: File) => {
    try {
      setFileName(f.name)
      const ab = await f.arrayBuffer()
      const loadingTask = getDocument({ data: ab })
      const doc: PDFDocumentProxy = await loadingTask.promise
      if (!viewerRef.current) return
      viewerRef.current.setDocument(doc)
      docRef.current = doc
      // Fit width after first pages attached
      setTimeout(fitWidth, 50)
      // Proactively enqueue first page after load in case observer is slow
      setTimeout(() => enqueuePage(0), 200)
      // No global section overlays or whole-document search in per-page mode
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to load PDF', e)
    }
  }

  const zoomBy = (delta: number) => {
    const v = viewerRef.current
    if (!v) return
    const next = Math.max(0.25, Math.min(3, (v.currentScale || 1) + delta))
    v.currentScale = next
    setScalePct(Math.round(next * 100))
    // Recompute sections after zoom change
    setTimeout(computeSections, 250)
  }

  return (
    <div className="h-full">
      <div className="rounded-lg border bg-card overflow-hidden relative">
        <div className="p-2 h-10 flex items-center gap-2 border-b sticky top-0 bg-background z-20">
          <input ref={fileInputRef} type="file" accept="application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f) }} />
          <span className="text-xs text-muted-foreground">{fileName}</span>
          <div className="ml-auto flex items-center gap-1">
            <button className="px-2 py-0.5 border rounded" onClick={() => zoomBy(-0.1)}>-</button>
            <span className="text-xs w-10 text-center">{scalePct}%</span>
            <button className="px-2 py-0.5 border rounded" onClick={() => zoomBy(0.1)}>+</button>
            <button className="px-2 py-0.5 border rounded" onClick={fitWidth}>Fit</button>
          </div>
        </div>
        {/* The PDFViewer requires the container to be absolutely positioned */}
        <div ref={containerRef} className="absolute inset-0 overflow-auto pt-12">
          <div className="px-3 pb-3">
            <div ref={viewerElRef} className="pdfViewer" />
          </div>
        </div>
      </div>
    </div>
  )
}
