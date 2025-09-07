import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      listNotes(limit?: number, offset?: number): Array<{ note_id: number; first_field: string | null }>
      countNotes(): number
      searchNotes(query: string, limit?: number, offset?: number): Array<{ note_id: number; first_field: string | null }>
      fuzzySearch(query: string, limit?: number, exclude?: string[]): Array<{
        note_id: number
        first_field: string | null
        bm25?: number
        trigrams?: number
        combined: number
        rrf: number
        where?: 'front' | 'back' | 'both'
      }>
      semanticRerank(query: string, limit?: number): Promise<Array<{
        note_id: number
        first_field: string | null
        bm25?: number
        trigrams?: number
        combined: number
        rrf: number
        where?: 'front' | 'back' | 'both'
        rerank?: number
      }>>
      hybridSemanticModulated(query: string, limit?: number): Promise<Array<{
        note_id: number
        first_field: string | null
        score: number
        cos?: number
        bm25?: number
        matched?: number
      }>>
      classifyBadges(noteIds: number[], queryText: string): Promise<Array<{ note_id: number; category?: 'in' | 'out' | 'related' | 'unknown'; category_num?: 0 | 1 | 2 | 3 }>>
      semanticRerankSmall(query: string): Promise<Array<{ note_id: number; first_field: string | null; rerank?: number }>>
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
      embedSearch(query: string, topK?: number): Promise<Array<{ note_id: number; first_field: string | null; rerank: number }>>
      getRelatedByEmbedding(noteId: number, minCos?: number, topK?: number): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>>
      extractFrontKeyIdeas(noteId: number, maxItems?: number): string[]
      getTopKeywordsForNote(noteId: number, maxItems?: number): string[]
      extractFrontKeyIdeasLLM(noteId: number, maxItems?: number): Promise<string[]>
      getRelatedByBm25(noteId: number, limit?: number, terms?: string[]): Array<{ note_id: number; first_field: string | null; bm25: number }>
      getRelatedByEmbeddingTerms(terms: string[], topK?: number): Promise<Array<{ note_id: number; first_field: string | null; cos: number }>>
      getSetting(key: string): string | null
      setSetting(key: string, value: string): void
      extractQueryKeywords(query: string): string[]
      searchByBm25Terms(terms: string[], limit?: number): Array<{ note_id: number; first_field: string | null; bm25: number }>
      bm25ForNotesByTerms(terms: string[], noteIds: number[]): Array<{ note_id: number; bm25: number }>
      extractKeywordsForNotes(noteIds: number[], perNoteTopK?: number, maxGlobal?: number): Array<{ note_id: number; keywords: string[] }>
      getKeywordEmbeddings(terms: string[]): Promise<Array<{ term: string; vec: Float32Array }>>
      clusterKeywords(terms: string[], threshold?: number): Promise<Map<string, string>>
      cosineForTerms(terms: string[], query: string): Promise<Array<{ term: string; cos: number }>>
      embedCosForTermAgainstNotes(term: string, noteIds: number[]): Promise<Array<{ note_id: number; cos: number }>>
      embedCosForTermsComboAgainstNotes(terms: string[], noteIds: number[]): Promise<Array<{ note_id: number; cos: number }>>
      getNoteDetails(noteId: number): {
        note: { note_id: number; model_name: string; mod: number | null }
        fields: Array<{ field_name: string; value_html: string; ord: number | null }>
        tags: string[]
      } | null
      runIngest(query?: string): Promise<{ code: number; output: string }>
      pingAnkiConnect(): Promise<{ ok: boolean; version?: number; error?: string }>
    }
  }
}
