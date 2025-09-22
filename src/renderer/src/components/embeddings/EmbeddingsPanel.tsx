import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'

type BackendId = 'deepinfra' | 'google' | 'gemma'

type OverallProgress = {
  total: number
  embedded: number
  pending: number
  errors: number
  rate: number
  etaSeconds: number
}

type BackendProgress = {
  backend: BackendId
  model: string
  total: number
  embedded: number
  pending: number
  errors: number
  rate: number
  etaSeconds: number
}

type HnswProgress = {
  running: boolean
  total: number
  processed: number
  errors: number
  startedAt?: number
  etaSeconds?: number
}

type FeedbackTone = 'info' | 'success' | 'error'

type ActionFeedback = {
  tone: FeedbackTone
  message: string
}

type EmbeddingsPanelProps = {
  open: boolean
  isActive: boolean
  onNavigateTab: (tab: string) => void
}

type BackendMeta = {
  title: string
  blurb: string
}

const DEFAULTS = {
  backend: 'deepinfra' as BackendId,
  deepinfraModel: 'Qwen/Qwen3-Embedding-8B',
  deepinfraDims: '4096',
  gemmaModel: 'onnx-community/embeddinggemma-300m-ONNX',
  gemmaDtype: 'q4',
  googleModel: 'gemini-embedding-001',
}

const BACKENDS: Record<BackendId, BackendMeta> = {
  deepinfra: {
    title: 'DeepInfra Cloud',
    blurb: 'Hosted Qwen3 embeddings. Fast, highest recall. Requires API key.',
  },
  google: {
    title: 'Google Gemini',
    blurb: 'Gemini embedding (3072 dims). Good semantic coverage. Requires API key.',
  },
  gemma: {
    title: 'Local Gemma',
    blurb: 'Runs fully offline via Transformers.js. Great for privacy, slower throughput.',
  },
}

const TONE_STYLES: Record<FeedbackTone | 'muted', string> = {
  info: 'bg-blue-100 text-blue-700 border-blue-200',
  success: 'bg-emerald-100 text-emerald-600 border-emerald-200',
  error: 'bg-red-100 text-red-600 border-red-200',
  muted: 'bg-slate-100 text-slate-600 border-slate-200',
}

const PROGRESS_COLORS: Record<BackendId | 'overall', string> = {
  overall: 'bg-blue-500',
  deepinfra: 'bg-purple-500',
  google: 'bg-emerald-500',
  gemma: 'bg-orange-500',
}

const BACKEND_ORDER: BackendId[] = ['deepinfra', 'google', 'gemma']

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString()
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 100) return `${value.toFixed(0)} / sec`
  if (value >= 10) return `${value.toFixed(1)} / sec`
  return `${value.toFixed(2)} / sec`
}

