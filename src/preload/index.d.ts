import { ElectronAPI } from '@electron-toolkit/preload'

// Reusable row types to keep declarations readable
type NoteRow = { note_id: number; first_field: string | null }
type RerankRow = {
  note_id: number
  first_field: string | null
  bm25?: number
  trigrams?: number
  combined: number
  rrf: number
  where?: 'front' | 'back' | 'both'
  rerank?: number
}
type HybridRow = {
  note_id: number
  first_field: string | null
  score: number
  cos?: number
  bm25?: number
  matched?: number
}
type EmbedRow = { note_id: number; first_field: string | null; rerank: number }
type EmbRelRow = { note_id: number; first_field: string | null; cos: number }
type Bm25Row = { note_id: number; first_field: string | null; bm25: number }
type TermCosRow = { note_id: number; cos: number }
type CategoryRow = {
  note_id: number
  category?: 'in' | 'out' | 'related' | 'unknown'
  category_num?: 0 | 1 | 2 | 3
}
type ConceptScope =
  | { type: 'query'; query: string; limit?: number }
  | { type: 'tag'; tag: string }
  | { type: 'deck'; deck: string }
  | { type: 'note-set'; noteIds: number[] }
  | { type: 'global'; profile?: string }
  | { type: 'custom'; id: string; label?: string }
type ConceptTopicNote = { noteId: number; weight?: number | null; cos?: number | null; firstField?: string | null }
type ConceptTopic = {
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
type ConceptMapRun = {
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
type ConceptMapDetails = {
  run: ConceptMapRun
  topics: ConceptTopic[]
  roots: number[]
}
type ConceptMapBuildOptions = {
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
type ConceptMapProgress = {
  stage: string
  message?: string
  completed?: number
  total?: number
  percent?: number
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      listNotes(limit?: number, offset?: number): Array<NoteRow>
      getNotesByTag(tag: string, limit?: number, offset?: number): Array<NoteRow>
      getNotesByTagPrefix(prefix: string, limit?: number, offset?: number): Array<NoteRow>
      getChildTags(prefix: string): Array<{ tag: string; notes: number }>
      listAllTags(): Array<{ tag: string; notes: number }>
      countNotes(): number
      searchNotes(query: string, limit?: number, offset?: number): Array<NoteRow>
      fuzzySearch(query: string, limit?: number, exclude?: string[]): Array<RerankRow>
      semanticRerank(query: string, limit?: number): Promise<Array<RerankRow>>
      hybridSemanticModulated(query: string, limit?: number): Promise<Array<HybridRow & { __cos_breakdown__?: Array<{ backend: 'deepinfra'|'google'|'gemma'; model: string; cos: number }> }>>
      hybridSemanticModulatedFromNote(noteId: number, limit?: number): Promise<Array<HybridRow>>
      classifyBadges(noteIds: number[], queryText: string): Promise<Array<CategoryRow>>
      semanticRerankSmall(
        query: string
      ): Promise<Array<{ note_id: number; first_field: string | null; rerank?: number }>>
      unsuspendNotes(noteIds: number[]): Promise<{ ok: boolean; changed: number; error?: string }>
      // Embeddings management
      startEmbedding(rebuild?: boolean): Promise<{ pid: number }>
      stopEmbedding(): Promise<{ ok: boolean }>
      getEmbeddingProgress(): {
        total: number
        embedded: number
        pending: number
        errors: number
        rate: number
        etaSeconds: number
      }
      getEmbeddingProgressAll(): Array<{
        backend: 'deepinfra' | 'gemma' | 'google'
        model: string
        total: number
        embedded: number
        pending: number
        errors: number
        rate: number
        etaSeconds: number
      }>
      migrateEmbeddingsTo4096(): { ok: boolean; changed: number }
      buildVectorIndexHNSW(): Promise<{ ok: boolean; path?: string; error?: string }>
      getHnswBuildStatus(): {
        running: boolean
        total: number
        processed: number
        errors: number
        startedAt?: number
        etaSeconds?: number
      }
      embedSearch(query: string, topK?: number): Promise<Array<EmbedRow & { __cos_breakdown__?: Array<{ backend: 'deepinfra'|'google'|'gemma'; model: string; cos: number }> }>>
      getRelatedByEmbedding(
        noteId: number,
        minCos?: number,
        topK?: number
      ): Promise<Array<EmbRelRow>>
      extractFrontKeyIdeas(noteId: number, maxItems?: number): string[]
      getTopKeywordsForNote(noteId: number, maxItems?: number): string[]
      extractFrontKeyIdeasLLM(noteId: number, maxItems?: number): Promise<string[]>
      getRelatedByBm25(noteId: number, limit?: number, terms?: string[]): Array<Bm25Row>
      getRelatedByEmbeddingTerms(terms: string[], topK?: number): Promise<Array<EmbRelRow>>
      getSetting(key: string): string | null
      setSetting(key: string, value: string): void
      extractQueryKeywords(query: string): string[]
      searchByBm25Terms(terms: string[], limit?: number): Array<Bm25Row>
      bm25ForNotesByTerms(
        terms: string[],
        noteIds: number[]
      ): Array<{ note_id: number; bm25: number }>
      extractKeywordsForNotes(
        noteIds: number[],
        perNoteTopK?: number,
        maxGlobal?: number
      ): Array<{ note_id: number; keywords: string[] }>
      getKeywordEmbeddings(terms: string[]): Promise<Array<{ term: string; vec: Float32Array }>>
      clusterKeywords(terms: string[], threshold?: number): Promise<Map<string, string>>
      cosineForTerms(terms: string[], query: string): Promise<Array<{ term: string; cos: number }>>
      embedCosForTermAgainstNotes(term: string, noteIds: number[]): Promise<Array<TermCosRow>>
      embedCosForTermsComboAgainstNotes(
        terms: string[],
        noteIds: number[],
        perNoteTopK?: number,
        maxGlobal?: number
      ): Promise<Array<TermCosRow>>
      groupNotesByAI(
        noteIds: number[],
        queryText: string
      ): Promise<{ groups: Array<{ label: string; notes: number[] }>; hierarchy?: Array<{ label: string; children: string[] }> }>
      getNoteDetails(noteId: number): {
        note: { note_id: number; model_name: string; mod: number | null }
        fields: Array<{ field_name: string; value_html: string; ord: number | null }>
        tags: string[]
      } | null
      runIngest(query?: string): Promise<{ code: number; output: string }>
      pingAnkiConnect(): Promise<{ ok: boolean; version?: number; error?: string }>
      openInAnki(noteId: number): Promise<{ ok: boolean; error?: string }>
      // Local embeddings (Transformers.js EmbeddingGemma)
      computeLocalEmbedding(texts: string[], role?: 'query' | 'document'): Promise<number[][]>
      buildConceptMapForNotes(options: ConceptMapBuildOptions): Promise<{ runId: string; noteCount: number }>
      getConceptMapDetails(runId: string): ConceptMapDetails | null
      listConceptMapHistory(scope: ConceptScope, backend?: string, model?: string, limit?: number): ConceptMapRun[]
      deleteConceptMapRun(runId: string): void
      getConceptMapProgress(): ConceptMapProgress
      subscribeConceptMapProgress(callback: (progress: ConceptMapProgress) => void): () => void
    }
  }
}
