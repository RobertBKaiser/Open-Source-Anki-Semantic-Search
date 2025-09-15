import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type SettingsSheetProps = {
  open: boolean
  onClose: () => void
}

async function runSyncViaIngest(query: string): Promise<string> {
  const res = await window.api.runIngest(query)
  if (res.code !== 0) {
    throw new Error(res.output || `ingest exited with code ${res.code}`)
  }
  return res.output
}

export function SettingsSheet({ open, onClose }: SettingsSheetProps): React.JSX.Element | null {
  if (!open) return null
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const [query, setQuery] = useState<string>('*')
  const [apiKey, setApiKey] = useState<string>('')
  const [openaiKey, setOpenaiKey] = useState<string>('')
  const [promptUrl, setPromptUrl] = useState<string>('')
  const [kwPromptId, setKwPromptId] = useState<string>('')
  const [instructionIn, setInstructionIn] = useState<string>('Given a query document, rank cards by facts a reader would know after reading the document.')
  const [instructionOut, setInstructionOut] = useState<string>('Given a query document, rank cards by facts that are not in the document at all.')
  const [instructionRelated, setInstructionRelated] = useState<string>('Given a query document, rank cards by facts and ideas not explicitly stated but closely related to the document.')
  const [embedProgress, setEmbedProgress] = useState<{ total: number; embedded: number; pending: number; errors: number; rate: number; etaSeconds: number } | null>(null)
  const [activeTab, setActiveTab] = useState<string>('general')
  const [embedActionMsg, setEmbedActionMsg] = useState<string>('')
  const [runningAction, setRunningAction] = useState<boolean>(false)
  const [hnswProgress, setHnswProgress] = useState<{ running: boolean; total: number; processed: number; errors: number; startedAt?: number; etaSeconds?: number } | null>(null)
  const [backend, setBackend] = useState<string>('deepinfra')
  const [gemmaModel, setGemmaModel] = useState<string>('onnx-community/embeddinggemma-300m-ONNX')
  const [gemmaDtype, setGemmaDtype] = useState<string>('q4')

  useEffect(() => {
    if (!open) return
    try {
      const k = window.api.getSetting('deepinfra_api_key') || ''
      setApiKey(k)
      const ok = window.api.getSetting('openai_api_key') || ''
      setOpenaiKey(ok)
      // Prefer new key 'openai_badge_prompt_id', but fall back to legacy 'openai_badge_prompt_url'
      const pu = window.api.getSetting('openai_badge_prompt_id') || window.api.getSetting('openai_badge_prompt_url') || ''
      setPromptUrl(pu)
      const kp = window.api.getSetting('openai_kw_prompt_id') || 'pmpt_68b5ad09507c8195999c456bd50afd3809e0e005559ce008'
      setKwPromptId(kp)
      const instrIn = window.api.getSetting('deepinfra_instruction_facts_in_query') || 'Given a query document, rank cards by facts a reader would know after reading the document.'
      const instrOut = window.api.getSetting('deepinfra_instruction_not_in_query') || 'Given a query document, rank cards by facts that are not in the document at all.'
      const instrRel = window.api.getSetting('deepinfra_instruction_related') || 'Given a query document, rank cards by facts and ideas not explicitly stated but closely related to the document.'
      setInstructionIn(instrIn)
      setInstructionOut(instrOut)
      setInstructionRelated(instrRel)
      const be = window.api.getSetting('embedding_backend') || 'deepinfra'
      setBackend(be)
      setGemmaModel(window.api.getSetting('gemma_model_id') || 'onnx-community/embeddinggemma-300m-ONNX')
      setGemmaDtype(window.api.getSetting('gemma_dtype') || 'q4')
      if (activeTab === 'embeddings') {
        const p = window.api.getEmbeddingProgress()
        setEmbedProgress(p)
      }
    } catch {
      // ignore
    }
  }, [open, activeTab])

  useEffect(() => {
    if (!open || activeTab !== 'embeddings') return
    const id = window.setInterval(() => {
      try {
        const p = window.api.getEmbeddingProgress()
        setEmbedProgress(p)
        const bb = window.api.getHnswBuildStatus?.()
        if (bb) setHnswProgress(bb)
      } catch {
        // ignore
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [open, activeTab])
  const canSync = useMemo(() => query.length > 0, [query])
  return (
    <div className="fixed inset-0 z-50 grid grid-cols-[1fr_400px]">
      <div className="bg-black/40" onClick={onClose} />
      <div className="bg-background border-l p-4 space-y-4">
        <div className="text-lg font-semibold">Settings</div>
        <Tabs defaultValue="general" className="w-full" onValueChange={(v) => setActiveTab(v)}>
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="sync">Sync</TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
            <TabsTrigger value="embeddings">Embeddings</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-4 space-y-2 text-sm text-muted-foreground">
            <div>General settings go here.</div>
          </TabsContent>
          <TabsContent value="sync" className="mt-4 space-y-3">
            <label className="text-sm font-medium">Query to sync</label>
            <input
              className="px-3 py-2 rounded-md bg-background border w-full"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="*"
            />
            <div className="flex items-center gap-2">
              <Button
                disabled={!canSync || syncing}
                onClick={async () => {
                  try {
                    setSyncing(true)
                    setSyncMsg('Starting ingest...')
                    const out = await runSyncViaIngest(query)
                    // Show the last few lines formatted with line breaks
                    const tail = out.split('\n').slice(-5).join('\n').trim()
                    setSyncMsg(tail || 'Ingest complete')
                  } catch (e) {
                    setSyncMsg(`Sync failed: ${(e as Error).message}`)
                  } finally {
                    setSyncing(false)
                  }
                }}
              >
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
              {syncMsg && (
                <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words max-w-full max-h-32 overflow-auto rounded border bg-muted/20 p-2">
                  {syncMsg}
                </div>
              )}
            </div>
          </TabsContent>
          <TabsContent value="api" className="mt-4 space-y-3">
            <label className="text-sm font-medium">DeepInfra API Key</label>
            <input
              className="px-3 py-2 rounded-md bg-background border w-full"
              value={apiKey}
              onChange={(e) => {
                const v = e.target.value
                setApiKey(v)
                try { window.api.setSetting('deepinfra_api_key', v) } catch { /* ignore */ }
              }}
              placeholder="sk-..."
            />
            <div className="text-xs text-muted-foreground">
              Used for reranking with Qwen3 Reranker 8B. Stored locally in `app_settings`.
            </div>
            <label className="text-sm font-medium mt-4 block">OpenAI API Key</label>
            <input
              className="px-3 py-2 rounded-md bg-background border w-full"
              value={openaiKey}
              onChange={(e) => {
                const v = e.target.value
                setOpenaiKey(v)
                try { window.api.setSetting('openai_api_key', v) } catch { /* ignore */ }
              }}
              placeholder="sk-..."
            />
            <label className="text-sm font-medium mt-2 block">Badge Prompt ID</label>
            <input
              className="px-3 py-2 rounded-md bg-background border w-full"
              value={promptUrl}
              onChange={(e) => {
                const v = e.target.value
                setPromptUrl(v)
                try { window.api.setSetting('openai_badge_prompt_id', v) } catch { /* ignore */ }
              }}
              placeholder="pmpt_..."
            />
            <label className="text-sm font-medium mt-2 block">Keyword Prompt ID</label>
            <input
              className="px-3 py-2 rounded-md bg-background border w-full"
              value={kwPromptId}
              onChange={(e) => {
                const v = e.target.value
                setKwPromptId(v)
                try { window.api.setSetting('openai_kw_prompt_id', v) } catch { /* ignore */ }
              }}
              placeholder="pmpt_..."
            />
            <div className="grid grid-cols-1 gap-3 mt-2">
              <div>
                <label className="text-sm font-medium">Instruction: Facts in query (red badge)</label>
                <textarea
                  className="px-3 py-2 rounded-md bg-background border w-full h-20"
                  value={instructionIn}
                  onChange={(e) => {
                    const v = e.target.value
                    setInstructionIn(v)
                    try { window.api.setSetting('deepinfra_instruction_facts_in_query', v) } catch { /* ignore */ }
                  }}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Instruction: Facts not in query (black badge)</label>
                <textarea
                  className="px-3 py-2 rounded-md bg-background border w-full h-20"
                  value={instructionOut}
                  onChange={(e) => {
                    const v = e.target.value
                    setInstructionOut(v)
                    try { window.api.setSetting('deepinfra_instruction_not_in_query', v) } catch { /* ignore */ }
                  }}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Instruction: Closely related (blue badge)</label>
                <textarea
                  className="px-3 py-2 rounded-md bg-background border w-full h-20"
                  value={instructionRelated}
                  onChange={(e) => {
                    const v = e.target.value
                    setInstructionRelated(v)
                    try { window.api.setSetting('deepinfra_instruction_related', v) } catch { /* ignore */ }
                  }}
                />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="embeddings" className="mt-4 space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">Backend</label>
                <select
                  className="px-3 py-2 rounded-md bg-background border w-full"
                  value={backend}
                  onChange={(e) => {
                    const v = e.target.value
                    setBackend(v)
                    try { window.api.setSetting('embedding_backend', v) } catch {}
                  }}
                >
                  <option value="deepinfra">DeepInfra (Qwen3 API)</option>
                  <option value="gemma">Local (EmbeddingGemma)</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">Model</label>
                {backend === 'deepinfra' ? (
                  <input
                    className="px-3 py-2 rounded-md bg-background border w-full"
                    value={window.api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'}
                    onChange={(e) => window.api.setSetting('deepinfra_embed_model', e.target.value)}
                  />
                ) : (
                  <input
                    className="px-3 py-2 rounded-md bg-background border w-full"
                    value={gemmaModel}
                    onChange={(e) => { setGemmaModel(e.target.value); try { window.api.setSetting('gemma_model_id', e.target.value) } catch {} }}
                    placeholder="onnx-community/embeddinggemma-300m-ONNX"
                  />
                )}
              </div>
              <div>
                {backend === 'deepinfra' ? (
                  <>
                    <label className="text-sm font-medium">Dimensions</label>
                    <input
                      className="px-3 py-2 rounded-md bg-background border w-full"
                      value={window.api.getSetting('deepinfra_embed_dims') || '4096'}
                      onChange={(e) => window.api.setSetting('deepinfra_embed_dims', e.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <label className="text-sm font-medium">Local dtype</label>
                    <select
                      className="px-3 py-2 rounded-md bg-background border w-full"
                      value={gemmaDtype}
                      onChange={(e) => { setGemmaDtype(e.target.value); try { window.api.setSetting('gemma_dtype', e.target.value) } catch {} }}
                    >
                      <option value="q4">q4 (fastest)</option>
                      <option value="q8">q8</option>
                      <option value="fp32">fp32</option>
                    </select>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className="text-[12px] rounded-md px-2 py-1 bg-blue-600 text-white hover:bg-blue-700"
                onClick={async () => {
                  try { await window.api.startEmbedding(false) } catch {}
                }}
              >
                Start
              </button>
              <button
                className="text-[12px] rounded-md px-2 py-1 bg-amber-600 text-white hover:bg-amber-700"
                onClick={async () => { try { await window.api.stopEmbedding() } catch {} }}
              >
                Pause
              </button>
              <button
                className="text-[12px] rounded-md px-2 py-1 bg-red-600 text-white hover:bg-red-700"
                onClick={async () => { try { await window.api.startEmbedding(true) } catch {} }}
              >
                Rebuild All
              </button>
              {/* Removed migrate/build buttons per request */}
            </div>
            <div className="rounded border p-2 text-xs text-muted-foreground">
              {embedProgress ? (
                (() => {
                  const p = embedProgress
                  const pct = p.total ? Math.round((p.embedded / p.total) * 100) : 0
                  const eta = p.etaSeconds ? `${Math.floor(p.etaSeconds/60)}m ${p.etaSeconds%60}s` : '—'
                  return (
                    <div className="space-y-2">
                      <div className="w-full h-2 bg-muted rounded overflow-hidden">
                        <div className="h-2 bg-blue-600" style={{ width: `${pct}%` }} />
                      </div>
                      <div>Progress: {p.embedded}/{p.total} ({pct}%)</div>
                      <div>Pending: {p.pending} • Errors: {p.errors}</div>
                      <div>Rate: {p.rate.toFixed(2)} notes/sec • ETA: {eta}</div>
                      {embedActionMsg && (<div className="pt-1 text-foreground">{embedActionMsg}</div>)}
                      {hnswProgress && (
                        (() => {
                          const hp = hnswProgress
                          const pct2 = hp.total ? Math.round((hp.processed / hp.total) * 100) : 0
                          const eta2 = (hp.etaSeconds && hp.running) ? `${Math.floor(hp.etaSeconds/60)}m ${hp.etaSeconds%60}s` : '—'
                          return (
                            <div className="mt-2 border-t pt-2">
                              <div className="font-medium text-foreground">HNSW Build {hp.running ? '(running)' : ''}</div>
                              <div className="w-full h-2 bg-muted rounded overflow-hidden">
                                <div className="h-2 bg-teal-600" style={{ width: `${pct2}%` }} />
                              </div>
                              <div>Processed: {hp.processed}/{hp.total} ({pct2}%) • Errors: {hp.errors} • ETA: {eta2}</div>
                            </div>
                          )
                        })()
                      )}
                    </div>
                  )
                })()
              ) : (
                <div>Progress unavailable</div>
              )}
            </div>
            {/* Precompute UI removed per request; only HNSW index remains */}
          </TabsContent>
        </Tabs>
        <div className="pt-2">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
