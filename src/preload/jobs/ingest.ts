import { spawn } from 'child_process'
import path from 'node:path'

export function runIngest(query: string = '*'): Promise<{ code: number; output: string }>{
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(process.cwd(), 'database/anki_ingest.mjs')
    const child = spawn(process.execPath, [scriptPath, query], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let output = ''
    child.stdout.on('data', (d) => { output += d.toString() })
    child.stderr.on('data', (d) => { output += d.toString() })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}


