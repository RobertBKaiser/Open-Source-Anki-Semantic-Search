import fs from 'node:fs'
import path from 'node:path'

let HNSW: any = null
let hnswIndexGlobal: any = null
let hnswDimsGlobal = 0

export function getHnswIndex(dims: number): any | null {
  try {
    if (!HNSW) { try { ({ HierarchicalNSW: HNSW } = require('hnswlib-node')) } catch { HNSW = null } }
    const idxPath = path.resolve(process.cwd(), 'database/hnsw_index.bin')
    if (!HNSW || !fs.existsSync(idxPath)) return null
    if (hnswIndexGlobal && hnswDimsGlobal === dims) return hnswIndexGlobal
    const idx = new HNSW('cosine', dims)
    idx.readIndex(idxPath)
    try { idx.setEf(200) } catch {}
    hnswIndexGlobal = idx
    hnswDimsGlobal = dims
    return idx
  } catch { return null }
}

export const hnswBuildStatus: { running: boolean; total: number; processed: number; errors: number; startedAt?: number; etaSeconds?: number } = {
  running: false,
  total: 0,
  processed: 0,
  errors: 0
}

export function getHnswBuildStatus(): { running: boolean; total: number; processed: number; errors: number; startedAt?: number; etaSeconds?: number } {
  return hnswBuildStatus
}

export async function buildVectorIndexHNSW(dims: number, rows: Array<{ note_id: number; vec: Float32Array }>): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    let HierarchicalNSW: any
    try { ({ HierarchicalNSW } = require('hnswlib-node')) } catch { return { ok: false, error: 'hnswlib-node not installed' } }
    if (rows.length === 0) return { ok: false, error: 'no embeddings' }
    const index = new HierarchicalNSW('cosine', dims)
    index.initIndex(rows.length)
    hnswBuildStatus.running = true
    hnswBuildStatus.total = rows.length
    hnswBuildStatus.processed = 0
    hnswBuildStatus.errors = 0
    hnswBuildStatus.startedAt = Date.now()
    const BATCH = 500
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const vec = (r.vec.length === dims) ? r.vec : r.vec.slice(0, dims)
      index.addPoint(Array.from(vec), r.note_id)
      hnswBuildStatus.processed++
      if ((i + 1) % BATCH === 0) {
        const dt = Math.max(1, (Date.now() - (hnswBuildStatus.startedAt || Date.now())) / 1000)
        const rate = hnswBuildStatus.processed / dt
        const remaining = Math.max(0, hnswBuildStatus.total - hnswBuildStatus.processed)
        hnswBuildStatus.etaSeconds = rate > 0 ? Math.round(remaining / rate) : undefined
        await new Promise((res) => setTimeout(res, 0))
      }
    }
    try { index.setEf(200) } catch {}
    const pathIdx = path.resolve(process.cwd(), 'database/hnsw_index.bin')
    index.writeIndex(pathIdx)
    hnswBuildStatus.running = false
    return { ok: true, path: pathIdx }
  } catch (e) {
    hnswBuildStatus.running = false
    return { ok: false, error: (e as Error).message }
  }
}


