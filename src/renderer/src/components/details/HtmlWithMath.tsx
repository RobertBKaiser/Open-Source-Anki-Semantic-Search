import React from 'react'
import renderMathInElement from 'katex/contrib/auto-render/auto-render'
import 'katex/dist/katex.min.css'

// User feedback: Detailed view should render instantly without blank flashes.
// - Insert sanitized HTML immediately, then render KaTeX only when math exists
// - Use requestAnimationFrame/requestIdleCallback to avoid blocking INP

const MEDIA_DIR = '/Users/buckykaiser/Library/Application Support/Anki2/Omniscience/collection.media'

export function rewriteMediaHtml(html: string): string {
  let out = html
  const toFileUrl = (rel: string): string => `file://${encodeURI(`${MEDIA_DIR}/${rel}`)}`
  const rewriteTagSrc = (tag: string): void => {
    const re = new RegExp(`<${tag}([^>]*?)src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))([^>]*)>`, 'gi')
    out = out.replace(re, (_m, pre: string, dq?: string, sq?: string, bare?: string, post?: string) => {
      const src = dq || sq || bare || ''
      const s = /^(?:https?:|file:|data:|blob:)/i.test(src) ? src : toFileUrl(src)
      const lower = tag.toLowerCase()
      const isVideo = lower === 'video'
      const isAudio = lower === 'audio'
      const needsControls = (isAudio || isVideo) && !/controls/i.test(String(pre) + String(post))
      const hasStyle = /style=/i.test(String(pre) + String(post))
      const style = isVideo ? ' style="max-width:100%"' : ''
      const ctrl = needsControls ? ' controls' : ''
      const hasLoading = /loading=/i.test(String(pre) + String(post))
      const hasDecoding = /decoding=/i.test(String(pre) + String(post))
      const hasPreload = /preload=/i.test(String(pre) + String(post))
      const asyncImg = lower === 'img' ? `${hasLoading ? '' : ' loading="lazy"'}${hasDecoding ? '' : ' decoding="async"'}` : ''
      const preload = isVideo ? (hasPreload ? '' : ' preload="metadata"') : (isAudio ? (hasPreload ? '' : ' preload="none"') : '')
      return `<${tag}${pre}src="${s}"${post}${hasStyle ? '' : style}${ctrl}${asyncImg}${preload}>`
    })
  }
  rewriteTagSrc('img')
  rewriteTagSrc('audio')
  rewriteTagSrc('video')
  out = out.replace(/<source([^>]*?)src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))([^>]*?)>/gi, (_m, pre: string, dq?: string, sq?: string, bare?: string, post?: string) => {
    const src = dq || sq || bare || ''
    const s = /^(?:https?:|file:|data:|blob:)/i.test(src) ? src : toFileUrl(src)
    return `<source${pre}src="${s}"${post}>`
  })
  out = out.replace(/\[sound:([^\]]+)\]/g, (_m, file) => {
    const s = toFileUrl(file)
    const lower = String(file).toLowerCase()
    const isVideo = /\.(mp4|m4v|webm|mov|avi)$/i.test(lower)
    if (isVideo) return `<video controls preload="metadata" src="${s}" style="max-width:100%"></video>`
    return `<audio controls preload="none" src="${s}"></audio>`
  })
  return out
}

// Cache sanitized HTML by noteId|field to avoid repeat work
const fieldHtmlCache: Map<string, string> = new Map()
export function sanitizeFieldHtml(cacheKey: string, html: string): string {
  const cached = fieldHtmlCache.get(cacheKey)
  if (cached) return cached
  const safe = rewriteMediaHtml(
    String(html || '')
      .replace(/[\u9000-\u9004]/g, '?')
      .replace(/\u232C|⌬/g, '?')
  )
  if (fieldHtmlCache.size > 500) fieldHtmlCache.clear()
  fieldHtmlCache.set(cacheKey, safe)
  return safe
}

export function HtmlWithMathLazy({ html, cacheKey }: { html: string; cacheKey: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const hasMath = React.useMemo(() => /\$\$|\\\[|\\\(|(^|[^\\])\$/m.test(String(html || '')), [html])
  const content = React.useMemo(() => sanitizeFieldHtml(cacheKey, html), [cacheKey, html])
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = content
    if (!hasMath) return
    const schedule = (cb: () => void): void => {
      try {
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => cb())
          return
        }
      } catch {}
      const rid = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback
      if (typeof rid === 'function') rid(() => cb(), { timeout: 60 })
      else window.setTimeout(cb, 0)
    }
    schedule(() => {
      try {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false,
          trust: true,
          strict: false
        })
      } catch (e) {
        try { console.warn('KaTeX rendering failed in HtmlWithMath:', e) } catch {}
      }
    })
  }, [content, hasMath])
  return <div ref={ref} />
}

// Basic helpers used in Field components
export function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function stripHtml(input: string): string {
  return input.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, '')
}

export function cleanText(input: string): string {
  const decoded = decodeEntities(stripHtml(input))
  const noMustache = decoded.replace(/\{\{[^}]+\}\}/g, '')
  return noMustache.replace(/\s+/g, ' ').trim()
}


