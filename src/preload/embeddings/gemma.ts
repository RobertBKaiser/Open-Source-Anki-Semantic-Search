import { getSetting } from '../db/settings'

let __tokenizer: any | null = null
let __model: any | null = null
let __loadedKey: string | null = null

async function ensureGemma(): Promise<{ tokenizer: any; model: any; prefix: { query: string; document: string } }> {
  // Read settings with sensible defaults
  const modelId = getSetting('gemma_model_id') || 'onnx-community/embeddinggemma-300m-ONNX'
  const dtype = (getSetting('gemma_dtype') || 'q4') as 'fp32' | 'q8' | 'q4'
  const loadKey = `${modelId}::${dtype}`
  if (__model && __tokenizer && __loadedKey === loadKey) {
    return { tokenizer: __tokenizer, model: __model, prefix: { query: 'task: search result | query: ', document: 'title: none | text: ' } }
  }
  // Lazy import to keep app startup light
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const transformers = await import('@huggingface/transformers')
  const AutoTokenizer = (transformers as any).AutoTokenizer
  const AutoModel = (transformers as any).AutoModel
  __tokenizer = await AutoTokenizer.from_pretrained(modelId)
  __model = await AutoModel.from_pretrained(modelId, { dtype })
  __loadedKey = loadKey
  return { tokenizer: __tokenizer, model: __model, prefix: { query: 'task: search result | query: ', document: 'title: none | text: ' } }
}

export async function computeLocalEmbedding(texts: string[], role: 'query' | 'document' = 'document'): Promise<number[][]> {
  const arr = Array.isArray(texts) ? texts.map((s) => String(s || '')) : []
  if (arr.length === 0) return []
  const { tokenizer, model, prefix } = await ensureGemma()
  const prefixed = arr.map((s) => (role === 'query' ? prefix.query + s : prefix.document + s))
  const inputs = await tokenizer(prefixed, { padding: true })
  const out = await model(inputs)
  const emb = out?.sentence_embedding
  if (!emb || typeof emb.tolist !== 'function') return []
  const mat: number[][] = emb.tolist()
  return mat
}


