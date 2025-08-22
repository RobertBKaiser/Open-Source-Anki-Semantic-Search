// Lightweight YAKE + TextRank keyword/phrase extractor
// Pure module: no DB calls, safe for workers

export type Phrase = {
  text: string
  score: number
  scores: { yake: number; textrank: number }
  firstPosition: number
  occurrences: number
  tokens: string[]
  debug?: unknown
}

export type ExtractOptions = {
  language?: string
  maxCandidates?: number
  topK?: number
  phraseLen?: [number, number]
  window?: number
  fusion?: 'avg' | 'rrf'
  weights?: { yake: 0.5; textrank: 0.5 }
  dedupeThreshold?: number
  stopwords?: Set<string>
  posFilter?: boolean
  debug?: boolean
}

const DEFAULT_STOP = new Set<string>([
  'the','a','an','and','or','but','if','then','else','of','to','in','on','for','by','with','as','at','from','into','about','over','after','before','between','out','against','during','without','within','along','across','behind','beyond','plus','minus','per','via','is','are','was','were','be','been','being','do','does','did','done','can','could','should','would','may','might','must','will','not','no','yes','this','that','these','those','it','its','his','her','their','our','your','my','we','you','they','he','she','i'
])

// Domain-generic words to suppress as keyphrases
;['pattern','rate','depth','breathing','respiration','respirations','followed','again','period'].forEach((w) => DEFAULT_STOP.add(w))

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{Diacritic}+/gu, '').toLowerCase()
}

function sentenceSplit(text: string): string[] {
  return text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean)
}

function tokenize(text: string): { tokens: string[]; positions: number[] } {
  const out: string[] = []
  const pos: number[] = []
  // Keep hyphenated compounds (e.g., Cheyne-Stokes) as single tokens
  const re = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(m[0])
    pos.push(m.index)
  }
  return { tokens: out, positions: pos }
}

function minMaxNorm(values: number[]): (x: number) => number {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const denom = max - min || 1
  return (x: number) => (x - min) / denom
}

