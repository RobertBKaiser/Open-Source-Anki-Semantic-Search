import { spawn as spawnChild } from 'node:child_process'
import path from 'node:path'
import { getSetting } from '../db/settings'

export function startEmbedding(rebuild?: boolean): Promise<{ pid: number }>{
  return new Promise((resolve, reject) => {
    try {
      const scriptPath = path.resolve(process.cwd(), 'database/embed_index.mjs')
      const key = getSetting('deepinfra_api_key') || process.env.DEEPINFRA_API_KEY || ''
      const dims = getSetting('deepinfra_embed_dims') || '4096'
      const model = getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'
      const service = getSetting('deepinfra_embed_tier') || 'default'
      const child = spawnChild(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DEEPINFRA_API_KEY: key, EMBED_MODEL: model, EMBED_DIMS: String(dims), EMBED_SERVICE_TIER: service, CONCURRENCY: '200', BATCH_SIZE: '8', REBUILD_ALL: rebuild ? '1' : '0' }
      })
      child.stdout?.on('data', (d) => { try { console.log(String(d)) } catch {} })
      child.stderr?.on('data', (d) => { try { console.error(String(d)) } catch {} })
      ;(globalThis as any).__embedChild = child
      resolve({ pid: child.pid ?? -1 })
    } catch (e) { reject(e) }
  })
}

export function stopEmbedding(): Promise<{ ok: boolean }>{
  return new Promise((resolve) => {
    try { const child = (globalThis as any).__embedChild; if (child && typeof child.kill === 'function') child.kill('SIGINT') } catch {} finally { resolve({ ok: true }) }
  })
}


