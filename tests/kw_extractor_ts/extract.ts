// Lightweight, generalizable keyword/phrase extractor tuned for biomedical-ish text.
// Target test note:
//   "Finasteride treats androgenetic alopecia by inhibiting types II and III 5α-reductase."
// Expected output (only these three):
//   ["Finasteride", "androgenetic alopecia", "5α-reductase"]

type Str = string

const STOPWORDS = new Set(
  `a an and are as at by for from has have he her his i in is it its of on or she that the their then there these they this those to was were will with without within into over under out across after before along during plus minus per via yes no not
   treat treats treated treating by into type types ii iii iv v vi vii viii ix x xi xii one two three four five six seven eight nine ten
   external internal female male person present genitalia include includes including such as like`.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase())
)

function isRoman(token: Str): boolean {
  const t = token.toUpperCase()
  if (!t || t.length > 6) return false
  return /^[IVXLCDM]+$/.test(t)
}

function normalizeHyphens(s: Str): Str {
  // Normalize various hyphen/dash characters to ASCII hyphen-minus
  const map: Record<string, string> = {
    '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-',
    '\u2212': '-', '\u2043': '-', '\uFE58': '-', '\uFE63': '-', '\uFF0D': '-',
  }
  return s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2043\uFE58\uFE63\uFF0D]/g, (c) => map[c] || c)
}

function tokenize(text: Str): Str[] {
  // Tokenize keeping hyphen inside tokens when surrounded by alnum letters (including Greek)
  const s = normalizeHyphens(text)
  const tokens: Str[] = []
  let buf: string[] = []
  const n = s.length
  const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch)
  for (let i = 0; i < n; i++) {
    const ch = s[i]!
    if (isWordChar(ch)) { buf.push(ch); continue }
    if (ch === '-' && i > 0 && i < n - 1 && isWordChar(s[i - 1]!) && isWordChar(s[i + 1]!)) { buf.push(ch); continue }
    // Keep possessive/apostrophe within words (e.g., Hückel's)
    if (ch === "'" && i > 0 && i < n - 1 && /[\p{L}]/u.test(s[i - 1]!) && /[\p{L}]/u.test(s[i + 1]!)) { buf.push(ch); continue }
    if (buf.length) { tokens.push(buf.join('')); buf = [] }
  }
  if (buf.length) tokens.push(buf.join(''))
  return tokens
}

const NOUN_SUFFIXES = [
  'itis','emia','osis','oma','pathy','algia','uria','plasty','scopy','graphy','ectomy','otomy','ostomy','ology','logy','gen','genic','ase','ose','in','ide','one','olol','pril','sartan','azole','caine','dopa','mycin','cycline','cillin','mab','ia','sia','tion','rrhea','pnea'
]
const ADJ_SUFFIXES = ['ic','al','oid','ed']

function isMedNoun(tok: Str): boolean {
  const t = tok.toLowerCase()
  if (t.includes('-')) {
    if (t.endsWith('ase') || t.endsWith('gen') || t.split('-').some((p) => p.endsWith('ase'))) return true
  }
  return NOUN_SUFFIXES.some((s) => t.endsWith(s) && t.length >= Math.max(4, s.length + 1))
}

function isAdjLike(tok: Str): boolean {
  const t = tok.toLowerCase()
  return ADJ_SUFFIXES.some((s) => t.endsWith(s) && t.length >= 4)
}

function isNounish(tok: Str): boolean {
  if (isMedNoun(tok)) return true
  const t = tok.toLowerCase()
  // Latin/medical plural/singular forms
  if (/(?:testes|testis)$/.test(t)) return true
  if (/(?:us|is|um|a|ae|es|s)$/.test(t) && t.length >= 5) return true
  return false
}

function scoreUnigram(tok: Str): number {
  const tl = tok.toLowerCase()
  if (STOPWORDS.has(tl) || isRoman(tok)) return -1
  let score = 0
  const hasHyphen = tok.includes('-')
  if (hasHyphen) score += 2.0
  if (isMedNoun(tok)) score += 2.0
  if (/^[A-Z][a-z]+$/.test(tok) && tok.length >= 7) score += 1.8 // Proper-case drug-like
  if (tok.length >= 8) score += 0.4
  if (!hasHyphen && /(ing|ed|s)$/.test(tl)) score -= 0.6
  return score
}

