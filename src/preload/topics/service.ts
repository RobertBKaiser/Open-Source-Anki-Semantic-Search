import {
  ConceptScope,
  scopeHash,
  getConceptMap as getConceptMapRaw,
  listConceptMapsForScope,
  deleteConceptMap,
  TopicDocRecord,
  TopicTermRecord,
  TopicRunRecord,
} from './db'
import { buildConceptMap as buildWithTopicBert, BuildConceptMapOptions } from './build'
import { getFirstFieldsForIds, frontIsVisible } from '../db/fields'

export interface ConceptTopicNote {
  noteId: number
  weight?: number | null
  cos?: number | null
  firstField?: string | null
}

export interface ConceptTopic {
  topicId: number
  parentId: number | null
  label: string
  level: number
  size: number
  score?: number | null
  queryCos?: number | null
  centroid?: Float32Array | null
  centroidDim?: number | null
  terms: Array<{ term: string; score: number; rank: number }>
  notes: ConceptTopicNote[]
  children: number[]
}

export interface ConceptMapRun {
  runId: string
  scope: string
  scopeHash: string
  backend: string
  model: string
  noteCount: number
  paramsJson?: string | null
  createdAt: number
  query?: string | null
  queryEmbedding?: Float32Array | null
  queryDim?: number | null
}

export interface ConceptMapDetails {
  run: ConceptMapRun
  topics: ConceptTopic[]
  roots: number[]
}

export async function buildConceptMapForNotes(options: BuildConceptMapOptions): Promise<{ runId: string; noteCount: number }> {
  return buildWithTopicBert(options)
}

export function getConceptMapDetails(runId: string): ConceptMapDetails | null {
  const raw = getConceptMapRaw(runId)
  if (!raw.run) return null
  const termByTopic = groupTerms(raw.terms)
  const docsByTopic = groupDocs(raw.docs)
  const topics: ConceptTopic[] = []
  const children = new Map<number, number[]>()
  const allTopicIds: number[] = []
  const allNoteIds = new Set<number>()

  for (const topic of raw.topics) {
    allTopicIds.push(topic.topicId)
    const docEntries = docsByTopic.get(topic.topicId) || []
    for (const d of docEntries) allNoteIds.add(d.noteId)
    const termRecords = termByTopic.get(topic.topicId) || []
    topics.push({
      topicId: topic.topicId,
      parentId: topic.parentId ?? null,
      label: topic.label,
      level: topic.level,
      size: topic.size,
      score: topic.score ?? null,
      queryCos: topic.queryCos ?? null,
      centroid: bufferToFloat32(topic.centroid),
      centroidDim: topic.centroidDim ?? null,
      terms: termRecords.map((t) => ({ term: t.term, score: t.score, rank: t.rank })),
      notes: docEntries.map((d) => ({ noteId: d.noteId, weight: d.weight ?? null, cos: d.cos ?? null })),
      children: [],
    })
    if (topic.parentId != null) {
      const arr = children.get(topic.parentId) || []
      arr.push(topic.topicId)
      children.set(topic.parentId, arr)
    }
  }

  const firstFields = getFirstFieldsForIds(Array.from(allNoteIds))

  for (const topic of topics) {
    topic.children = children.get(topic.topicId) || []
    topic.notes = topic.notes
      .map((n) => ({
        ...n,
        firstField: formatFront(firstFields.get(n.noteId) ?? null),
      }))
      .filter((n) => frontIsVisible(n.firstField || ''))
  }

  const topicIds = new Set(topics.map((t) => t.topicId))
  const roots = topics
    .filter((t) => t.parentId == null || !topicIds.has(Number(t.parentId)))
    .map((t) => t.topicId)

  return {
    run: mapRun(raw.run),
    topics,
    roots,
  }
}

export function getLatestConceptMap(scope: ConceptScope, backend?: string, model?: string): TopicRunRecord | null {
  const hash = scopeHash(scope)
  const rows = listConceptMapsForScope(hash, backend, model, 1)
  return rows.length > 0 ? rows[0] : null
}

export function listConceptMapHistory(scope: ConceptScope, backend?: string, model?: string, limit = 5): TopicRunRecord[] {
  const hash = scopeHash(scope)
  return listConceptMapsForScope(hash, backend, model, limit)
}

export function deleteConceptMapRun(runId: string): void {
  deleteConceptMap(runId)
}

function groupTerms(terms: TopicTermRecord[]): Map<number, TopicTermRecord[]> {
  const by = new Map<number, TopicTermRecord[]>()
  for (const term of terms) {
    const list = by.get(term.topicId) || []
    list.push(term)
    by.set(term.topicId, list)
  }
  for (const list of by.values()) list.sort((a, b) => a.rank - b.rank)
  return by
}

function groupDocs(docs: TopicDocRecord[]): Map<number, TopicDocRecord[]> {
  const by = new Map<number, TopicDocRecord[]>()
  for (const doc of docs) {
    const list = by.get(doc.topicId) || []
    list.push(doc)
    by.set(doc.topicId, list)
  }
  return by
}

function formatFront(html: string | null): string | null {
  if (!html) return null
  return html
}

function bufferToFloat32(buf?: Buffer | null): Float32Array | null {
  if (!buf) return null
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(arrayBuffer)
}

function mapRun(run: TopicRunRecord): ConceptMapRun {
  return {
    runId: run.runId,
    scope: run.scope,
    scopeHash: run.scopeHash,
    backend: run.backend,
    model: run.model,
    noteCount: run.noteCount,
    paramsJson: run.paramsJson ?? null,
    createdAt: run.createdAt,
    query: run.query ?? null,
    queryEmbedding: bufferToFloat32(run.queryEmbedding ?? null),
    queryDim: run.queryDim ?? null,
  }
}
