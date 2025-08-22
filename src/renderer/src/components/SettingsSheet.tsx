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
  const [instruction, setInstruction] = useState<string>('Given a search query, retrieve relevant anki cards.')
  const [embedProgress, setEmbedProgress] = useState<{ total: number; embedded: number; pending: number; errors: number; rate: number; etaSeconds: number } | null>(null)
  const [activeTab, setActiveTab] = useState<string>('general')

  useEffect(() => {
    if (!open) return
    try {
      const k = window.api.getSetting('deepinfra_api_key') || ''
      setApiKey(k)
      const instr = window.api.getSetting('deepinfra_instruction') || 'Given a search query, retrieve relevant anki cards.'
      setInstruction(instr)
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
            <label className="text-sm font-medium mt-4 block">Reranker Instruction</label>
            <textarea
              className="px-3 py-2 rounded-md bg-background border w-full h-20"
              value={instruction}
              onChange={(e) => {
                const v = e.target.value
                setInstruction(v)
                try { window.api.setSetting('deepinfra_instruction', v) } catch { /* ignore */ }
              }}
            />
            <div className="text-xs text-muted-foreground">
              Default: "Given a search query, retrieve relevant anki cards." This is sent as the `instruction` to the reranker API to guide scoring.
            </div>
          </TabsContent>
          <TabsContent value="embeddings" className="mt-4 space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">Model</label>
                <input
                  className="px-3 py-2 rounded-md bg-background border w-full"
                  value={window.api.getSetting('deepinfra_embed_model') || 'Qwen/Qwen3-Embedding-8B'}
                  onChange={(e) => window.api.setSetting('deepinfra_embed_model', e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Dimensions</label>
                <input
                  className="px-3 py-2 rounded-md bg-background border w-full"
                  value={window.api.getSetting('deepinfra_embed_dims') || '8192'}
                  onChange={(e) => window.api.setSetting('deepinfra_embed_dims', e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
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
                    </div>
                  )
                })()
              ) : (
                <div>Progress unavailable</div>
              )}
            </div>
          </TabsContent>
        </Tabs>
        <div className="pt-2">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}


