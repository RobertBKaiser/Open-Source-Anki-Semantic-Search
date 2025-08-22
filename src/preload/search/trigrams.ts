import type Database from 'better-sqlite3'

export type TriHit = { note_id: number; hits: number }

export function ensureTrigramIndex(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS note_trigrams (
    note_id INTEGER NOT NULL,
    trigram TEXT NOT NULL,
    PRIMARY KEY (note_id, trigram)
  );`)
}

export function trigramsFromTerms(terms: string[]): string[] {
  const joined = terms.join(' ')
  const set = new Set<string>()
  for (let i = 0; i < joined.length - 2; i++) set.add(joined.slice(i, i + 3))
  return Array.from(set)
}

export function searchTrigrams(db: Database.Database, trigrams: string[], limit = 300): TriHit[] {
  ensureTrigramIndex(db)
  if (trigrams.length === 0) return []
  const placeholders = trigrams.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT note_id, COUNT(*) AS hits
         FROM note_trigrams
        WHERE trigram IN (${placeholders})
        GROUP BY note_id
        ORDER BY hits DESC
        LIMIT ?`
    )
    .all(...trigrams, limit) as Array<{ note_id: number; hits: number }>
  return rows
}