function formatEta(seconds?: number | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins < 1) return `${secs}s`
  if (mins < 60) return `${mins}m ${secs}s`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) return `${hours}h ${remMins}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return `${days}d ${remHours}h`
}

function pct(embedded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const raw = (embedded / total) * 100
  return Math.min(100, Math.max(0, Math.round(raw)))
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error'
  }
}

export function EmbeddingsPanel({ open, isActive, onNavigateTab }: EmbeddingsPanelProps): React.JSX.Element {
  const [backend, setBackend] = useState<BackendId>(DEFAULTS.backend)
  const [multiModel, setMultiModel] = useState<boolean>(false)
  const [includeDeepinfra, setIncludeDeepinfra] = useState<boolean>(true)
  const [includeGoogle, setIncludeGoogle] = useState<boolean>(true)
  const [includeGemma, setIncludeGemma] = useState<boolean>(true)
  const [deepinfraModel, setDeepinfraModel] = useState<string>(DEFAULTS.deepinfraModel)
  const [deepinfraDims, setDeepinfraDims] = useState<string>(DEFAULTS.deepinfraDims)
  const [gemmaModel, setGemmaModel] = useState<string>(DEFAULTS.gemmaModel)
  const [gemmaDtype, setGemmaDtype] = useState<string>(DEFAULTS.gemmaDtype)
  const [googleModel, setGoogleModel] = useState<string>(DEFAULTS.googleModel)
  const [embedProgress, setEmbedProgress] = useState<OverallProgress | null>(null)
  const [perBackendProgress, setPerBackendProgress] = useState<BackendProgress[]>([])
  const [hnswProgress, setHnswProgress] = useState<HnswProgress | null>(null)
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null)
  const [actionBusy, setActionBusy] = useState<boolean>(false)
  const [keyStatus, setKeyStatus] = useState<{ deepinfra: boolean; google: boolean }>({ deepinfra: false, google: false })

  useEffect(() => {
    if (!open || !isActive) return
    const readSetting = (key: string): string | null => {
      try {
        return window.api.getSetting(key)
      } catch {
        return null
      }
    }

    const nextBackend = (readSetting('embedding_backend') as BackendId | null) || DEFAULTS.backend
    setBackend(nextBackend)
    setMultiModel(readSetting('embedding_multi_model') === '1')
    setIncludeDeepinfra((readSetting('enable_model_deepinfra') ?? '1') !== '0')
    setIncludeGoogle((readSetting('enable_model_google') ?? '1') !== '0')
    setIncludeGemma((readSetting('enable_model_gemma') ?? '1') !== '0')
    setDeepinfraModel(readSetting('deepinfra_embed_model') || DEFAULTS.deepinfraModel)
    setDeepinfraDims(readSetting('deepinfra_embed_dims') || DEFAULTS.deepinfraDims)
    setGemmaModel(readSetting('gemma_model_id') || DEFAULTS.gemmaModel)
    setGemmaDtype(readSetting('gemma_dtype') || DEFAULTS.gemmaDtype)
    setGoogleModel(readSetting('google_embed_model') || DEFAULTS.googleModel)
    setKeyStatus({
      deepinfra: Boolean(readSetting('deepinfra_api_key')),
      google: Boolean(readSetting('google_api_key')),
    })
  }, [open, isActive])

  useEffect(() => {
    if (!open || !isActive) return
    const refresh = () => {
      try {
        const progress = window.api.getEmbeddingProgress()
        setEmbedProgress(progress)
      } catch {
        setEmbedProgress(null)
      }
      try {
        const per = window.api.getEmbeddingProgressAll?.()
        if (Array.isArray(per)) {
          setPerBackendProgress(per as BackendProgress[])
        }
      } catch {
        setPerBackendProgress([])
      }
      try {
        const hp = window.api.getHnswBuildStatus?.()
        if (hp) setHnswProgress(hp)
      } catch {
        setHnswProgress(null)
      }
    }
    refresh()
    const id = window.setInterval(refresh, 1200)
    return () => window.clearInterval(id)
  }, [open, isActive])

  const jobStatus = useMemo(() => {
    if (!embedProgress) return { label: 'No recent activity', tone: 'muted' as const }
    if (embedProgress.errors > 0) return { label: 'Needs attention', tone: 'error' as const }
    if (embedProgress.pending > 0) return { label: 'Processing notes', tone: 'info' as const }
    if (embedProgress.total > 0 && embedProgress.embedded >= embedProgress.total) {
      return { label: 'Library fully indexed', tone: 'success' as const }
    }
    return { label: 'Idle', tone: 'muted' as const }
  }, [embedProgress])

  const saveSetting = (key: string, value: string) => {
    try {
      window.api.setSetting(key, value)
    } catch {
      setFeedback({ tone: 'error', message: `Failed to persist ${key}` })
    }
  }

  const runAction = async (action: () => Promise<unknown>, messages: { start: string; success: string; error: string }) => {
    setActionBusy(true)
    setFeedback({ tone: 'info', message: messages.start })
    try {
      await action()
      setFeedback({ tone: 'success', message: messages.success })
    } catch (err) {
      setFeedback({ tone: 'error', message: `${messages.error}: ${getErrorMessage(err)}` })
    } finally {
      setActionBusy(false)
    }
  }

  const handleBackendChange = (next: BackendId) => {
    setBackend(next)
    saveSetting('embedding_backend', next)
  }

  const handleMultiModelToggle = (next: boolean) => {
    setMultiModel(next)
    saveSetting('embedding_multi_model', next ? '1' : '0')
  }

  const perBackendById = useMemo(() => {
    const map = new Map<BackendId, BackendProgress>()
    for (const entry of perBackendProgress) {
      map.set(entry.backend, entry)
    }
    return map
  }, [perBackendProgress])

  const overallPct = pct(embedProgress?.embedded ?? 0, embedProgress?.total ?? 0)

  const renderKeyStatus = (id: BackendId) => {
    if (id === 'gemma') {
      return <div className="text-[11px] text-muted-foreground">Downloads on demand. No key needed.</div>
    }
    const missing = id === 'deepinfra' ? !keyStatus.deepinfra : !keyStatus.google
    if (missing) {
      return (
        <div className="flex items-center justify-between gap-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-600">
          <span>API key missing</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto px-1 py-0 text-xs"
            onClick={() => onNavigateTab('api')}
          >
            Open API tab
          </Button>
        </div>
      )
    }
    return <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-600">API key connected</div>
  }

  const renderBackendCard = (id: BackendId) => {
    const meta = BACKENDS[id]
    const isActive = backend === id
    const includeState = id === 'deepinfra' ? includeDeepinfra : id === 'google' ? includeGoogle : includeGemma
    const onIncludeToggle = (next: boolean) => {
      if (id === 'deepinfra') {
        setIncludeDeepinfra(next)
        saveSetting('enable_model_deepinfra', next ? '1' : '0')
      } else if (id === 'google') {
        setIncludeGoogle(next)
        saveSetting('enable_model_google', next ? '1' : '0')
      } else {
        setIncludeGemma(next)
        saveSetting('enable_model_gemma', next ? '1' : '0')
      }
    }

    const progress = perBackendById.get(id)
    const progressPct = pct(progress?.embedded ?? 0, progress?.total ?? 0)

    return (
      <div
        key={id}
        className={`flex flex-col gap-3 rounded-md border bg-background p-3 text-xs shadow-sm transition-colors ${isActive ? 'border-blue-400 ring-1 ring-blue-200' : 'border-border'}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="truncate text-sm font-semibold text-foreground">{meta.title}</div>
            <div className="text-[11px] leading-snug text-muted-foreground">{meta.blurb}</div>
          </div>
          <div className="shrink-0">
            {isActive ? (
              <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">Default</span>
            ) : (
              <Button size="sm" variant="outline" className="text-[11px]" onClick={() => handleBackendChange(id)}>
                Set default
              </Button>
            )}
          </div>
        </div>
        <div className="grid gap-2">
          {id === 'deepinfra' && (
            <>
              <label className="block text-[11px] font-medium text-muted-foreground">Model ID</label>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={deepinfraModel}
                onChange={(e) => {
                  const value = e.target.value
                  setDeepinfraModel(value)
                  saveSetting('deepinfra_embed_model', value)
                }}
              />
              <label className="block text-[11px] font-medium text-muted-foreground">Embedding dimensions</label>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={deepinfraDims}
                onChange={(e) => {
                  const value = e.target.value
                  setDeepinfraDims(value)
                  saveSetting('deepinfra_embed_dims', value)
                }}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => runAction(() => window.api.startEmbedding(true), {
                    start: `Scheduling full rebuild for ${meta.title}…`,
                    success: `${meta.title} rebuild queued.`,
                    error: `Unable to rebuild ${meta.title}`,
                  })}
                  disabled={actionBusy}
                >
                  Rebuild vectors
                </Button>
              </div>
            </>
          )}
          {id === 'google' && (
            <>
              <label className="block text-[11px] font-medium text-muted-foreground">Model ID</label>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={googleModel}
                onChange={(e) => {
                  const value = e.target.value
                  setGoogleModel(value)
                  saveSetting('google_embed_model', value)
                }}
              />
              <div className="text-[11px] text-muted-foreground leading-snug">Dimensionality fixed at 3072. Detected automatically.</div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => runAction(() => window.api.startEmbedding(true), {
                    start: `Scheduling full rebuild for ${meta.title}…`,
                    success: `${meta.title} rebuild queued.`,
                    error: `Unable to rebuild ${meta.title}`,
                  })}
                  disabled={actionBusy}
                >
                  Rebuild vectors
                </Button>
              </div>
            </>
          )}
          {id === 'gemma' && (
            <>
              <label className="block text-[11px] font-medium text-muted-foreground">Model</label>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={gemmaModel}
                onChange={(e) => {
                  const value = e.target.value
                  setGemmaModel(value)
                  saveSetting('gemma_model_id', value)
                }}
              />
              <label className="block text-[11px] font-medium text-muted-foreground">Local dtype</label>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={gemmaDtype}
                onChange={(e) => {
                  const value = e.target.value
                  setGemmaDtype(value)
                  saveSetting('gemma_dtype', value)
                }}
              >
                <option value="q4">q4 (fastest)</option>
                <option value="q8">q8</option>
                <option value="fp32">fp32</option>
              </select>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => runAction(() => window.api.startEmbedding(true), {
                    start: `Scheduling full rebuild for ${meta.title}…`,
                    success: `${meta.title} rebuild queued.`,
                    error: `Unable to rebuild ${meta.title}`,
                  })}
                  disabled={actionBusy}
                >
                  Rebuild vectors
                </Button>
              </div>
            </>
          )}
        </div>
        <div className="flex flex-col gap-2 text-[11px]">
          {renderKeyStatus(id)}
          <div className="rounded border border-dashed px-2 py-2">
            <div className="flex items-center justify-between text-[11px] font-medium">
              <span>Queue status</span>
              <span>{progress ? `${progress.embedded}/${progress.total}` : '—'}</span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
              <div className={`h-2 ${PROGRESS_COLORS[id]}`} style={{ width: `${progressPct}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Pending: {progress ? formatNumber(progress.pending) : '—'} • Errors: {progress ? formatNumber(progress.errors) : '—'}
            </div>
            <div className="text-[11px] text-muted-foreground">Rate: {progress ? formatRate(progress.rate) : '—'} • ETA: {progress ? formatEta(progress.etaSeconds) : '—'}</div>
          </div>
          <label className={`flex items-center justify-between gap-3 rounded border px-2 py-1 ${multiModel ? 'opacity-100' : 'opacity-60'}`}>
            <span className="text-[11px] font-medium text-muted-foreground">Include in multi-model search</span>
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={includeState}
              onChange={(e) => onIncludeToggle(e.target.checked)}
              disabled={!multiModel}
            />
          </label>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden text-sm">
      <section className="flex-0 rounded-md border bg-background p-3 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Embedding orchestration</h2>
            <p className="text-[11px] leading-snug text-muted-foreground">Choose the default backend for indexing and control how multi-model search is assembled.</p>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_STYLES[jobStatus.tone]}`}>
            {jobStatus.label}
          </span>
        </div>
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Default backend</label>
            <select
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              value={backend}
              onChange={(e) => handleBackendChange(e.target.value as BackendId)}
            >
              <option value="deepinfra">DeepInfra (cloud)</option>
              <option value="google">Google Gemini</option>
              <option value="gemma">Local Gemma</option>
            </select>
            <p className="text-[11px] leading-snug text-muted-foreground">Used for builds/rebuilds. Queries can still blend models below.</p>
          </div>
          <label className="flex items-start justify-between gap-3 rounded border px-3 py-2">
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">Multi-model aggregation</div>
              <div className="text-[11px] leading-snug text-muted-foreground">Average vectors across enabled backends when answering queries.</div>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={multiModel}
              onChange={(e) => handleMultiModelToggle(e.target.checked)}
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
            <span>Embedding worker</span>
            <Button
              size="sm"
              variant={embedProgress && embedProgress.pending > 0 ? 'default' : 'outline'}
              onClick={async () => {
                if (embedProgress && embedProgress.pending > 0) {
                  await runAction(() => window.api.stopEmbedding(), {
                    start: 'Stopping worker…',
                    success: 'Embedding worker stopped.',
                    error: 'Unable to stop embeddings',
                  })
                } else {
                  await runAction(() => window.api.startEmbedding(false), {
                    start: 'Starting worker…',
                    success: 'Embedding worker running.',
                    error: 'Unable to start embeddings',
                  })
                }
              }}
              disabled={actionBusy}
            >
              {embedProgress && embedProgress.pending > 0 ? 'Stop' : 'Start'}
            </Button>
          </label>
        </div>
        {feedback && (
          <div className={`mt-2 text-[11px] font-medium ${feedback.tone === 'error' ? 'text-red-600' : feedback.tone === 'success' ? 'text-emerald-600' : 'text-blue-600'}`}>
            {feedback.message}
          </div>
        )}
      </section>

      <section className="flex-1 overflow-auto rounded-md border bg-background p-3 shadow-sm">
        <h3 className="text-sm font-semibold text-foreground">Backends</h3>
        <p className="text-[11px] text-muted-foreground">Fine-tune each pipeline. Changes save automatically.</p>
        <div className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] pb-2">
          {BACKEND_ORDER.map((id) => renderBackendCard(id))}
        </div>
      </section>

      <section className="rounded-md border bg-background p-3 shadow-sm">
        <h3 className="text-sm font-semibold text-foreground">Queue insight</h3>
        <p className="text-[11px] text-muted-foreground">Monitor overall and per-backend progress.</p>
        <div className="mt-3 space-y-3">
          <div className="rounded border border-dashed p-3">
            <div className="flex items-center justify-between text-sm font-medium text-foreground">
              <span>Library coverage</span>
              <span>{formatNumber(embedProgress?.embedded ?? 0)}/{formatNumber(embedProgress?.total ?? 0)} ({overallPct}%)</span>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded bg-muted">
              <div className={`h-2 ${PROGRESS_COLORS.overall}`} style={{ width: `${overallPct}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span>Pending: {formatNumber(embedProgress?.pending ?? 0)}</span>
              <span>Errors: {formatNumber(embedProgress?.errors ?? 0)}</span>
              <span>Rate: {formatRate(embedProgress?.rate ?? 0)}</span>
              <span>ETA: {formatEta(embedProgress?.etaSeconds)}</span>
            </div>
          </div>

          {perBackendProgress.length > 0 ? (
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
              {BACKEND_ORDER.map((id) => {
                const progress = perBackendById.get(id)
                if (!progress) return (
                  <div key={`empty-${id}`} className="rounded border border-dashed p-3 text-[11px] text-muted-foreground">
                    <div className="font-medium text-foreground">{BACKENDS[id].title}</div>
                    <div>No runs recorded yet.</div>
                  </div>
                )
                const progressPct = pct(progress.embedded, progress.total)
                return (
                  <div key={id} className="rounded border p-3 text-xs shadow-sm">
                    <div className="flex items-center justify-between text-sm font-medium text-foreground">
                      <span>{BACKENDS[id].title}</span>
                      <span>{progress.embedded}/{progress.total} ({progressPct}%)</span>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
                      <div className={`h-2 ${PROGRESS_COLORS[id]}`} style={{ width: `${progressPct}%` }} />
                    </div>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Pending: {formatNumber(progress.pending)} • Errors: {formatNumber(progress.errors)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">Rate: {formatRate(progress.rate)} • ETA: {formatEta(progress.etaSeconds)}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">Model: {progress.model}</div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="rounded border border-dashed p-3 text-[11px] text-muted-foreground">No per-backend progress data yet. Start an embedding run to populate metrics.</div>
          )}

          {hnswProgress && (
            <div className="rounded border border-dashed p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">HNSW vector index</div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">{hnswProgress.running ? 'Building…' : 'Idle'}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionBusy}
                    onClick={() =>
                      runAction(
                        async () => {
                          if (!window.api.buildVectorIndexHNSW) {
                            throw new Error('HNSW rebuild is not available in this build')
                          }
                          await window.api.buildVectorIndexHNSW()
                        },
                        {
                          start: 'Launching HNSW rebuild…',
                          success: 'HNSW rebuild started.',
                          error: 'Unable to rebuild HNSW index',
                        },
                      )
                    }
                  >
                    Rebuild index
                  </Button>
                </div>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded bg-muted">
                <div className="h-2 bg-teal-500" style={{ width: `${pct(hnswProgress.processed, hnswProgress.total)}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span>Processed: {formatNumber(hnswProgress.processed)}/{formatNumber(hnswProgress.total)}</span>
                <span>Errors: {formatNumber(hnswProgress.errors)}</span>
                <span>ETA: {formatEta(hnswProgress.etaSeconds)}</span>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
