/**
 * SaveSystem — client-side save/load helpers. THE gap fix: the original
 * C++ SaveSystem wrote to a non-existent `saves/` directory, was never
 * called from anywhere in the game, and had no load path at all. This
 * module wires persistence into the real stack:
 *
 *   saveGame(engine, slot)      → engine.buildSavePayload() → POST /api/saves
 *                                 (Prisma/SQLite) + localStorage mirror
 *                                 `ow_save_${slot}` for offline fallback.
 *   loadSlots()                 → GET /api/saves (falls back to the
 *                                 localStorage mirror when the API fails).
 *   loadSlot(engine, slot)      → fetches one slot → engine.applySavePayload.
 *   scheduleAutosave(...)       → repeating timer → saveGame (quiet).
 *
 * All functions are browser-only (fetch + localStorage) and never throw —
 * they resolve to result objects so UI callers can surface errors safely.
 */
import type { IGameEngine, SaveGamePayload, SaveGameRecord } from '@/game/types'

const LS_PREFIX = 'ow_save_'
export const SAVE_SLOT_MIN = 1
export const SAVE_SLOT_MAX = 9
export const AUTOSAVE_INTERVAL_MS = 30_000

export interface SaveResult {
  ok: boolean
  payload: SaveGamePayload | null
  /** Set when the server POST failed (the localStorage mirror still kept it). */
  serverError?: string
}

export interface LoadSlotResult {
  ok: boolean
  payload: SaveGamePayload | null
  error?: string
}

/** Narrow structural view of the engine's notify() (beyond IGameEngine). */
type Notifier = {
  notify?: (text: string, kind?: 'info' | 'success' | 'warning' | 'danger') => void
}

function notify(engine: IGameEngine, text: string, kind: 'success' | 'warning' = 'success'): void {
  ;(engine as unknown as Notifier).notify?.(text, kind)
}

function clampSlot(slot: number): number {
  if (!Number.isFinite(slot)) return 1
  return Math.max(SAVE_SLOT_MIN, Math.min(SAVE_SLOT_MAX, Math.round(slot)))
}

// ---------------------------------------------------------------------
// localStorage mirror
// ---------------------------------------------------------------------

/** Read the offline mirror of a slot (or null). Safe outside the browser. */
export function readLocalSlot(slot: number): SaveGamePayload | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(LS_PREFIX + clampSlot(slot))
    if (!raw) return null
    const data = JSON.parse(raw) as SaveGamePayload
    if (!data || typeof data.slot !== 'number') return null
    return data
  } catch {
    return null
  }
}

function writeLocalSlot(slot: number, payload: SaveGamePayload): boolean {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return false
  try {
    localStorage.setItem(LS_PREFIX + slot, JSON.stringify(payload))
    return true
  } catch {
    return false // private mode / quota — the server copy is the real save.
  }
}

function localSlotToRecord(payload: SaveGamePayload): SaveGameRecord {
  const when = payload.savedAt ?? new Date(0).toISOString()
  return { ...payload, id: `local_${payload.slot}`, createdAt: when, updatedAt: when }
}

/** Delete the offline mirror of a slot (server copy untouched). */
export function clearLocalSlot(slot: number): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(LS_PREFIX + clampSlot(slot))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Persist the engine snapshot to `slot` (1..9): server first
 * (POST /api/saves → Prisma), localStorage mirror second. Never throws.
 */
export async function saveGame(
  engine: IGameEngine,
  slot: number,
  opts?: { quiet?: boolean },
): Promise<SaveResult> {
  const quiet = opts?.quiet ?? false
  const slotNo = clampSlot(slot)

  // 1. Snapshot the live engine.
  let payload: SaveGamePayload
  try {
    payload = engine.buildSavePayload()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (!quiet) notify(engine, `Save failed — ${error}`, 'warning')
    return { ok: false, payload: null, serverError: error }
  }
  payload.slot = slotNo
  payload.savedAt = new Date().toISOString()

  // 2. localStorage mirror (offline fallback for loadSlot/loadSlots).
  const mirrored = writeLocalSlot(slotNo, payload)

  // 3. Server copy.
  let serverError: string | undefined
  try {
    const res = await fetch('/api/saves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      serverError = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string; detail?: string }
        if (body?.error) serverError = body.detail ? `${body.error}: ${body.detail}` : body.error
      } catch {
        /* non-JSON error body */
      }
    }
  } catch (err) {
    serverError = err instanceof Error ? err.message : String(err)
  }

  if (serverError) {
    if (!quiet) {
      notify(
        engine,
        mirrored ? `Saved locally (slot ${slotNo}) — server: ${serverError}` : `Save failed — ${serverError}`,
        'warning',
      )
    }
    return { ok: false, payload, serverError }
  }

  if (!quiet) notify(engine, `Game saved — slot ${slotNo}`, 'success')
  return { ok: true, payload }
}

/**
 * List all save slots. GET /api/saves first; on any failure, fall back to
 * the localStorage mirrors (records tagged `local_${slot}`). Never throws.
 */
export async function loadSlots(): Promise<SaveGameRecord[]> {
  try {
    const res = await fetch('/api/saves')
    if (res.ok) {
      const body = (await res.json()) as { saves?: SaveGameRecord[] }
      if (Array.isArray(body.saves)) return body.saves
    }
  } catch {
    /* fall through to localStorage */
  }
  const local: SaveGameRecord[] = []
  for (let slot = SAVE_SLOT_MIN; slot <= SAVE_SLOT_MAX; slot++) {
    const payload = readLocalSlot(slot)
    if (payload) local.push(localSlotToRecord(payload))
  }
  return local
}

/**
 * Load `slot` into the LIVE engine: server first
 * (GET /api/saves?slot=N), localStorage mirror second, then
 * engine.applySavePayload (level swap + player + system fragments).
 * Never throws.
 */
export async function loadSlot(
  engine: IGameEngine,
  slot: number,
  opts?: { quiet?: boolean },
): Promise<LoadSlotResult> {
  const quiet = opts?.quiet ?? false
  const slotNo = clampSlot(slot)

  let payload: SaveGamePayload | null = null
  let error: string | undefined

  try {
    const res = await fetch(`/api/saves?slot=${slotNo}`)
    if (res.ok) {
      const body = (await res.json()) as { save: SaveGameRecord | null }
      payload = body.save ?? null
    } else {
      error = `HTTP ${res.status}`
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  if (!payload) payload = readLocalSlot(slotNo)

  if (!payload) {
    const msg = error ? `Slot ${slotNo} empty (server: ${error})` : `Slot ${slotNo} is empty`
    if (!quiet) notify(engine, msg, 'warning')
    return { ok: false, payload: null, error: msg }
  }

  try {
    engine.applySavePayload(payload) // notifies "Save loaded" internally
    return { ok: true, payload }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!quiet) notify(engine, `Load failed — ${msg}`, 'warning')
    return { ok: false, payload, error: msg }
  }
}

/**
 * Autosave loop: fire-and-forget quiet saves every `intervalMs`
 * (default 30 s). Returns a stop function.
 */
export function scheduleAutosave(
  engine: IGameEngine,
  slot: number,
  intervalMs = AUTOSAVE_INTERVAL_MS,
): () => void {
  const interval = Math.max(5_000, intervalMs)
  const timer = setInterval(() => {
    void saveGame(engine, slot, { quiet: true })
  }, interval)
  return () => clearInterval(timer)
}
