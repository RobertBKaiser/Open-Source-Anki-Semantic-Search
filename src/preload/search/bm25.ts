import type Database from 'better-sqlite3'

export type Bm25Hit = { note_id: number; score: number }

export function ensureFts(db: Database.Database): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(content, note_id UNINDEXED, tokenize='unicode61');`)
}

export function searchBm25(db: Database.Database, matchExpr: string, limit = 150): Bm25Hit[] {
  ensureFts(db)
  const rows = db
    .prepare(
      `SELECT note_id, bm25(note_fts) AS score
         FROM note_fts
        WHERE note_fts MATCH ?
        ORDER BY score
        LIMIT ?`
    )
    .all(matchExpr, limit) as Array<{ note_id: number; score: number }>
  return rows
}


