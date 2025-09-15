import { getDb } from './core'

export function getSetting(key: string): string | null {
  try {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

export function setSetting(key: string, value: string): void {
  try {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  } catch {}
}


