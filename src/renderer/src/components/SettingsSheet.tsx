import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmbeddingsPanel } from '@/components/embeddings/EmbeddingsPanel'

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
  const [activeTab, setActiveTab] = useState<string>('general')
  const [googleKey, setGoogleKey] = useState<string>('')

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
      setGoogleKey(window.api.getSetting('google_api_key') || '')
    } catch {
      // ignore
    }
  }, [open, activeTab])
  const canSync = useMemo(() => query.length > 0, [query])
  return (
    <div className="fixed inset-0 z-50 grid grid-cols-[1fr_400px]">
      <div className="bg-black/40" onClick={onClose} />
      <div className="bg-background border-l h-full overflow-y-auto p-4 pr-3 space-y-4">
        <div className="text-lg font-semibold sticky top-0 z-10 -mx-4 -mr-3 px-4 pr-3 pb-2 bg-background">Settings</div>
        <Tabs value={activeTab} className="w-full" onValueChange={setActiveTab}>
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
            <label className="text-sm font-medium mt-4 block">Google API Key</label>
            <input
              className="px-3 py-2 rounded-md bg-background border w-full"
              value={googleKey}
              onChange={(e) => { const v = e.target.value; setGoogleKey(v); try { window.api.setSetting('google_api_key', v) } catch {} }}
              placeholder="AIza..."
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
          <TabsContent value="embeddings" className="mt-4">
            <EmbeddingsPanel open={open} isActive={activeTab === 'embeddings'} onNavigateTab={setActiveTab} />
          </TabsContent>
        </Tabs>
        <div className="pt-2">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
