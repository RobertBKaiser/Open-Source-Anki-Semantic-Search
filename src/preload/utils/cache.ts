import { getSetting } from '../db/settings'
import { computeLocalEmbedding } from '../embeddings/gemma'

export type QueryEmb = { vec: Float32Array; dims: number; model: string; ts: number }
const QUERY_EMB_TTL_MS = 10 * 60 * 1000
const queryEmbCache: Map<string, QueryEmb> = new Map()

// Build a stable, unique cache key for query embeddings
export function makeEmbKey(q: string, model: string, dims: number): string {
  const trimmedQuery = typeof q === 'string' ? q.trim() : ''
  const trimmedModel = typeof model === 'string' ? model.trim() : ''
  const numericDims = Number(dims)
  if (!trimmedQuery) throw new Error('makeEmbKey: "q" must be a non-empty string')
  if (!trimmedModel) throw new Error('makeEmbKey: "model" must be a non-empty string')
  if (!Number.isFinite(numericDims) || !Number.isInteger(numericDims) || numericDims <= 0) {
    throw new Error('makeEmbKey: "dims" must be a positive integer')
  }
  const encodedQuery = encodeURIComponent(trimmedQuery)
  const encodedModel = encodeURIComponent(trimmedModel)
  return `${encodedModel}|${numericDims}|${encodedQuery}`
}

export async function getQueryEmbeddingCached(q: string): Promise<Float32Array | null> {
  try {
    const backend = getSetting('embedding_backend') || 'deepinfra'
    if (backend === 'gemma') {
      // Local path: compute via Transformers.js and cache by model+dtype
      const modelId = getSetting('gemma_model_id') || 'onnx-community/embeddinggemma-300m-ONNX'
      const dtype = getSetting('gemma_dtype') || 'q4'
      const key = `${encodeURIComponent(modelId)}|${encodeURIComponent(dtype)}|${encodeURIComponent(q.trim())}`
      const now = Date.now()
      const hit = queryEmbCache.get(key)
      if (hit && (now - hit.ts) < QUERY_EMB_TTL_MS) return hit.vec
      const arr = await computeLocalEmbedding([q], 'query')
      const vec = Array.isArray(arr) && Array.isArray(arr[0]) ? new Float32Array(arr[0]) : null
      if (!vec) return null
      queryEmbCache.set(key, { vec, dims: vec.length, model: `${modelId}:${dtype}`, ts: now })
      return vec
    }
    const apiKey = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
    if (!apiKey) return null
    const model = getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
    const dims = Number(getSetting('deepinfra_embed_dims') || '4096')
    const key = makeEmbKey(q, model, dims)
    const now = Date.now()
    const hit = queryEmbCache.get(key)
    if (hit && (now - hit.ts) < QUERY_EMB_TTL_MS) return hit.vec
    const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: [q], encoding_format: 'float', dimensions: dims })
    })
    if (!res.ok) return null
    const j = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    const emb = (Array.isArray(j?.data) && j.data![0]?.embedding) ? j.data![0].embedding : null
    if (!Array.isArray(emb) || emb.length !== dims) return null
    const vec = new Float32Array(emb)
    queryEmbCache.set(key, { vec, dims, model, ts: now })
    return vec
  } catch {
    return null
  }
}


