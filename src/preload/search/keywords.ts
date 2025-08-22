import type Database from 'better-sqlite3'

const COMMON_WORDS = [
  'the','of','and','to','in','a','is','that','it','for','on','as','with','this','by','an','be','are','from','or','was','at','which','also','but','not','have','has','were','their','can','may','more','most','other','some','such','no','one','two','than','into','between','without','within','over','after','before','about','during','against','under'
]
const COMMON_RANK = new Map(COMMON_WORDS.map((w, i) => [w, i + 1]))
const STOPWORDS = new Set<string>([...COMMON_WORDS, 'i','you','he','she','we','they','my','our','your','his','her','its','their','yes','no'])

export type KeywordExtraction = { keywords: string[]; phrases: string[]; matchExpr: string }
export type KeywordOpts = {
  minLen?: number
  alphaOnly?: boolean
  topK?: number | null
  topPercent?: number | null
  expandStop?: string[]
}

export function extractKeywords(_db: Database.Database, input: string, opts: KeywordOpts = {}): KeywordExtraction {
  const { minLen = 3, alphaOnly = true, topK = 10, topPercent = null, expandStop = [] } = opts
  const lower = String(input || '').toLowerCase()
  const STOP = new Set([...STOPWORDS, ...expandStop.map((s) => s.toLowerCase())])
  let tokens = (lower.match(/[\p{L}]+/gu) || []).filter((t) => t.length >= minLen && !STOP.has(t))
  if (alphaOnly) tokens = tokens.filter((t) => /^[a-z]+$/.test(t))
  if (tokens.length === 0) return { keywords: [], phrases: [], matchExpr: lower.trim() }
  const uniq = Array.from(new Set(tokens))
  const scored = uniq
    .map((t) => {
      const rank = COMMON_RANK.get(t)
      const rarity = rank ? 1 / (rank + 1) : 1
      return { t, rarity, len: t.length }
    })
    .sort((a, b) => (b.rarity - a.rarity) || (b.len - a.len))
  let kept = scored
  if (topPercent != null) kept = kept.slice(0, Math.max(1, Math.floor(kept.length * topPercent)))
  if (topK != null) kept = kept.slice(0, topK)
  const keywords = kept.map((x) => x.t)
  const matchExpr = keywords.length ? keywords.map((t) => `"${t}"`).join(' OR ') : lower.trim()
  return { keywords, phrases: [], matchExpr }
}


