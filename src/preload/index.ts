import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import fs from 'node:fs'
import path from 'node:path'
import { api as aggregatedApi } from './api'

// Ensure the database directory exists (matches prior behavior)
const dbPath = path.resolve(process.cwd(), 'database/anki_cache.db')
try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }) } catch {}

// Expose APIs to renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', aggregatedApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = aggregatedApi
}