export function extractKeyPhrases(text: string, opts: ExtractOptions = {}): { phrases: Phrase[] } {
  const {
    maxCandidates = 200,
    topK = 30,
    phraseLen = [1, 5],
    window = 3,
    fusion = 'avg',
    weights = { yake: 0.5, textrank: 0.5 },
    dedupeThreshold = 0.8,
    stopwords = DEFAULT_STOP,
    debug = false
  } = opts

  const norm = normalize(text)
  const sentences = sentenceSplit(norm)
  const sentTokens = sentences.map((s) => tokenize(s).tokens)
  // Capture original tokens to detect capitalization
  const origSentences = sentenceSplit(text)
  const origSentTokens = origSentences.map((s) => tokenize(s).tokens)

  // Candidate phrases: contiguous non-stopword spans
  const candidates: { tokens: string[]; text: string; firstPos: number; sentIndex: number }[] = []
  const [minLen, maxLen] = phraseLen
  let globalOffset = 0
  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si]
    const { tokens, positions } = tokenize(s)
    let cur: string[] = []
    let curStart = -1
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i]
      const isStop = stopwords.has(tk)
      if (isStop || tk.length === 0) {
        if (cur.length >= minLen && cur.length <= maxLen) {
          candidates.push({ tokens: [...cur], text: cur.join(' '), firstPos: globalOffset + curStart, sentIndex: si })
        }
        cur = []
        curStart = -1
      } else {
        if (cur.length === 0) curStart = positions[i]
        cur.push(tk)
        if (cur.length === maxLen) {
          candidates.push({ tokens: [...cur], text: cur.join(' '), firstPos: globalOffset + curStart, sentIndex: si })
          cur = []
          curStart = -1
        }
      }
    }
    if (cur.length >= minLen && cur.length <= maxLen) {
      candidates.push({ tokens: [...cur], text: cur.join(' '), firstPos: globalOffset + curStart, sentIndex: si })
    }
    globalOffset += s.length + 1
  }
  if (candidates.length === 0) return { phrases: [] }

  // Word stats for YAKE-like scoring
  const wordInfo = new Map<string, { freq: number; firstPos: number; sents: Set<number>; left: Set<string>; right: Set<string> }>()
  const properWord = new Map<string, boolean>()
  for (let si = 0; si < sentTokens.length; si++) {
    const toks = sentTokens[si]
    const oToks = origSentTokens[si] || []
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i]
      if (stopwords.has(w)) continue
      if (!wordInfo.has(w)) wordInfo.set(w, { freq: 0, firstPos: Infinity, sents: new Set(), left: new Set(), right: new Set() })
      const info = wordInfo.get(w)!
      info.freq++
      info.firstPos = Math.min(info.firstPos, i)
      info.sents.add(si)
      if (i > 0) info.left.add(toks[i - 1])
      if (i + 1 < toks.length) info.right.add(toks[i + 1])
      // Mark proper if original token includes an uppercase letter
      const orig = oToks[i] || ''
      if (/[A-Z]/.test(orig)) properWord.set(w, true)
    }
  }
  const posNorm = minMaxNorm(Array.from(wordInfo.values()).map((v) => -v.firstPos))
  const freqNorm = minMaxNorm(Array.from(wordInfo.values()).map((v) => Math.log1p(v.freq)))
  const sentNorm = minMaxNorm(Array.from(wordInfo.values()).map((v) => v.sents.size))
  const ctxNorm = minMaxNorm(Array.from(wordInfo.values()).map((v) => v.left.size + v.right.size))
  const wordScore = new Map<string, number>()
  for (const [w, v] of wordInfo.entries()) {
    let s = Math.max(1e-6, posNorm(-v.firstPos)) * Math.max(1e-6, freqNorm(Math.log1p(v.freq))) * Math.max(1e-6, sentNorm(v.sents.size)) * Math.max(1e-6, ctxNorm(v.left.size + v.right.size))
    // Strongly boost hyphenated compounds and proper-cased tokens
    if (w.includes('-')) s *= 2.2
    if (properWord.get(w)) s *= 1.6
    // Penalize common verb-like suffixes that show up as generic actions
    if (/ed$|ing$/.test(w)) s *= 0.6
    wordScore.set(w, Math.min(1, s))
  }

  // TextRank on co-occurrence graph
  const nodes = Array.from(wordInfo.keys())
  const index = new Map(nodes.map((w, i) => [w, i]))
  const n = nodes.length
  const adj = Array.from({ length: n }, () => new Map<number, number>())
  for (const toks of sentTokens) {
    for (let i = 0; i < toks.length; i++) {
      const wi = toks[i]
      if (stopwords.has(wi) || !index.has(wi)) continue
      for (let j = i + 1; j < Math.min(i + window, toks.length); j++) {
        const wj = toks[j]
        if (stopwords.has(wj) || !index.has(wj)) continue
        const a = index.get(wi)!, b = index.get(wj)!
        adj[a].set(b, (adj[a].get(b) || 0) + 1)
        adj[b].set(a, (adj[b].get(a) || 0) + 1)
      }
    }
  }
  let rank = new Float64Array(n).fill(1 / n)
  const d = 0.85
  for (let iter = 0; iter < 20; iter++) {
    const next = new Float64Array(n).fill((1 - d) / n)
    for (let u = 0; u < n; u++) {
      let sumW = 0
      adj[u].forEach((w) => (sumW += w))
      if (sumW === 0) continue
      adj[u].forEach((w, v) => {
        next[v] += d * (w / sumW) * rank[u]
      })
    }
    rank = next
  }
  const rankNorm = minMaxNorm(Array.from(rank))
  const wordTR = new Map(nodes.map((w, i) => [w, rankNorm(rank[i])]))

  // Score candidates
  type Cand = { text: string; tokens: string[]; firstPosition: number; occurrences: number; yake: number; textrank: number; sentSet: Set<number> }
  const merged = new Map<string, Cand>()
  for (const c of candidates) {
    const key = c.tokens.join(' ')
    const existing = merged.get(key)
    const yake = c.tokens.reduce((a, w) => a + (wordScore.get(w) || 0), 0) / c.tokens.length
    const tr = c.tokens.reduce((a, w) => a + (wordTR.get(w) || 0), 0) / c.tokens.length
    if (!existing) {
      merged.set(key, { text: c.text, tokens: c.tokens, firstPosition: c.firstPos, occurrences: 1, yake, textrank: tr, sentSet: new Set([c.sentIndex]) })
    } else {
      existing.occurrences++
      existing.firstPosition = Math.min(existing.firstPosition, c.firstPos)
      existing.yake = Math.max(existing.yake, yake)
      existing.textrank = Math.max(existing.textrank, tr)
      existing.sentSet.add(c.sentIndex)
    }
  }
  let items = Array.from(merged.values())

  // Cheap pruning
  const limit = Math.max(1, Math.min(maxCandidates, items.length))
  items.sort((a, b) => Math.max(b.yake, b.textrank) - Math.max(a.yake, a.textrank))
  items = items.slice(0, limit)

  // Fusion (compute score now for selection)
  let fused = items.map((c) => {
    let score = 0
    if (fusion === 'avg') score = weights.yake * c.yake + weights.textrank * c.textrank
    else {
      // RRF over two ranks
      const rankY = 1 + items.slice().sort((x, y) => y.yake - x.yake).findIndex((x) => x === c)
      const rankT = 1 + items.slice().sort((x, y) => y.textrank - x.textrank).findIndex((x) => x === c)
      score = 1 / (60 + rankY) + 1 / (60 + rankT)
    }
    return { c, score }
  })

  // Strict cap: select at most 2 phrases per sentence (based on earliest sentence index)
  const perSentenceCap = 2
  const chosen: Array<{ c: Cand; score: number }> = []
  const takenPerSentence = new Map<number, number>()
  fused.sort((a, b) => b.score - a.score)
  for (const item of fused) {
    const minSent = Math.min(...Array.from(item.c.sentSet))
    const used = takenPerSentence.get(minSent) || 0
    if (used < perSentenceCap) {
      chosen.push(item)
      takenPerSentence.set(minSent, used + 1)
    }
  }

  // Map to Phrase objects for dedupe & output
  let phrases = chosen.map(({ c, score }) => ({
    text: c.text,
    score,
    scores: { yake: c.yake, textrank: c.textrank },
    firstPosition: c.firstPosition,
    occurrences: c.occurrences,
    tokens: c.tokens
  }))

  // Deduplicate by Jaccard over token sets
  const out: Phrase[] = []
  for (const p of phrases.sort((a, b) => b.score - a.score)) {
    const setP = new Set(p.tokens)
    const dup = out.some((q) => {
      const setQ = new Set(q.tokens)
      let inter = 0
      setP.forEach((t) => { if (setQ.has(t)) inter++ })
      const jac = inter / (setP.size + setQ.size - inter)
      return jac >= dedupeThreshold
    })
    if (!dup) out.push(p)
    if (out.length >= topK) break
  }
  return { phrases: out }
}



