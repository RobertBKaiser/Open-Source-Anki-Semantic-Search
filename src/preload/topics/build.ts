import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

import { getDb } from '../db/core'
import { getSetting, setSetting } from '../db/settings'
import { getEmbDb } from '../embeddings/core'
import { stripHtmlToText } from '../utils/text'
import {
  ConceptScope,
  scopeHash as makeScopeHash,
  scopeLabel,
  persistConceptMap,
  TopicDocRecord,
  TopicRecord,
  TopicTermRecord,
} from './db'
import { emitConceptMapProgress, resetConceptMapProgress } from './progress'

interface NoteEmbedding {
  vec: Float32Array
  norm: number
}

export interface BuildConceptMapOptions {
  scope: ConceptScope
  noteIds?: number[]
  query?: string
  queryEmbedding?: Float32Array | null
  backend?: 'deepinfra' | 'gemma' | 'google'
  model?: string
  params?: Record<string, unknown>
  pythonPath?: string
  topTermsPerTopic?: number
  maxNotes?: number
}

interface PythonTopic {
  topic_id: number
  parent_id: number | null
  level: number
  label: string
  size: number
  score?: number | null
  terms?: Array<{ term: string; score: number; rank: number }>
  docs?: Array<{ id: number; weight?: number | null }>
}

interface PythonOutput {
  topics: PythonTopic[]
  meta?: Record<string, unknown>
  error?: string
}

const DEFAULT_MAX_NOTES = 400

export async function buildConceptMap(options: BuildConceptMapOptions): Promise<{ runId: string; noteCount: number }> {
  const backendPref = options.backend || (getSetting('embedding_backend') as ('deepinfra' | 'gemma' | 'google') | undefined) || 'deepinfra'
  const model = options.model || resolveModelForBackend(backendPref)
  const maxNotes = typeof options.maxNotes === 'number' ? options.maxNotes : DEFAULT_MAX_NOTES
  let noteIds = normalizeNoteIds(options.noteIds)
  if (noteIds.length === 0) {
    noteIds = fetchAllNoteIds()
  }
  if (noteIds.length === 0) {
    throw new Error('No note IDs available for concept map build.')
  }
  if (maxNotes > 0) {
    noteIds = noteIds.slice(0, maxNotes)
  }

  resetConceptMapProgress({ stage: 'preparing', message: `Preparing ${noteIds.length} notes`, completed: 0, total: noteIds.length, percent: 0 })

  emitConceptMapProgress({ stage: 'loading_text', message: 'Collecting note fronts', completed: 0, total: noteIds.length })
  const frontTexts = fetchFrontTexts(noteIds)
  emitConceptMapProgress({ stage: 'loading_text', message: 'Note fronts collected', completed: noteIds.length, total: noteIds.length })

  emitConceptMapProgress({ stage: 'loading_embeddings', message: 'Loading embeddings from database', completed: 0, total: noteIds.length })
  const embeddings = fetchEmbeddings(noteIds, backendPref, model, (processed, total) => {
    emitConceptMapProgress({ stage: 'loading_embeddings', message: 'Loading embeddings from database', completed: processed, total })
  })
  emitConceptMapProgress({ stage: 'loading_embeddings', message: 'Embeddings loaded', completed: noteIds.length, total: noteIds.length })

  emitConceptMapProgress({ stage: 'assembling_documents', message: 'Preparing documents for clustering', completed: 0, total: noteIds.length })
  const docs: Array<{ id: number; text: string; embedding: NoteEmbedding }> = []
  for (let i = 0; i < noteIds.length; i++) {
    const id = noteIds[i]
    const text = frontTexts.get(id) || ''
    const emb = embeddings.get(id)
    if (!emb) continue
    const clean = stripHtmlToText(text)
    if (!clean) continue
    docs.push({ id, text: clean, embedding: emb })
    if ((i + 1) % 500 === 0 || i === noteIds.length - 1) {
      emitConceptMapProgress({ stage: 'assembling_documents', message: 'Preparing documents for clustering', completed: i + 1, total: noteIds.length })
    }
  }
  emitConceptMapProgress({ stage: 'assembling_documents', message: `Prepared ${docs.length} documents`, completed: noteIds.length, total: noteIds.length })

  if (docs.length === 0) {
    throw new Error('No usable documents (missing embeddings or empty text).')
  }

  const effectiveParams = composeParams(options, backendPref, model, docs.length)

  if (docs.length === 1) {
    return persistFallbackConceptMap(options, docs, backendPref, model, effectiveParams)
  }

  try {
    const pythonExecutable = resolvePythonPath(options.pythonPath)
    const pythonOut = await runPythonTopicModel(docs, effectiveParams, pythonExecutable, backendPref, model)
    if (pythonOut.error) {
      throw new Error(pythonOut.error)
    }
    if (!Array.isArray(pythonOut.topics) || pythonOut.topics.length === 0) {
      throw new Error('BERTopic returned no topics. Check that python dependencies (bertopic, umap-learn, hdbscan, scikit-learn, numpy, pandas) are installed.')
    }
    const hasLeaf = pythonOut.topics.some((t) => {
      if (t.topic_id === -1) return false
      const docsForTopic = Array.isArray(t.docs) ? t.docs : []
      return docsForTopic.some((d) => Number.isFinite(Number(d?.id)))
    })
    if (!hasLeaf) {
      throw new Error('Topic clustering yielded only outliers. Try reducing min_cluster_size or ensuring note fronts have meaningful text.')
    }
    const filtered = pythonOut.topics.filter((t) => t.topic_id !== -1)
    return persistWithTopics(options, docs, filtered, backendPref, model, effectiveParams)
  } catch (err) {
    console.error('[ConceptMap] Topic modeling failed', err)
    throw err
  }
}