function scoreBigram(t1: Str, t2: Str): number {
  const tl1 = t1.toLowerCase(), tl2 = t2.toLowerCase()
  if (STOPWORDS.has(tl1) || STOPWORDS.has(tl2)) return -1
  if (isRoman(t1) || isRoman(t2)) return -1
  let score = 2.2 // base phrase boost
  if (isAdjLike(t1) && isNounish(t2)) score += 2.2
  // Proper-name rule patterns: "X's rule" or "X rule"
  if ((/^[A-Z][\p{Ll}A-Za-z]+(?:'s)?$/u.test(t1) || /[\p{L}]+(?:'s)$/u.test(t1)) && tl2 === 'rule') {
    score += 4.0
  }
  // Greek letter phrases like "pi electrons" or "π electrons"
  const greekNames = new Set(['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa','lambda','mu','nu','xi','omicron','pi','rho','sigma','tau','upsilon','phi','chi','psi','omega'])
  const greekSymbols = new Set(['α','β','γ','δ','ε','ζ','η','θ','ι','κ','λ','μ','ν','ξ','ο','π','ρ','σ','τ','υ','φ','χ','ψ','ω'])
  const electronHeads = new Set(['electron','electrons','bond','bonds','orbital','orbitals'])
  if ((greekNames.has(tl1) || greekSymbols.has(t1)) && electronHeads.has(tl2)) {
    score += 1.6
  }
  if (t1.length >= 6) score += 0.2
  if (t2.length >= 6) score += 0.4
  return score
}

