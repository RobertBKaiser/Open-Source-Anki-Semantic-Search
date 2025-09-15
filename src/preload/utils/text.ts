// Text and HTML normalization utilities used across preload APIs

// Strip HTML to plain text (spaces for <br>, remove tags, unescape, collapse ws)
export function stripHtmlToText(html: string): string {
  const s = String(html || '')
  return s
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[sound:[^\]]+\]/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// Variant that preserves placeholders for media to signal presence visually in text contexts
export function stripHtmlWithMediaPlaceholders(html: string): string {
  const s = String(html || '')
  const noImgs = s.replace(/<img[^>]*>/gi, ' 🖼️ ')
  const brSp = noImgs.replace(/<br\s*\/?\s*>/gi, ' ')
  const noTags = brSp.replace(/<[^>]*>/g, ' ')
  const noAudio = noTags.replace(/\[sound:[^\]]+\]/gi, ' 🔊 ')
  return noAudio
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// Normalize generic text (lowercase, collapse whitespace)
export function normalizeText(s: string): string {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Determine if front text should be considered visible (non-empty after strip or has media)
export function frontIsVisible(html: string | null | undefined): boolean {
  const raw = String(html || '')
  if (!raw) return false
  if (/\[sound:[^\]]+\]/i.test(raw) || /<img\b/i.test(raw)) return true
  const plain = stripHtmlToText(raw)
  return plain.length > 0
}


