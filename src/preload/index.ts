import { contextBridge } from 'electron'
import { searchBm25 } from './search/bm25'
import { rrfCombinePerKeyword, rrfCombinePerKeywordWeighted } from './search/combine'
import Database from 'better-sqlite3'
import { spawn } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { electronAPI } from '@electron-toolkit/preload'
import { spawn as spawnChild } from 'node:child_process'

// Custom APIs for renderer
const dbPath = path.resolve(process.cwd(), 'database/anki_cache.db')
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
} catch {
  // ignore mkdir race condition or permission issues during init
}

let db: Database.Database | null = null
function getDb(): Database.Database {
  if (!db) {
    db = new Database(dbPath)
  }
  return db
}

const api = {
  getSetting(key: string): string | null {
    try {
      const db = getDb()
      db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  },
  setSetting(key: string, value: string): void {
    try {
      const db = getDb()
      db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
      db.prepare('INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
    } catch {
      // ignore
    }
  },
  // Simple: remove filler words only
  extractQueryKeywords(query: string): string[] {
    const qnorm = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!qnorm) return []
    const STOP = new Set<string>([
      'the','a','an','and','or','but','if','then','else','of','to','in','on','for','by','with','as','at','from','into','about','over','after','before','between','out','against','during','without','within','along','across','behind','beyond','plus','minus','per','via','is','are','was','were','be','been','being','do','does','did','done','can','could','should','would','may','might','must','will','not','no','yes','this','that','these','those','it','its','his','her','their','our','your','my','we','you','they','he','she','i'
    ])
    const tokens = (qnorm.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [])
      .filter((t) => t.length >= 3 && !STOP.has(t))
    return Array.from(new Set(tokens))
  },
  listNotes(limit = 200, offset = 0): Array<{ note_id: number; first_field: string | null }> {
    const stmt = getDb().prepare(
      `SELECT n.note_id,
              (SELECT nf.value_html FROM note_fields nf WHERE nf.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
         FROM notes n
        ORDER BY n.note_id DESC
        LIMIT ? OFFSET ?`
    )
    return stmt.all(limit, offset)
  },

  countNotes(): number {
    const row = getDb().prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }
    return row?.c || 0
  },

  // Build or refresh FTS5 and trigram indexes used for fuzzy search
  _ensureSearchIndexes(): void {
    const db = getDb()
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(content, note_id UNINDEXED, tokenize='unicode61');
       CREATE TABLE IF NOT EXISTS note_trigrams (
         note_id INTEGER NOT NULL,
         trigram TEXT NOT NULL,
         PRIMARY KEY (note_id, trigram)
       );`
    )

    const noteCount = db.prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }
    const ftsCount = db.prepare('SELECT COUNT(1) AS c FROM note_fts').get() as { c: number }
    const trigCount = db.prepare('SELECT COUNT(1) AS c FROM note_trigrams').get() as { c: number }

    const shouldRebuildFts = ftsCount.c !== noteCount.c
    const shouldRebuildTrigrams = trigCount.c < noteCount.c // approximate

    if (shouldRebuildFts || shouldRebuildTrigrams) {
      // Build indices using ONLY the first (front) field text per note
      const rows = db
        .prepare(
          `SELECT n.note_id AS note_id,
                  (SELECT nf.value_html
                     FROM note_fields nf
                    WHERE nf.note_id = n.note_id
                    ORDER BY nf.ord ASC
                    LIMIT 1) AS content
             FROM notes n`
        )
        .all() as Array<{ note_id: number; content: string | null }>

      const strip = (html: string): string => {
        const noImgs = html.replace(/<img[^>]*>/gi, ' 🖼️ ')
        const brSp = noImgs.replace(/<br\s*\/?\s*>/gi, ' ')
        const noTags = brSp.replace(/<[^>]*>/g, ' ')
        const noAudio = noTags.replace(/\[sound:[^\]]+\]/gi, ' 🔊 ')
        return noAudio
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
      }

      const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

      if (shouldRebuildFts) {
        db.exec('DELETE FROM note_fts')
        const insFts = db.prepare('INSERT INTO note_fts(content, note_id) VALUES (?, ?)')
        const txn = db.transaction((items: Array<{ note_id: number; text: string }>) => {
          for (const it of items) insFts.run(it.text, it.note_id)
        })
        const items = rows.map((r) => ({ note_id: r.note_id, text: normalize(strip(r.content || '')) }))
        txn(items)
      }

      if (shouldRebuildTrigrams) {
        db.exec('DELETE FROM note_trigrams')
        const insTri = db.prepare('INSERT OR IGNORE INTO note_trigrams(note_id, trigram) VALUES (?, ?)')
        const txn2 = db.transaction((items: Array<{ note_id: number; text: string }>) => {
          for (const it of items) {
            const seen = new Set<string>()
            const t = it.text
            for (let i = 0; i < t.length - 2; i++) {
              const tri = t.slice(i, i + 3)
              if (tri.includes('\n')) continue
              if (!/\s{3,}/.test(tri)) {
                if (!seen.has(tri)) {
                  seen.add(tri)
                  insTri.run(it.note_id, tri)
                }
              }
            }
          }
        })
        const items = rows.map((r) => ({ note_id: r.note_id, text: normalize(strip(r.content || '')) }))
        txn2(items)
      }
    }
  },

  fuzzySearch(
    query: string,
    limit = 50,
    exclude: string[] = []
  ): Array<{ note_id: number; first_field: string | null; bm25?: number; trigrams?: number; combined: number; rrf: number; where?: 'front' | 'back' | 'both' }> {
    const db = getDb()
    api._ensureSearchIndexes()
    const qnorm = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!qnorm) {
      const rows = api.listNotes(limit, 0)
      return rows.map((r) => ({ ...r, combined: 0, rrf: 0 }))
    }

    // Simple keywords: stopword removal on the query
    let terms = api.extractQueryKeywords(qnorm)
    if (exclude.length) {
      const ex = new Set(exclude.map((s) => s.toLowerCase()))
      terms = terms.filter((t) => !ex.has(t))
    }
    if (terms.length === 0) terms = qnorm.split(/\s+/)

    const perTermMatch = terms.map((t) => `"${t}"`)
    const fetchBm25 = Math.min(5000, Math.max(limit * 2, 1000))
    const bm25Lists = perTermMatch.map((m) => searchBm25(db, m, fetchBm25))
    const widened = bm25Lists.every((l) => l.length === 0)
    const bm25Wide = widened ? [searchBm25(db, terms.map((t) => `"${t}"`).join(' OR '), fetchBm25)] : []

    // Compute per-keyword weights from selection cues: IDF, hyphenation, and length
    let weights: number[] = []
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts_vocab USING fts5vocab(note_fts, 'row')`)
      const uniq = Array.from(new Set(terms))
      const placeholders = uniq.map(() => '?').join(',')
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM note_fts`).get() as { c: number }).c || 1
      const rows = uniq.length
        ? (db
            .prepare(`SELECT term, doc AS df FROM note_fts_vocab WHERE term IN (${placeholders})`)
            .all(...uniq) as Array<{ term: string; df: number }>)
        : []
      const idfBy = new Map<string, number>()
      for (const t of uniq) {
        const r = rows.find((x) => x.term === t)
        const df = r?.df ?? 0
        const idf = Math.log((total - df + 0.5) / (df + 0.5))
        idfBy.set(t, Math.max(0, idf))
      }
      const nounSuffix = /(?:tion|sion|ment|ness|ity|ism|ology|logy|itis|emia|osis|oma|ectomy|plasty|scopy|gram|graphy|phobia|philia|gen|genic|ase|ose|algia|derm|cyte|blast|coccus|cocci|bacter|virus|enzyme|receptor|syndrome|disease|anemia|ecchymosis|contusion|hematoma|neuron|artery|vein|nerve|muscle|bone|cortex|nucleus|organ|tissue|cell|protein)$/
      function isLikelyNoun(token: string): boolean {
        if (token.includes('-')) return true
        if (nounSuffix.test(token)) return true
        if (token.length >= 5 && !/(?:ing|ed)$/.test(token)) return true
        return false
      }
      weights = terms.map((t) => {
        const base = 1
        const idf = Math.min(3, idfBy.get(t) ?? 0)
        const hyphen = t.includes('-') ? 0.75 : 0
        const long = t.length >= 8 ? 0.25 : 0
        const nounBoost = isLikelyNoun(t) ? 3.5 : 0
        return base + idf + hyphen + long + nounBoost
      })
    } catch {
      const nounSuffix = /(?:tion|sion|ment|ness|ity|ism|ology|logy|itis|emia|osis|oma|ectomy|plasty|scopy|gram|graphy|phobia|philia|gen|genic|ase|ose|algia|derm|cyte|blast|coccus|cocci|bacter|virus|enzyme|receptor|syndrome|disease|anemia|ecchymosis|contusion|hematoma|neuron|artery|vein|nerve|muscle|bone|cortex|nucleus|organ|tissue|cell|protein)$/
      function isLikelyNoun(token: string): boolean {
        if (token.includes('-')) return true
        if (nounSuffix.test(token)) return true
        if (token.length >= 5 && !/(?:ing|ed)$/.test(token)) return true
        return false
      }
      weights = terms.map((t) => 1 + (t.includes('-') ? 0.75 : 0) + (t.length >= 8 ? 0.25 : 0) + (isLikelyNoun(t) ? 3.5 : 0))
    }

    let combined = rrfCombinePerKeywordWeighted(
      bm25Lists.length ? bm25Lists : bm25Wide,
      bm25Lists.length ? weights : [1]
    )

    const ranked = combined

    const frontStmt = db.prepare(
      'SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1'
    )
    const backStmt = db.prepare(
      'SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord DESC LIMIT 1'
    )
    return ranked.map((r) => {
      const front = frontStmt.get(r.note_id) as { value_html?: string } | undefined
      const back = backStmt.get(r.note_id) as { value_html?: string } | undefined
      let where: 'front' | 'back' | 'both' | undefined
      const f = (front?.value_html || '').toLowerCase()
      const b = (back?.value_html || '').toLowerCase()
      const hitFront = terms.some((t) => f.includes(t))
      const hitBack = terms.some((t) => b.includes(t))
      if (hitFront && hitBack) where = 'both'
      else if (hitFront) where = 'front'
      else if (hitBack) where = 'back'
      return {
        note_id: r.note_id,
        first_field: front?.value_html ?? null,
        bm25: r.bm25,
        trigrams: undefined,
        combined: r.rrf,
        rrf: r.rrf,
        where
      }
    })
  },

  async semanticRerank(query: string, limit = 100): Promise<Array<{ note_id: number; first_field: string | null; bm25?: number; trigrams?: number; combined: number; rrf: number; where?: 'front' | 'back' | 'both'; rerank?: number }>> {
    const q = String(query || '').trim()
    if (!q) return []
    // First, get fuzzy candidates; if none, fall back to recent notes
    let candidates = api.fuzzySearch(q, Math.max(limit, 400))
    if (candidates.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('semanticRerank: no fuzzy candidates; falling back to default note list')
      candidates = api.listNotes(limit, 0)
    }
    // Prepare documents: use stripped front text; drop empties and cap batch size
    const cleaned: Array<{ idx: number; text: string }> = []
    for (let i = 0; i < candidates.length; i++) {
      const html = candidates[i].first_field || ''
      const text = html
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[sound:[^\]]+\]/gi, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      if (text.length > 0) cleaned.push({ idx: i, text })
    }
    // Cap request size to keep payload small
    const MAX_DOCS = 128
    const sliced = cleaned.slice(0, MAX_DOCS)
    const documents = sliced.map((c) => c.text)
    const queries = documents.map(() => q)
    const defaultInstruction = 'Given a search query, retrieve relevant anki cards.'
    const instruction = api.getSetting('deepinfra_instruction') || defaultInstruction
    const body = { queries, documents, instruction }
    const apiKey = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN || ''
    const url = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-8B'
    try {
      if (!apiKey) {
        // eslint-disable-next-line no-console
        console.warn('DeepInfra API key not set; skipping semantic rerank')
        return candidates
      }
      // eslint-disable-next-line no-console
      console.log('semanticRerank: calling DeepInfra with', documents.length, 'docs')
      const res = await fetch(url, {
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json'
          },
          apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
        ),
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error('Rerank API error', res.status, await res.text())
        return candidates
      }
      const json = (await res.json()) as { scores: number[] }
      const scores = Array.isArray(json?.scores) ? json.scores : []
      // Hard cap rerank to top 200; keep tail in BM25/combined order
      const MAX_RERANK = 200
      const headCount = Math.min(MAX_RERANK, candidates.length)
      const headIndices = Array.from({ length: headCount }, (_, i) => i)
      const headScored = headIndices.map((i) => ({ ...candidates[i], rerank: -Infinity }))
      const used = Math.min(scores.length, headScored.length)
      for (let i = 0; i < used; i++) {
        headScored[i].rerank = Number.isFinite(scores[i]) ? (scores[i] as number) : -Infinity
      }
      const headSorted = headScored.sort((a, b) => (b.rerank ?? -Infinity) - (a.rerank ?? -Infinity))
      const tail = candidates.slice(headCount)
      const tailSorted = tail.slice().sort((a, b) => {
        const ab = typeof a.bm25 === 'number' ? a.bm25 : Number.POSITIVE_INFINITY
        const bb = typeof b.bm25 === 'number' ? b.bm25 : Number.POSITIVE_INFINITY
        if (ab === bb) return 0
        return ab < bb ? -1 : 1
      })
      return headSorted.concat(tailSorted)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Rerank fetch failed', e)
      return candidates
    }
  },

  getNoteDetails(noteId: number): {
    note: { note_id: number; model_name: string; mod: number | null }
    fields: Array<{ field_name: string; value_html: string; ord: number | null }>
    tags: string[]
  } | null {
    const note = getDb()
      .prepare('SELECT note_id, model_name, mod FROM notes WHERE note_id = ?')
      .get(noteId)
    if (!note) return null
    const fields = getDb()
      .prepare(
        'SELECT field_name, value_html, ord FROM note_fields WHERE note_id = ? ORDER BY ord ASC, field_name ASC'
      )
      .all(noteId)
    const tags = getDb()
      .prepare('SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag ASC')
      .all(noteId)
      .map((r: { tag: string }) => r.tag)
    return { note, fields, tags }
  },

  searchNotes(
    query: string,
    limit = 200,
    offset = 0
  ): Array<{ note_id: number; first_field: string | null }> {
    const raw = String(query || '').trim()
    if (raw.length === 0) {
      return api.listNotes(limit, offset)
    }

    // Tokenize into space-separated terms, honoring quoted phrases
    const tokens: string[] = []
    const re = /"([^"]+)"|(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      const phrase = (m[1] || m[2] || '').toLowerCase()
      if (phrase) tokens.push(phrase)
    }

    if (tokens.length === 0) {
      return api.listNotes(limit, offset)
    }

    // Build WHERE as AND of EXISTS clauses (boolean AND exact substring match case-insensitive)
    const where = tokens
      .map(
        () =>
          `EXISTS (
             SELECT 1 FROM note_fields nf
              WHERE nf.note_id = n.note_id
                AND instr(lower(nf.value_html), ?) > 0
           )`
      )
      .join(' AND ')

    const sql = `
      SELECT n.note_id,
             (SELECT nf2.value_html FROM note_fields nf2 WHERE nf2.note_id = n.note_id ORDER BY ord ASC LIMIT 1) AS first_field
        FROM notes n
       WHERE ${where}
       ORDER BY n.note_id DESC
       LIMIT ? OFFSET ?`

    const stmt = getDb().prepare(sql)
    const params = [...tokens, limit, offset]
    return stmt.all(...params)
  },

  runIngest(query: string = '*'): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.resolve(process.cwd(), 'database/anki_ingest.mjs')
      const child = spawn(process.execPath, [scriptPath, query], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })

      let output = ''
      child.stdout.on('data', (d) => {
        output += d.toString()
      })
      child.stderr.on('data', (d) => {
        output += d.toString()
      })
      child.on('error', (err) => reject(err))
      child.on('close', (code) => resolve({ code: code ?? -1, output }))
    })
  },
  async pingAnkiConnect(): Promise<{ ok: boolean; version?: number; error?: string }> {
    try {
      const res = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'version', version: 6 })
      })
      const json = (await res.json()) as { result?: number; error?: string }
      if (json?.result && !json.error) return { ok: true, version: json.result }
      return { ok: false, error: json?.error || 'Unknown response' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
  ,
  startEmbedding(rebuild?: boolean): Promise<{ pid: number }> {
    return new Promise((resolve, reject) => {
      try {
        const scriptPath = path.resolve(process.cwd(), 'database/embed_index.mjs')
        const key = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
        const dims = api.getSetting('deepinfra_embed_dims') || '8192'
        const model = api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
        const service = api.getSetting('deepinfra_embed_tier') || 'default'
        const child = spawnChild(process.execPath, [scriptPath], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            DEEPINFRA_API_KEY: key,
            EMBED_MODEL: model,
            EMBED_DIMS: String(dims),
            EMBED_SERVICE_TIER: service,
            CONCURRENCY: '200',
            BATCH_SIZE: '8',
            REBUILD_ALL: rebuild ? '1' : '0'
          }
        })
        child.stdout?.on('data', (d) => {
          // Could forward to renderer via events in future
          // eslint-disable-next-line no-console
          console.log(String(d))
        })
        child.stderr?.on('data', (d) => {
          // eslint-disable-next-line no-console
          console.error(String(d))
        })
        ;(globalThis as any).__embedChild = child
        resolve({ pid: child.pid ?? -1 })
      } catch (e) {
        reject(e)
      }
    })
  },
  stopEmbedding(): Promise<{ ok: boolean }> {
    return new Promise((resolve) => {
      try {
        const child = (globalThis as any).__embedChild
        if (child && typeof child.kill === 'function') child.kill('SIGINT')
      } catch {
        // ignore
      } finally {
        resolve({ ok: true })
      }
    })
  },
  getEmbeddingProgress(): {
    total: number
    embedded: number
    pending: number
    errors: number
    rate: number
    etaSeconds: number
  } {
    const embPath = path.resolve(process.cwd(), 'database/embeddings.db')
    const dbEmb = new Database(embPath)
    const total = (getDb().prepare('SELECT COUNT(1) AS c FROM notes').get() as { c: number }).c || 0
    const embedded = (dbEmb.prepare('SELECT COUNT(1) AS c FROM embeddings').get() as { c: number }).c || 0
    const pending = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs WHERE status='pending'").get() as { c: number }).c || 0
    const errors = (dbEmb.prepare("SELECT COUNT(1) AS c FROM embed_jobs WHERE status='error'").get() as { c: number }).c || 0
    let rate = 0
    try {
      const row = dbEmb.prepare("SELECT value FROM settings WHERE key='embed_progress'").get() as { value?: string }
      if (row?.value) {
        const obj = JSON.parse(row.value)
        rate = Number(obj?.rate || 0)
      }
    } catch {
      // ignore
    }
    const remaining = Math.max(0, total - embedded)
    const etaSeconds = rate > 0 ? Math.round(remaining / rate) : 0
    return { total, embedded, pending, errors, rate, etaSeconds }
  },
  async embedSearch(query: string, topK = 200): Promise<Array<{ note_id: number; first_field: string | null; rerank: number }>> {
    const key = api.getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
    if (!key) return []
    const qtext = String(query || '').trim()
    if (!qtext) return []
    // Get query embedding
    const model = api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
    const dims = Number(api.getSetting('deepinfra_embed_dims') || '8192')
    const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, input: qtext, encoding_format: 'float', dimensions: dims })
    })
    if (!res.ok) return []
    const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    const emb = j?.data?.[0]?.embedding
    if (!Array.isArray(emb)) return []

    const embF32 = new Float32Array(emb)
    let qnorm = 0
    for (let i = 0; i < embF32.length; i++) qnorm += embF32[i] * embF32[i]
    qnorm = Math.sqrt(qnorm) || 1

    const embPath = path.resolve(process.cwd(), 'database/embeddings.db')
    const dbEmb = new Database(embPath)
    const rows = dbEmb.prepare('SELECT note_id, dim, vec, norm FROM embeddings').all() as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
    const scores: Array<{ id: number; s: number }> = []
    for (const r of rows) {
      if (!r.vec || r.dim !== embF32.length) continue
      const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
      let dot = 0
      for (let i = 0; i < embF32.length; i++) dot += embF32[i] * vec[i]
      const cos = dot / (qnorm * (r.norm || 1))
      scores.push({ id: r.note_id, s: cos })
    }
    scores.sort((a, b) => b.s - a.s)
    const top = scores.slice(0, Math.max(1, topK))
    const firstFieldStmt = getDb().prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
    return top.map((x) => {
      const row = firstFieldStmt.get(x.id) as { value_html?: string } | undefined
      return { note_id: x.id, first_field: row?.value_html ?? null, rerank: x.s }
    })
  }
  ,
  async unsuspendNotes(noteIds: number[]): Promise<{ ok: boolean; changed: number; error?: string }> {
    try {
      if (!Array.isArray(noteIds) || noteIds.length === 0) return { ok: true, changed: 0 }
      // Use findCards with query: "nid:<id> or nid:<id> ..."
      const q = noteIds.map((id) => `nid:${id}`).join(' or ')
      const resFind = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'findCards', version: 6, params: { query: q } })
      })
      const jsonFind = (await resFind.json()) as { result?: number[]; error?: string }
      if (!jsonFind || jsonFind.error) return { ok: false, changed: 0, error: jsonFind?.error || 'findCards failed' }
      const cardIds = jsonFind.result || []
      if (cardIds.length === 0) return { ok: true, changed: 0 }

      // Determine how many are currently suspended (optional accuracy for "changed")
      const resBefore = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'areSuspended', version: 6, params: { cards: cardIds } })
      })
      const jsonBefore = (await resBefore.json()) as { result?: boolean[]; error?: string }
      if (jsonBefore?.error) return { ok: false, changed: 0, error: jsonBefore.error }
      const before = Array.isArray(jsonBefore?.result) ? jsonBefore.result : []

      // Use canonical unsuspend action per AnkiConnect docs
      const resUnsuspend = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unsuspend', version: 6, params: { cards: cardIds } })
      })
      const jsonUnsuspend = (await resUnsuspend.json()) as { result?: boolean; error?: string }
      if (jsonUnsuspend?.error) return { ok: false, changed: 0, error: jsonUnsuspend.error }

      // Verify post-state to count changes
      const resAfter = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'areSuspended', version: 6, params: { cards: cardIds } })
      })
      const jsonAfter = (await resAfter.json()) as { result?: boolean[]; error?: string }
      if (jsonAfter?.error) return { ok: false, changed: 0, error: jsonAfter.error }
      const after = Array.isArray(jsonAfter?.result) ? jsonAfter.result : []

      let changed = 0
      for (let i = 0; i < Math.min(before.length, after.length); i++) {
        if (before[i] === true && after[i] === false) changed++
      }
      return { ok: true, changed }
    } catch (e) {
      return { ok: false, changed: 0, error: (e as Error).message }
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