function resolveModelForBackend(backend: 'deepinfra' | 'gemma' | 'google'): string {
  if (backend === 'gemma') {
    return (getSetting('gemma_model_id') as string | undefined) || 'onnx-community/embeddinggemma-300m-ONNX'
  }
  if (backend === 'google') {
    return (getSetting('google_embed_model') as string | undefined) || 'gemini-embedding-001'
  }
  return (getSetting('deepinfra_embed_model') as string | undefined) || 'Qwen/Qwen3-Embedding-8B'
}

function normalizeNoteIds(noteIds?: number[]): number[] {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return []
  const unique = new Set<number>()
  for (const id of noteIds) {
    const n = Number(id)
    if (Number.isFinite(n)) unique.add(n)
  }
  return Array.from(unique).sort((a, b) => a - b)
}

function fetchAllNoteIds(): number[] {
  try {
    const rows = getDb().prepare('SELECT note_id FROM notes ORDER BY note_id ASC').all() as Array<{ note_id: number }>
    return rows.map((r) => Number(r.note_id)).filter((n) => Number.isFinite(n))
  } catch (err) {
    console.error('[ConceptMap] failed to fetch all note IDs', err)
    return []
  }
}

function fetchFrontTexts(noteIds: number[]): Map<number, string> {
  const db = getDb()
  const stmt = db.prepare('SELECT value_html FROM note_fields WHERE note_id = ? ORDER BY ord ASC LIMIT 1')
  const map = new Map<number, string>()
  for (const id of noteIds) {
    try {
      const row = stmt.get(id) as { value_html?: string } | undefined
      map.set(id, row?.value_html ?? '')
    } catch (err) {
      console.warn('[ConceptMap] failed to fetch front text for note', id, err)
      map.set(id, '')
    }
  }
  return map
}