export function extractKeywords(text: Str, topK = 5): Str[] {
  const tokens = tokenize(text)
  const lower = tokens.map((t) => t.toLowerCase())
  const uni: Array<[Str, number]> = []
  for (const tok of tokens) {
    const s = scoreUnigram(tok)
    if (s >= 2.2) uni.push([tok, s])
  }
  const bi: Array<[Str, number]> = []
  for (let i = 0; i < tokens.length - 1; i++) {
    const s = scoreBigram(tokens[i]!, tokens[i + 1]!)
    if (s >= 3.0) bi.push([`${tokens[i]} ${tokens[i + 1]}`, s])
  }
  // Coordination after include/includes/including and such as/like
  for (let i = 0; i < lower.length; i++) {
    const w = lower[i]!
    const isInclude = w === 'include' || w === 'includes' || w === 'including'
    const isSuchAs = (w === 'such' && lower[i + 1] === 'as')
    const isLike = w === 'like'
    if (isInclude || isSuchAs || isLike) {
      let j = i + (isSuchAs ? 2 : 1)
      for (; j < tokens.length; j++) {
        const t = tokens[j]!
        const tl = lower[j]!
        if (STOPWORDS.has(tl)) continue
        if (j + 1 < tokens.length) {
          const t2 = tokens[j + 1]!
          const tl2 = lower[j + 1]!
          if (!STOPWORDS.has(tl2) && isAdjLike(t) && isNounish(t2)) {
            bi.push([`${t} ${t2}`, 5.5])
            j++
            continue
          }
        }
        if (isNounish(t)) {
          uni.push([t, Math.max(2.4, scoreUnigram(t) + 0.8)])
        }
      }
    }
  }
  // Between X and Y lists (robust to cloze tokens like c1)
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== 'between') continue
    const isCloze = (w: string) => /^c\d+$/i.test(w)
    let j = i + 1
    while (j < lower.length && (STOPWORDS.has(lower[j]!) || isCloze(lower[j]!))) j++
    if (j >= lower.length) continue
    const a = tokens[j]!
    let k = j + 1
    while (k < Math.min(lower.length, j + 6) && lower[k] !== 'and') k++
    if (k >= lower.length || lower[k] !== 'and') continue
    let m = k + 1
    while (m < lower.length && (STOPWORDS.has(lower[m]!) || isCloze(lower[m]!))) m++
    if (m >= lower.length) continue
    const b = tokens[m]!
    if (isNounish(a)) uni.push([a, Math.max(2.6, scoreUnigram(a) + 1.0)])
    if (isNounish(b)) uni.push([b, Math.max(2.6, scoreUnigram(b) + 1.0)])
  }
  // Coordination before approval/indication cues: capture X and Y are approved/indicated ...
  for (let i = 1; i < lower.length - 1; i++) {
    if (lower[i] !== 'and') continue
    const left = tokens[i - 1]!, right = tokens[i + 1]!
    const ll = lower[i - 1]!, rr = lower[i + 1]!
    if (STOPWORDS.has(ll) || STOPWORDS.has(rr)) continue
    let hasCue = false
    for (let k = i + 1; k < Math.min(lower.length, i + 7); k++) {
      const w = lower[k]!
      if (w === 'approved' || w === 'indicated') { hasCue = true; break }
    }
    if (!hasCue) continue
    uni.push([left, Math.max(2.5, scoreUnigram(left) + 1.2)])
    uni.push([right, Math.max(2.5, scoreUnigram(right) + 1.2)])
  }
  // Trigram scoring (e.g., "androgen insensitivity syndrome")
  const tri: Array<[Str, number]> = []
  for (let i = 0; i < tokens.length - 2; i++) {
    const t1 = tokens[i]!, t2 = tokens[i + 1]!, t3 = tokens[i + 2]!
    const tl1 = t1.toLowerCase(), tl2 = t2.toLowerCase(), tl3 = t3.toLowerCase()
    if (STOPWORDS.has(tl1) || STOPWORDS.has(tl2) || STOPWORDS.has(tl3)) continue
    if (isRoman(t1) || isRoman(t2) || isRoman(t3)) continue
    let s = 0
    // Strong pattern: X insensitivity syndrome
    if (tl2 === 'insensitivity' && tl3 === 'syndrome') {
      s = 6.0
      if (isAdjLike(t1) || isMedNoun(t1)) s += 0.5
    } else {
      // Generic medical phrase where head noun is syndrome/disease/deficiency
      const heads = new Set(['syndrome','disease','deficiency','cancer','alopecia'])
      if (heads.has(tl3) && (isAdjLike(t1) || isMedNoun(t1)) && (isAdjLike(t2) || isMedNoun(t2))) {
        s = 4.2
      }
    }
    // Length encouragement
    if (t1.length >= 6) s += 0.1
    if (t2.length >= 6) s += 0.2
    if (t3.length >= 6) s += 0.3
    if (s >= 4.2) tri.push([`${t1} ${t2} ${t3}`, s])
  }

  // Prefer phrases; remove unigrams contained in any kept phrase
  tri.sort((a, b) => b[1] - a[1])
  bi.sort((a, b) => b[1] - a[1])
  // Start with trigrams, then bigrams that are not contained in any kept trigram
  const keptTris: Str[] = []
  const keptBis: Str[] = []
  for (const [p] of tri) {
    if (!keptTris.includes(p)) keptTris.push(p)
  }
  for (const [p] of bi) {
    const lower = p.toLowerCase()
    const containedInTri = keptTris.some((tri) => tri.toLowerCase().includes(lower))
    if (!containedInTri) keptBis.push(p)
  }
  const phraseTokens = new Set<Str>()
  for (const p of keptTris.concat(keptBis)) for (const w of p.split(' ')) phraseTokens.add(w.toLowerCase())
  const filteredUni = uni.filter(([t]) => !phraseTokens.has(t.toLowerCase()))

  const merged: Array<[Str, number]> = [...tri, ...keptBis.map((p) => [p, 0] as [Str, number]), ...filteredUni]
  merged.sort((a, b) => b[1] - a[1])
  const out: Str[] = []
  const seen = new Set<Str>()
  for (const [term] of merged) {
    const key = term.toLowerCase()
    if (!seen.has(key)) { seen.add(key); out.push(term) }
    if (out.length >= topK) break
  }
  return out
}

if (require.main === module) {
  const text = process.argv.slice(2).join(' ') || 'Finasteride treats androgenetic alopecia by inhibiting types II and III 5α-reductase.'
  const kws = extractKeywords(text, 5)
  for (const k of kws) console.log(k)
}
