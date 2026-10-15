'use client'
/**
 * UI-facing game state store. The imperative engine publishes HudState
 * snapshots at ~10Hz via engine.onHudSync → setHud. React components
 * read selectors from here — they never touch Three.js directly.
 *
 * Task 2-c extensions: persisted settings (`ow_settings` in localStorage),
 * a NON-REACTIVE engine holder (engineRef — storing the engine in zustand
 * would re-render subscribers on every assignment and leak the THREE
 * scene graph into React's diff), active save slot, leaderboard, big-map
 * waypoint, WASTED/BUSTED/campaign overlays, damage-flash + mission
 * flourish triggers, and the engine boot status machine.
 */
import { create } from 'zustand'
import type { ContentBundle, HudState, SaveGameRecord, Vec3 } from './types'
// Type-only import — erased at compile time, so three.js NEVER enters the
// SSR/landing bundle via this store.
import type { GameEngine } from './engine'

// ---------------------------------------------------------------------
// Settings (persisted to localStorage as `ow_settings`)
// ---------------------------------------------------------------------

export interface GameSettings {
  /** 0..1 master bus gain */
  masterVolume: number
  /** 0..1 music bus gain */
  musicVolume: number
  /** 0..1 sfx bus gain */
  sfxVolume: number
  /** look sensitivity multiplier (0.25..2) */
  mouseSensitivity: number
  /** show the FPS chip on the HUD */
  showFps: boolean
  /** minimap rotates with the player (true) or stays north-up (false) */
  minimapRotate: boolean
  /** low-end GPU mode: pixel ratio 1, no shadows, half the street lamps */
  performanceMode: boolean
  /** Radio station index (RADIO_STATIONS), −1 = radio OFF. */
  radioStation: number
}

export const DEFAULT_SETTINGS: GameSettings = {
  masterVolume: 0.8,
  musicVolume: 0.35,
  sfxVolume: 0.9,
  mouseSensitivity: 1,
  showFps: false,
  minimapRotate: true,
  performanceMode: false,
  radioStation: 0,
}

export const SETTINGS_STORAGE_KEY = 'ow_settings'

/** Read persisted settings (client only; returns {} when absent/corrupt). */
export function loadPersistedSettings(): Partial<GameSettings> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<GameSettings>
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

function persistSettings(settings: GameSettings): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private mode / quota — settings stay in-memory only */
  }
}

// ---------------------------------------------------------------------
// Non-reactive engine holder
// ---------------------------------------------------------------------

/**
 * Holds the live GameEngine instance WITHOUT putting it in React state.
 * Components that need imperative engine access (minimap draw loop,
 * debug bar, system polling) read `engineRef.current` directly.
 */
export const engineRef: { current: GameEngine | null } = { current: null }

// ---------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------

export type Screen = 'menu' | 'briefing' | 'playing' | 'paused' | 'gameover'
export type EngineStatus = 'idle' | 'booting' | 'running' | 'error'
export type GameOverlay = 'wasted' | 'busted' | 'campaign' | null
interface GameStore {
  // Engine-published snapshot (~10Hz)
  hud: HudState | null
  // Content bundle fetched from /api/content/all
  content: ContentBundle | null
  contentLoading: boolean
  contentError: string | null
  // Save slots
  saves: SaveGameRecord[]
  // UI screen state machine
  screen: Screen
  briefingMissionId: string | null
  bigMapOpen: boolean
  /** Round 9: garage bay-management overlay (opened with E at the pad). */
  garagePanelOpen: boolean
  /** Round 10: gun-shop counter sheet (opened with E at the ammo pad). */
  gunShopOpen: boolean
  // ---- Task 2-c ----
  engineStatus: EngineStatus
  bootError: string | null
  settings: GameSettings
  activeSaveSlot: number
  leaderboard: SaveGameRecord[]
  /** Personal waypoint placed from the big map (shows on minimap). */
  waypoint: Vec3 | null
  /** Controls-hint card dismissed (also auto-dismisses after 20s of play). */
  hintDismissed: boolean
  /** WASTED / BUSTED / campaign-complete full-screen overlay. */
  overlay: GameOverlay
  /** Increments on every 'danger' notification → HUD red damage flash. */
  damageFlash: number
  /** Increments on missionCompleted → HUD confetti flourish. */
  flourish: number

