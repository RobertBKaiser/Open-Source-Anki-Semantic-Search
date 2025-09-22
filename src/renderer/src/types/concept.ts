export type ConceptScope =
  | { type: 'query'; query: string; limit?: number }
  | { type: 'tag'; tag: string }
  | { type: 'deck'; deck: string }
  | { type: 'note-set'; noteIds: number[] }
  | { type: 'global'; profile?: string }
  | { type: 'custom'; id: string; label?: string }

export type ConceptTopicNote = {
  noteId: number
  weight?: number | null
  cos?: number | null
  firstField?: string | null
}

export type ConceptTopicTerm = { term: string; score: number; rank: number }

export type ConceptTopic = {
  topicId: number
  parentId: number | null
  label: string
  level: number
  size: number
  score?: number | null
  queryCos?: number | null
  centroid?: Float32Array | null
  centroidDim?: number | null
  terms: ConceptTopicTerm[]
  notes: ConceptTopicNote[]
  children: number[]
}

export type ConceptMapRun = {
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

export type ConceptMapDetails = {
  run: ConceptMapRun
  topics: ConceptTopic[]
  roots: number[]
}

export type ConceptMapProgress = {
  stage: string
  message?: string
  completed?: number
  total?: number
  percent?: number
}

export type ConceptMapBuildOptions = {
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
