import { getSetting } from '../db/settings'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_CACHE_DIR = (() => {
  try {
    const p = path.resolve(process.cwd(), 'node_modules', '@huggingface', 'transformers', '.cache')
    fs.mkdirSync(p, { recursive: true })
    if (!process.env.HF_HUB_CACHE) process.env.HF_HUB_CACHE = p
    if (!process.env.TRANSFORMERS_CACHE) process.env.TRANSFORMERS_CACHE = p
    return p
  } catch {
    return undefined
  }
})()

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
  try {
    if (DEFAULT_CACHE_DIR) {
      const onnxDir = path.join(DEFAULT_CACHE_DIR, modelId, 'onnx')
      if (fs.existsSync(onnxDir)) {
        try { console.log('[gemma] cache contents', onnxDir, fs.readdirSync(onnxDir)) } catch {}
      } else {
        console.warn('[gemma] expected cache dir missing', onnxDir)
      }
    }
  } catch {}
  // Lazy import to keep app startup light
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const transformers = await import('@huggingface/transformers')
  const AutoTokenizer = (transformers as any).AutoTokenizer
  const AutoModel = (transformers as any).AutoModel
  const candidateDirs = DEFAULT_CACHE_DIR
    ? [
        path.join(DEFAULT_CACHE_DIR, modelId),
        path.join(DEFAULT_CACHE_DIR, modelId.replace(/\//g, '--')),
        path.join(DEFAULT_CACHE_DIR, modelId.replace(/\//g, '-')),
      ]
    : []
  const sourceDir = candidateDirs.find((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isDirectory() } catch { return false }
  })
  const source = sourceDir || modelId
  try {
    if (DEFAULT_CACHE_DIR && (transformers as any)?.env) {
      try {
        (transformers as any).env.cacheDir = DEFAULT_CACHE_DIR
        ;(transformers as any).env.localModelPath = DEFAULT_CACHE_DIR
        ;(transformers as any).env.allowLocalModels = true
      } catch {}
    }
    try { console.log('[gemma] loading source', source, 'candidates', candidateDirs) } catch {}
    __tokenizer = await AutoTokenizer.from_pretrained(source, DEFAULT_CACHE_DIR ? { cacheDir: DEFAULT_CACHE_DIR } : undefined)
    __model = await AutoModel.from_pretrained(source, DEFAULT_CACHE_DIR ? { dtype, cacheDir: DEFAULT_CACHE_DIR } : { dtype })
  } catch (err) {
    __tokenizer = null
    __model = null
    __loadedKey = null
    try {
      const onnxPath = DEFAULT_CACHE_DIR ? path.join(DEFAULT_CACHE_DIR, modelId, 'onnx') : '(unknown)'
      console.error('[gemma] model load failed', { cacheDir: DEFAULT_CACHE_DIR, onnxPath, error: err })
    } catch {}
    throw err
  }
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
