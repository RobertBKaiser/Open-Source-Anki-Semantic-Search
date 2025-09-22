import { EventEmitter } from 'node:events'

export type ConceptMapProgress = {
  stage: string
  message?: string
  completed?: number
  total?: number
  percent?: number
}

const emitter = new EventEmitter()
let lastProgress: ConceptMapProgress = { stage: 'idle', percent: 0 }

function normalize(progress: Partial<ConceptMapProgress>): ConceptMapProgress {
  const merged: ConceptMapProgress = {
    stage: progress.stage || lastProgress.stage || 'idle',
    message: progress.message ?? lastProgress.message,
    completed: typeof progress.completed === 'number' ? progress.completed : lastProgress.completed,
    total: typeof progress.total === 'number' ? progress.total : lastProgress.total,
    percent: typeof progress.percent === 'number' ? progress.percent : lastProgress.percent,
  }
  if (typeof merged.completed === 'number' && typeof merged.total === 'number' && merged.total > 0) {
    merged.percent = Math.max(0, Math.min(100, (merged.completed / merged.total) * 100))
  }
  if (typeof merged.percent !== 'number' || Number.isNaN(merged.percent)) {
    merged.percent = lastProgress.percent ?? 0
  }
  return merged
}

export function resetConceptMapProgress(initial?: ConceptMapProgress): void {
  lastProgress = initial ?? { stage: 'idle', percent: 0 }
  emitter.emit('progress', lastProgress)
}

export function emitConceptMapProgress(update: Partial<ConceptMapProgress> & { stage?: string }): void {
  lastProgress = normalize(update)
  emitter.emit('progress', lastProgress)
}

export function onConceptMapProgress(listener: (progress: ConceptMapProgress) => void): () => void {
  const handler = (p: ConceptMapProgress) => {
    try { listener(p) } catch (err) { console.error('[ConceptMap] progress listener error', err) }
  }
  emitter.on('progress', handler)
  return () => emitter.off('progress', handler)
}

export function getConceptMapProgress(): ConceptMapProgress {
  return lastProgress
}
