// Aggregate and expose the public preload API with the same surface as before
import { getSetting, setSetting } from './db/settings'
import { listAllTags, getChildTags } from './db/tags'
import { listNotes, searchNotes, getNoteDetails, countNotes, getNotesByTag, getNotesByTagPrefix } from './db/notes'
import { getFirstFieldsForIds, getBackFieldsForIds, frontIsVisible } from './db/fields'
import { getEmbDb, getEmbeddingProgress, migrateEmbeddingsTo4096, getEmbeddingProgressAll } from './embeddings/core'
import { getPrecomputedRelated, setPrecomputedRelated } from './embeddings/precomputed'
import { getHnswIndex, getHnswBuildStatus, buildVectorIndexHNSW } from './embeddings/hnsw'
import { extractQueryKeywords, extractKeywordsForNotes, extractFrontKeyIdeas, getTopKeywordsForNote } from './keywords/extract'
import { extractFrontKeyIdeasLLM } from './keywords/llm'
import { getKeywordEmbeddings, cosineForTerms, embedCosForTermAgainstNotes, embedCosForTermsComboAgainstNotes, clusterKeywords } from './keywords/embeddings'
import { bm25ForNotesByTerms, searchByBm25Terms, getRelatedByBm25 } from './api/search/bm25'
import { fuzzySearch } from './api/search/fuzzy'
import { embedSearch, getRelatedByEmbedding, getRelatedByEmbeddingTerms } from './api/search/embed'
import { hybridSemanticModulated, hybridSemanticModulatedFromNote } from './api/search/hybrid'
import { semanticRerank, semanticRerankSmall } from './api/search/rerank'
import { pingAnkiConnect, openInAnki, unsuspendNotes } from './anki/connect'
import { runIngest } from './jobs/ingest'
import { groupNotesByAI } from './ai/grouping'
import { startEmbedding, stopEmbedding } from './jobs/embedding'
import { computeLocalEmbedding } from './embeddings/gemma'
import {
  buildConceptMapForNotes,
  getConceptMapDetails,
  listConceptMapHistory,
  deleteConceptMapRun,
} from './topics/service'
import { onConceptMapProgress, getConceptMapProgress } from './topics/progress'
import type { ConceptMapProgress } from './topics/progress'

export const api = {
  // settings
  getSetting,
  setSetting,
  // tags
  listAllTags,
  getChildTags,
  // notes
  listNotes,
  searchNotes,
  getNoteDetails,
  countNotes,
  getNotesByTag,
  getNotesByTagPrefix,
  // fields/utils
  getFirstFieldsForIds,
  getBackFieldsForIds,
  frontIsVisible,
  // embeddings/core
  getEmbDb,
  getEmbeddingProgress,
  getEmbeddingProgressAll,
  migrateEmbeddingsTo4096,
  // precomputed/hnsw
  getPrecomputedRelated,
  setPrecomputedRelated,
  getHnswIndex,
  getHnswBuildStatus,
  buildVectorIndexHNSW,
  // keywords
  extractQueryKeywords,
  extractKeywordsForNotes,
  extractFrontKeyIdeas,
  getTopKeywordsForNote,
  extractFrontKeyIdeasLLM,
  getKeywordEmbeddings,
  cosineForTerms,
  embedCosForTermAgainstNotes,
  embedCosForTermsComboAgainstNotes,
  clusterKeywords,
  // search
  bm25ForNotesByTerms,
  searchByBm25Terms,
  getRelatedByBm25,
  fuzzySearch,
  embedSearch,
  getRelatedByEmbedding,
  getRelatedByEmbeddingTerms,
  hybridSemanticModulated,
  hybridSemanticModulatedFromNote,
  semanticRerank,
  semanticRerankSmall,
  // local embeddings
  computeLocalEmbedding,
  // concept maps
  buildConceptMapForNotes,
  getConceptMapDetails,
  listConceptMapHistory,
  deleteConceptMapRun,
  getConceptMapProgress,
  subscribeConceptMapProgress: (callback: (progress: ConceptMapProgress) => void) => {
    const handler = (progress: ConceptMapProgress) => {
      try { callback(progress) } catch (err) { console.error('[ConceptMap] progress callback error', err) }
    }
    const unsubscribe = onConceptMapProgress(handler)
    const current = getConceptMapProgress()
    setTimeout(() => {
      try { callback(current) } catch {}
    }, 0)
    return () => unsubscribe()
  },
  // ai grouping
  groupNotesByAI,
  // anki & jobs
  pingAnkiConnect,
  openInAnki,
  unsuspendNotes,
  runIngest,
  startEmbedding,
  stopEmbedding
}

export type Api = typeof api