function fetchEmbeddings(
  noteIds: number[],
  backend: string,
  model: string,
  onProgress?: (processed: number, total: number) => void
): Map<number, NoteEmbedding> {
  const db = getEmbDb()
  const map = new Map<number, NoteEmbedding>()
  const chunkSize = 200
  let processed = 0
  const total = noteIds.length
  if (onProgress) onProgress(0, total)
  for (let i = 0; i < noteIds.length; i += chunkSize) {
    const slice = noteIds.slice(i, i + chunkSize)
    const placeholders = slice.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT note_id, dim, vec, norm FROM embeddings2 WHERE backend = ? AND model = ? AND note_id IN (${placeholders})`)
      .all(backend, model, ...slice) as Array<{ note_id: number; dim: number; vec: Buffer; norm: number }>
    for (const r of rows) {
      if (!r.vec || !r.dim) continue
      const buf = r.vec
      const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      const copy = new Float32Array(view.length)
      copy.set(view)
      map.set(r.note_id, { vec: copy, norm: Number(r.norm || 0) || magnitude(copy) })
    }
    processed += slice.length
    if (onProgress) onProgress(Math.min(processed, total), total)
  }
  return map
}

function magnitude(vec: Float32Array): number {
  let sum = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]
    sum += v * v
  }
  const norm = Math.sqrt(sum)
  return norm === 0 ? 1 : norm
}

async function runPythonTopicModel(
  docs: Array<{ id: number; text: string; embedding: NoteEmbedding }>,
  params: Record<string, unknown>,
  pythonPath: string,
  backend?: string,
  model?: string
): Promise<PythonOutput> {
  const script = path.resolve(process.cwd(), 'database/topicmap_bertopic.py')
  const embeddingSource = {
    db_path: path.resolve(process.cwd(), 'database/embeddings.db'),
    backend,
    model,
  }
  const payload = {
    documents: docs.map((d) => ({ id: d.id, text: d.text })),
    embedding_source: embeddingSource,
    params,
  }

  return new Promise<PythonOutput>((resolve, reject) => {
    try {
      const proc = spawn(pythonPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdoutBuffer = ''
      let rawStdout = ''
      let stderr = ''
      let resultPayload: PythonOutput | null = null

      const handleLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const obj = JSON.parse(trimmed)
          if (obj && typeof obj === 'object') {
            if (obj.topics) {
              resultPayload = obj as PythonOutput
            } else if (obj.type === 'embedding_progress') {
              const completed = Number(obj.completed) || 0
              const total = Number(obj.total) || docs.length
              emitConceptMapProgress({ stage: 'loading_embeddings', message: 'Loading embeddings in Python worker', completed, total })
            } else if (obj.type === 'stage') {
              emitConceptMapProgress({ stage: String(obj.stage || ''), message: obj.message })
            } else if (obj.type === 'progress') {
              emitConceptMapProgress({
                stage: obj.stage || 'progress',
                message: obj.message,
                completed: typeof obj.completed === 'number' ? obj.completed : undefined,
                total: typeof obj.total === 'number' ? obj.total : undefined,
                percent: typeof obj.percent === 'number' ? obj.percent : undefined,
              })
            }
          }
        } catch {
          // Ignore parse errors; final payload may not be newline-delimited
        }
      }

      proc.stdout.on('data', (chunk) => {
        const str = chunk.toString('utf8')
        rawStdout += str
        stdoutBuffer += str
        let idx = stdoutBuffer.indexOf('\n')
        while (idx >= 0) {
          const line = stdoutBuffer.slice(0, idx)
          stdoutBuffer = stdoutBuffer.slice(idx + 1)
          handleLine(line)
          idx = stdoutBuffer.indexOf('\n')
        }
      })

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })

      proc.on('error', (err) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code !== 0) {
          const msg = stderr || rawStdout || `python exited with code ${code}`
          reject(new Error(msg))
          return
        }

        const remaining = stdoutBuffer.trim()
        if (!resultPayload && remaining) {
          try {
            resultPayload = JSON.parse(remaining) as PythonOutput
          } catch (err) {
            reject(err)
            return
          }
        }

        if (!resultPayload) {
          try {
            resultPayload = JSON.parse(rawStdout || '{}') as PythonOutput
          } catch (err) {
            reject(err)
            return
          }
        }

        if (!resultPayload) {
          reject(new Error('Python worker did not return topic payload.'))
          return
        }

        if (resultPayload.error) {
          reject(new Error(resultPayload.error))
          return
        }

        resolve(resultPayload)
      })

      proc.stdin.write(JSON.stringify(payload))
      proc.stdin.end()
    } catch (err) {
      reject(err)
    }
  })
}

function composeParams(
  options: BuildConceptMapOptions,
  backend: string,
  model: string,
  docCount: number
): Record<string, unknown> {
  const clusterScale = (() => {
    if (docCount >= 40000) return 18
    if (docCount >= 20000) return 16
    if (docCount >= 10000) return 12
    if (docCount >= 5000) return 9
    if (docCount >= 1500) return 7
    return 5
  })()
  const baseParams = {
    top_n_terms: options.topTermsPerTopic ?? 12,
    backend,
    model,
    umap: {
      n_neighbors: Math.min(45, Math.max(8, Math.round(Math.sqrt(Math.min(docCount, 2500))) + 5)),
      n_components: 15,
      min_dist: docCount > 10000 ? 0.015 : 0.035,
      metric: 'cosine',
      random_state: 42,
    },
    hdbscan: {
      min_cluster_size: clusterScale,
      min_samples: Math.max(3, Math.floor(clusterScale / 3)),
      metric: 'euclidean',
      cluster_selection_method: 'eom',
      prediction_data: true,
    },
    vectorizer: {
      ngram_range: [1, 3],
      min_df: docCount > 20000 ? 10 : docCount > 10000 ? 5 : 1,
      max_features: docCount > 20000 ? 20000 : docCount > 10000 ? 15000 : 8000,
      stop_words: null,
    },
    min_topic_size: Math.max(4, Math.round(clusterScale * 0.8)),
  }

  const hasUserRepresentationOverride = Boolean(options.params && Object.prototype.hasOwnProperty.call(options.params, 'representation'))
  if (!hasUserRepresentationOverride) {
    const openaiKey = (getSetting('openai_api_key') as string | undefined)?.trim() || process.env.OPENAI_API_KEY || ''
    const llmDisableFlag = String(getSetting('concept_map_llm_refine') ?? '').trim().toLowerCase()
    const llmDisabled = ['0', 'false', 'no', 'off'].includes(llmDisableFlag)
    if (openaiKey && !llmDisabled) {
      const llmModelSetting = (getSetting('concept_map_llm_model') as string | undefined)?.trim()
      const llmModel = llmModelSetting && llmModelSetting.length > 0 ? llmModelSetting : 'gpt-5-nano'
      const representation: Record<string, unknown> = {
        type: 'openai',
        api_key: openaiKey,
        model: llmModel,
      }
      const promptOverride = (getSetting('concept_map_llm_prompt') as string | undefined)?.trim()
      if (promptOverride) representation.prompt = promptOverride
      const systemPromptOverride = (getSetting('concept_map_llm_system') as string | undefined)?.trim()
      if (systemPromptOverride) representation.system_prompt = systemPromptOverride
      baseParams.representation = representation
    }
  }

  return mergeParams(baseParams, options.params || {})
}

function resolvePythonPath(explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit
  const saved = getSetting('python_path')
  if (saved && saved.trim()) return saved.trim()
  const candidate = path.resolve(process.cwd(), 'database/.topicmap_venv/bin/python')
  if (fs.existsSync(candidate)) {
    try { setSetting('python_path', candidate) } catch {}
    return candidate
  }
  return 'python3'
}

function mergeParams(base: any, overrides: any): any {
  if (!overrides || typeof overrides !== 'object') return base
  const out: any = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(out, key) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeParams(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

async function persistWithTopics(
  options: BuildConceptMapOptions,
  docs: Array<{ id: number; text: string; embedding: NoteEmbedding }>,
  topics: PythonTopic[],
  backend: string,
  model: string,
  params: Record<string, unknown>
): Promise<{ runId: string; noteCount: number }> {
  const runId = randomUUID()
  const scopeHash = makeScopeHash(options.scope)
  const scope = scopeLabel(options.scope)
  const createdAt = Math.floor(Date.now() / 1000)
  const docEmbeddingMap = new Map<number, NoteEmbedding>(docs.map((d) => [d.id, d.embedding]))
  const docIdsSet = new Set(docs.map((d) => d.id))
  const topicRecords: TopicRecord[] = []
  const termRecords: TopicTermRecord[] = []
  const docRecords: TopicDocRecord[] = []

  const queryEmbedding = options.queryEmbedding || null
  let queryNorm = 1
  if (queryEmbedding) {
    queryNorm = magnitude(queryEmbedding)
  }

  for (const topic of topics) {
    const rawDocs = Array.isArray(topic.docs) ? topic.docs : []
    const members = rawDocs.map((d) => d.id).filter((id) => docIdsSet.has(id))
    const isGroupingNode = members.length === 0
    const centroid = !isGroupingNode ? computeCentroid(members, docEmbeddingMap) : null
    const centroidBuffer = centroid
      ? Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength)
      : null
    const centroidDim = centroid?.length ?? null
    const centroidNorm = centroid ? magnitude(centroid) : null
    let queryCos: number | null = null
    if (centroid && queryEmbedding && centroidNorm) {
      queryCos = cosine(queryEmbedding, centroid, queryNorm, centroidNorm)
    }
    const topicId = topic.topic_id
    topicRecords.push({
      runId,
      topicId,
      parentId: topic.parent_id ?? null,
      label: topic.label,
      level: topic.level ?? 0,
      size: topic.size ?? members.length,
      score: topic.score ?? null,
      queryCos,
      centroid: centroidBuffer,
      centroidDim,
    })
    const seenTerms = new Set<string>()
    for (const term of topic.terms || []) {
      const key = String(term.term || '').trim()
      if (!key) continue
      if (seenTerms.has(key.toLowerCase())) continue
      seenTerms.add(key.toLowerCase())
      termRecords.push({
        runId,
        topicId,
        term: key,
        score: term.score,
        rank: term.rank,
      })
    }
    if (!isGroupingNode) {
      for (const docId of members) {
        const emb = docEmbeddingMap.get(docId)
        if (!emb) continue
        const cos = centroid && centroidNorm ? cosine(emb.vec, centroid, emb.norm, centroidNorm) : null
        const weightEntry = rawDocs.find((d) => d.id === docId)
        docRecords.push({
          runId,
          topicId,
          noteId: docId,
          weight: weightEntry?.weight ?? null,
          cos,
        })
      }
    }
  }

  if (topicRecords.length === 0) {
    return persistFallbackConceptMap(options, docs, backend, model)
  }

  // Strict validation: do not silently fall back. If the Python hierarchy
  // produced no parent-child links, or referenced parents that are missing,
  // raise a descriptive error so the user knows the hierarchy pipeline failed.
  const presentIds = new Set<number>(topicRecords.map((t) => t.topicId))
  const referencedParents = new Set<number>()
  let hasAnyParent = false
  for (const t of topicRecords) {
    if (t.parentId != null) {
      hasAnyParent = true
      referencedParents.add(Number(t.parentId))
    }
  }
  const missingParents: number[] = []
  for (const pid of referencedParents) {
    if (!presentIds.has(pid)) missingParents.push(pid)
  }
  if (!hasAnyParent) {
    throw new Error(
      'Concept map hierarchy empty: BERTopic returned no parent-child relationships. Enable hierarchical topic reduction (HTR) or adjust parameters to generate coarse parents.'
    )
  }
  if (missingParents.length > 0) {
    const sample = missingParents.slice(0, 10).join(', ')
    throw new Error(
      `Concept map hierarchy incomplete: ${missingParents.length} referenced parent topic(s) were not emitted (e.g., ${sample}). The hierarchy parser likely failed; check Python logs and HTR settings.`
    )
  }

  const noteCount = docs.length
  persistConceptMap({
    run: {
      runId,
      scope,
      scopeHash,
      backend,
      model,
      noteCount,
      paramsJson: params ? JSON.stringify(params) : null,
      createdAt,
      query: options.query ?? null,
      queryEmbedding: queryEmbedding
        ? Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength)
        : null,
      queryDim: queryEmbedding?.length ?? null,
    },
    topics: topicRecords,
    terms: termRecords,
    docs: docRecords,
  })

  return { runId, noteCount }
}

function computeCentroid(ids: number[], embeddings: Map<number, NoteEmbedding>): Float32Array | null {
  const first = embeddings.get(ids[0])
  if (!first) return null
  const dim = first.vec.length
  const acc = new Float32Array(dim)
  let count = 0
  for (const id of ids) {
    const emb = embeddings.get(id)
    if (!emb || emb.vec.length !== dim) continue
    for (let i = 0; i < dim; i++) {
      acc[i] += emb.vec[i]
    }
    count++
  }
  if (count === 0) return null
  for (let i = 0; i < dim; i++) {
    acc[i] /= count
  }
  return acc
}

function cosine(a: Float32Array, b: Float32Array, normA?: number, normB?: number): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
  }
  const nA = normA ?? magnitude(a)
  const nB = normB ?? magnitude(b)
  return dot / (nA * nB || 1)
}

function persistFallbackConceptMap(
  options: BuildConceptMapOptions,
  docs: Array<{ id: number; text: string; embedding: NoteEmbedding }>,
  backend: string,
  model: string,
  params?: Record<string, unknown>
): { runId: string; noteCount: number } {
  const runId = randomUUID()
  const scopeHash = makeScopeHash(options.scope)
  const scope = scopeLabel(options.scope)
  const createdAt = Math.floor(Date.now() / 1000)
  const centroid = computeCentroid(
    docs.map((d) => d.id),
    new Map(docs.map((d) => [d.id, d.embedding]))
  )
  const centroidBuf = centroid
    ? Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength)
    : null
  const centroidDim = centroid?.length ?? null
  const topicId = 0

  emitConceptMapProgress({ stage: 'persisting', message: 'Persisting fallback topic', percent: 95 })
  persistConceptMap({
    run: {
      runId,
      scope,
      scopeHash,
      backend,
      model,
      noteCount: docs.length,
      paramsJson: params ? JSON.stringify(params) : options.params ? JSON.stringify(options.params) : null,
      createdAt,
      query: options.query ?? null,
      queryEmbedding: options.queryEmbedding
        ? Buffer.from(options.queryEmbedding.buffer, options.queryEmbedding.byteOffset, options.queryEmbedding.byteLength)
        : null,
      queryDim: options.queryEmbedding?.length ?? null,
    },
    topics: [
      {
        runId,
        topicId,
        parentId: null,
        label: 'All Notes',
        level: 0,
        size: docs.length,
        score: null,
        queryCos: null,
        centroid: centroidBuf,
        centroidDim,
      },
    ],
    terms: [],
    docs: docs.map((d) => ({
      runId,
      topicId,
      noteId: d.id,
      weight: null,
      cos: null,
    })),
  })

  emitConceptMapProgress({ stage: 'complete', message: 'Fallback topic generated', percent: 100 })
  return { runId, noteCount: docs.length }
}