  // Engine sync
  setHud: (hud: HudState) => void
  setContent: (c: ContentBundle) => void
  setContentLoading: (v: boolean) => void
  setContentError: (e: string | null) => void
  setSaves: (s: SaveGameRecord[]) => void
  setScreen: (s: Screen) => void
  setBriefingMissionId: (id: string | null) => void
  setBigMapOpen: (v: boolean) => void
  setGaragePanelOpen: (v: boolean) => void
  setGunShopOpen: (v: boolean) => void
  // Task 2-c actions
  setEngineStatus: (status: EngineStatus, error?: string | null) => void
  applySettings: (patch: Partial<GameSettings>) => void
  setActiveSaveSlot: (slot: number) => void
  setLeaderboard: (saves: SaveGameRecord[]) => void
  setWaypoint: (wp: Vec3 | null) => void
  dismissHint: () => void
  setOverlay: (overlay: GameOverlay) => void
  triggerDamageFlash: () => void
  triggerFlourish: () => void
  /** Engine disposed → back to the main menu over the landing page. */
  resetToMenu: () => void
}

export const useGameStore = create<GameStore>((set) => ({
  hud: null,
  content: null,
  contentLoading: true,
  contentError: null,
  saves: [],
  screen: 'menu',
  briefingMissionId: null,
  bigMapOpen: false,
  garagePanelOpen: false,
  gunShopOpen: false,
  engineStatus: 'idle',
  bootError: null,
  settings: DEFAULT_SETTINGS,
  activeSaveSlot: 1,
  leaderboard: [],
  waypoint: null,
  hintDismissed: false,
  overlay: null,
  damageFlash: 0,
  flourish: 0,
  setHud: (hud) => set({ hud }),
  setContent: (content) => set({ content, contentLoading: false, contentError: null }),
  setContentLoading: (contentLoading) => set({ contentLoading }),
  setContentError: (contentError) => set({ contentError, contentLoading: false }),
  setSaves: (saves) => set({ saves }),
  setScreen: (screen) => set({ screen }),
  setBriefingMissionId: (briefingMissionId) => set({ briefingMissionId }),
  setBigMapOpen: (bigMapOpen) => set({ bigMapOpen }),
  setGaragePanelOpen: (garagePanelOpen) => set({ garagePanelOpen }),
  setGunShopOpen: (gunShopOpen) => set({ gunShopOpen }),
  setEngineStatus: (engineStatus, bootError = null) => set({ engineStatus, bootError }),
  applySettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings, ...patch }
      persistSettings(settings)
      return { settings }
    }),
  setActiveSaveSlot: (activeSaveSlot) => set({ activeSaveSlot }),
  setLeaderboard: (saves) =>
    set({
      leaderboard: [...saves].sort((a, b) => b.money - a.money || b.xp - a.xp).slice(0, 5),
    }),
  setWaypoint: (waypoint) => set({ waypoint }),
  dismissHint: () => set({ hintDismissed: true }),
  setOverlay: (overlay) => set({ overlay }),
  triggerDamageFlash: () => set((state) => ({ damageFlash: state.damageFlash + 1 })),
  triggerFlourish: () => set((state) => ({ flourish: state.flourish + 1 })),
  resetToMenu: () =>
    set({
      hud: null,
      screen: 'menu',
      briefingMissionId: null,
      bigMapOpen: false,
      garagePanelOpen: false,
      gunShopOpen: false,
      overlay: null,
      waypoint: null,
      hintDismissed: false,
      engineStatus: 'idle',
      bootError: null,
    }),
}))

/** Selector helpers */
export const selectHud = (s: GameStore) => s.hud
export const selectScreen = (s: GameStore) => s.screen
