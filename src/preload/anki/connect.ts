export async function pingAnkiConnect(): Promise<{ ok: boolean; version?: number; error?: string }>{
  try {
    const res = await fetch('http://127.0.0.1:8765', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'version', version: 6 }) })
    const json = (await res.json()) as { result?: number; error?: string }
    if (json?.result && !json.error) return { ok: true, version: json.result }
    return { ok: false, error: json?.error || 'Unknown response' }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function openInAnki(noteId: number): Promise<{ ok: boolean; error?: string }>{
  try {
    const res = await fetch('http://127.0.0.1:8765', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'guiBrowse', version: 6, params: { query: `nid:${noteId}` } }) })
    const json = (await res.json()) as { result?: any; error?: string }
    if (json?.error) return { ok: false, error: json.error }
    return { ok: true }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function unsuspendNotes(noteIds: number[]): Promise<{ ok: boolean; changed: number; error?: string }>{
  try {
    if (!Array.isArray(noteIds) || noteIds.length === 0) return { ok: true, changed: 0 }
    const q = noteIds.map((id) => `nid:${id}`).join(' or ')
    const resFind = await fetch('http://127.0.0.1:8765', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'findCards', version: 6, params: { query: q } }) })
    const jsonFind = (await resFind.json()) as { result?: number[]; error?: string }
    if (!jsonFind || jsonFind.error) return { ok: false, changed: 0, error: jsonFind?.error || 'findCards failed' }
    const cardIds = jsonFind.result || []
    if (cardIds.length === 0) return { ok: true, changed: 0 }
    const resBefore = await fetch('http://127.0.0.1:8765', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'areSuspended', version: 6, params: { cards: cardIds } }) })
    const jsonBefore = (await resBefore.json()) as { result?: boolean[]; error?: string }
    if (jsonBefore?.error) return { ok: false, changed: 0, error: jsonBefore.error }
    const before = Array.isArray(jsonBefore?.result) ? jsonBefore.result : []
    const resUnsuspend = await fetch('http://127.0.0.1:8765', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unsuspend', version: 6, params: { cards: cardIds } }) })
    const jsonUnsuspend = (await resUnsuspend.json()) as { result?: boolean; error?: string }
    if (jsonUnsuspend?.error) return { ok: false, changed: 0, error: jsonUnsuspend.error }
    const resAfter = await fetch('http://127.0.0.1:8765', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'areSuspended', version: 6, params: { cards: cardIds } }) })
    const jsonAfter = (await resAfter.json()) as { result?: boolean[]; error?: string }
    if (jsonAfter?.error) return { ok: false, changed: 0, error: jsonAfter.error }
    const after = Array.isArray(jsonAfter?.result) ? jsonAfter.result : []
    let changed = 0
    for (let i = 0; i < Math.min(before.length, after.length); i++) { if (before[i] === true && after[i] === false) changed++ }
    return { ok: true, changed }
  } catch (e) { return { ok: false, changed: 0, error: (e as Error).message } }
}


