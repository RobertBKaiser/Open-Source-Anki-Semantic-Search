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
      getSetting(key: string): string | null
      setSetting(key: string, value: string): void
      extractQueryKeywords(query: string): string[]
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
