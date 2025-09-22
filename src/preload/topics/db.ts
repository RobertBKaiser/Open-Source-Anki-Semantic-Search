import crypto from 'node:crypto'
import { getEmbDb } from '../embeddings/core'

export type ConceptScope =
  | { type: 'query'; query: string; limit?: number }
  | { type: 'tag'; tag: string }
  | { type: 'deck'; deck: string }
  | { type: 'note-set'; noteIds: number[] }
  | { type: 'global'; profile?: string }
  | { type: 'custom'; id: string; label?: string }

export interface TopicRunRecord {
  runId: string
  scope: string
  scopeHash: string
  backend: string
  model: string
  noteCount: number
  paramsJson?: string | null
  createdAt: number
  query?: string | null
  queryEmbedding?: Buffer | null
  queryDim?: number | null
}

export interface TopicRecord {
  runId: string
  topicId: number
  parentId: number | null
  label: string
  level: number
  size: number
  score?: number | null
  queryCos?: number | null
  centroid?: Buffer | null
  centroidDim?: number | null
}

export interface TopicTermRecord {
  runId: string
  topicId: number
  term: string
  score: number
  rank: number
}

export interface TopicDocRecord {
  runId: string
  topicId: number
  noteId: number
  weight?: number | null
  cos?: number | null
}

export interface PersistConceptMapPayload {
  run: TopicRunRecord
  topics: TopicRecord[]
  terms: TopicTermRecord[]
  docs: TopicDocRecord[]
}

export function scopeLabel(scope: ConceptScope): string {
  switch (scope.type) {
    case 'query':
      return `query:${scope.query}`
    case 'tag':
      return `tag:${scope.tag}`
    case 'deck':
      return `deck:${scope.deck}`
    case 'note-set':
      return `note-set:${scope.noteIds.slice().sort((a, b) => a - b).join(',')}`
    case 'global':
      return scope.profile ? `global:${scope.profile}` : 'global'
    case 'custom':
    default:
      return scope.label ? `${scope.id}:${scope.label}` : `custom:${scope.id}`
  }
}

export function scopeHash(scope: ConceptScope): string {
  const stable = normalizeScope(scope)
  const json = JSON.stringify(stable)
  return crypto.createHash('sha1').update(json).digest('hex')
}

function normalizeScope(scope: ConceptScope): any {
  switch (scope.type) {
    case 'query':
      return { type: 'query', query: scope.query, limit: scope.limit ?? null }
    case 'tag':
      return { type: 'tag', tag: scope.tag }
    case 'deck':
      return { type: 'deck', deck: scope.deck }
    case 'note-set': {
      const unique = Array.from(new Set(scope.noteIds ?? [])).filter((n) => Number.isFinite(Number(n)))
      unique.sort((a, b) => Number(a) - Number(b))
      return { type: 'note-set', noteIds: unique }
    }
    case 'global':
      return { type: 'global', profile: scope.profile ?? null }
    case 'custom':
    default:
      return { type: 'custom', id: scope.id, label: scope.label ?? null }
  }
}

export function persistConceptMap(payload: PersistConceptMapPayload): void {
  const db = getEmbDb()
  const tx = db.transaction((input: PersistConceptMapPayload) => {
    db.prepare('DELETE FROM topic_runs WHERE run_id = ?').run(input.run.runId)
    db.prepare(
      `INSERT INTO topic_runs(
        run_id, scope, scope_hash, backend, model, note_count,
        params_json, created_at, query, query_embedding, query_dim
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      input.run.runId,
      input.run.scope,
      input.run.scopeHash,
      input.run.backend,
      input.run.model,
      input.run.noteCount,
      input.run.paramsJson ?? null,
      input.run.createdAt,
      input.run.query ?? null,
      input.run.queryEmbedding ?? null,
      input.run.queryDim ?? null
    )

    if (Array.isArray(input.topics) && input.topics.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO topics(
          run_id, topic_id, parent_id, label, level, size, score,
          query_cos, centroid, centroid_dim
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      for (const t of input.topics) {
        stmt.run(
          t.runId,
          t.topicId,
          t.parentId ?? null,
          t.label,
          t.level,
          t.size,
          t.score ?? null,
          t.queryCos ?? null,
          t.centroid ?? null,
          t.centroidDim ?? null
        )
      }
    }

    if (Array.isArray(input.terms) && input.terms.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO topic_terms(run_id, topic_id, term, score, rank)
        VALUES(?,?,?,?,?)`
      )
      for (const term of input.terms) {
        stmt.run(term.runId, term.topicId, term.term, term.score, term.rank)
      }
    }

    if (Array.isArray(input.docs) && input.docs.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO topic_docs(run_id, topic_id, note_id, weight, cos)
        VALUES(?,?,?,?,?)`
      )
      for (const doc of input.docs) {
        stmt.run(doc.runId, doc.topicId, doc.noteId, doc.weight ?? null, doc.cos ?? null)
      }
    }
  })
  tx(payload)
}

export function getConceptMap(
  runId: string
): { run: TopicRunRecord | null; topics: TopicRecord[]; terms: TopicTermRecord[]; docs: TopicDocRecord[] } {
  const db = getEmbDb()
  const runRow = db.prepare('SELECT * FROM topic_runs WHERE run_id = ?').get(runId) as any
  if (!runRow) {
    return { run: null, topics: [], terms: [], docs: [] }
  }
  const topicRows = db
    .prepare('SELECT * FROM topics WHERE run_id = ? ORDER BY level ASC, topic_id ASC')
    .all(runId) as Array<{
      run_id: string
      topic_id: number
      parent_id: number | null
      label: string
      level: number
      size: number
      score: number | null
      query_cos: number | null
      centroid: Buffer | null
      centroid_dim: number | null
    }>

  const termRows = db
    .prepare('SELECT * FROM topic_terms WHERE run_id = ? ORDER BY topic_id ASC, rank ASC')
    .all(runId) as Array<{
      run_id: string
      topic_id: number
      term: string
      score: number
      rank: number
    }>

  const docRows = db
    .prepare('SELECT * FROM topic_docs WHERE run_id = ?')
    .all(runId) as Array<{
      run_id: string
      topic_id: number
      note_id: number
      weight: number | null
      cos: number | null
    }>

  const topics: TopicRecord[] = topicRows.map((row) => ({
    runId: String(row.run_id),
    topicId: Number(row.topic_id),
    parentId: row.parent_id !== null ? Number(row.parent_id) : null,
    label: String(row.label || ''),
    level: Number(row.level || 0),
    size: Number(row.size || 0),
    score: row.score != null ? Number(row.score) : null,
    queryCos: row.query_cos != null ? Number(row.query_cos) : null,
    centroid: row.centroid ?? null,
    centroidDim: row.centroid_dim != null ? Number(row.centroid_dim) : null,
  }))

  const terms: TopicTermRecord[] = termRows.map((row) => ({
    runId: String(row.run_id),
    topicId: Number(row.topic_id),
    term: String(row.term || ''),
    score: Number(row.score || 0),
    rank: Number(row.rank || 0),
  }))

  const docs: TopicDocRecord[] = docRows.map((row) => ({
    runId: String(row.run_id),
    topicId: Number(row.topic_id),
    noteId: Number(row.note_id),
    weight: row.weight != null ? Number(row.weight) : null,
    cos: row.cos != null ? Number(row.cos) : null,
  }))

  return { run: mapRun(runRow), topics, terms, docs }
}

export function getLatestConceptMapForScope(scopeHashValue: string, backend: string, model: string): TopicRunRecord | null {
  const db = getEmbDb()
  const row = db
    .prepare(
      `SELECT * FROM topic_runs WHERE scope_hash = ? AND backend = ? AND model = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(scopeHashValue, backend, model) as any
  return row ? mapRun(row) : null
}

export function listConceptMapsForScope(
  scopeHashValue: string,
  backend?: string,
  model?: string,
  limit = 10
): TopicRunRecord[] {
  const db = getEmbDb()
  let sql = 'SELECT * FROM topic_runs WHERE scope_hash = ?'
  const params: any[] = [scopeHashValue]
  if (backend) {
    sql += ' AND backend = ?'
    params.push(backend)
  }
  if (model) {
    sql += ' AND model = ?'
    params.push(model)
  }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(Math.max(1, limit))
  const rows = db.prepare(sql).all(...params) as any[]
  return rows.map(mapRun)
}

export function deleteConceptMap(runId: string): void {
  const db = getEmbDb()
  db.prepare('DELETE FROM topic_runs WHERE run_id = ?').run(runId)
}

export function purgeOldConceptMaps(maxAgeSeconds: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(0, maxAgeSeconds)
  const db = getEmbDb()
  const res = db.prepare('DELETE FROM topic_runs WHERE created_at < ?').run(cutoff)
  return res.changes ?? 0
}

function mapRun(row: any): TopicRunRecord {
  return {
    runId: String(row.run_id),
    scope: String(row.scope),
    scopeHash: String(row.scope_hash),
    backend: String(row.backend),
    model: String(row.model),
    noteCount: Number(row.note_count || 0),
    paramsJson: row.params_json ?? null,
    createdAt: Number(row.created_at || 0),
    query: row.query ?? null,
    queryEmbedding: row.query_embedding ?? null,
    queryDim: row.query_dim ?? null
  }
}
