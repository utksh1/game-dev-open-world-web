'use client'
/**
 * GameShell — THE orchestrator (Task 2-c).
 *
 * Boot flow (gesture-driven so WebAudio can unlock): the engine is only
 * created after the user clicks Play / Continue / a mission's Start —
 * never on page load. Systems register in the order the gameplay agents
 * require (npcs BEFORE missions — MissionSystem.init hooks
 * NPCManager.onNpcKilled): weapons → npcs → missions → traffic → audio.
 *
 * Engine events → UI: missionStarted closes a pending briefing (the
 * AudioSystem already plays its own jingle + the engine toast renders in
 * the HUD); missionCompleted fires the confetti flourish, saves to the
 * active slot, refreshes saves and checks campaign completion;
 * playerWasted/playerBusted drive the full-screen overlays; 'danger'
 * notifications flash the HUD red.
 *
 * Keyboard: the engine owns all in-game bindings; this shell adds ONLY
 * the M big-map toggle via a capture-phase window listener that also
 * swallows keys while full-screen modals (map/briefing/campaign) are up,
 * so the engine never sees them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import {
  engineRef,
  loadPersistedSettings,
  useGameStore,
  type GameSettings,
} from '@/game/state'
import type { ContentBundle, EngineEvent, SaveGamePayload, SaveGameRecord } from '@/game/types'
import type { GameEngine } from '@/game/engine'
import { loadSlots, saveGame, scheduleAutosave } from '@/game/gameplay/SaveSystem'
import { applyAudioVolumes, getLiveCompleted } from './engineViews'
import BigMap from './BigMap'
import GaragePanel from './GaragePanel'
import GunShopPanel from './GunShopPanel'
import DebugBar from './DebugBar'
import DistrictBanner from './DistrictBanner'
import GameOverOverlay from './GameOverOverlay'
import HUD from './HUD'
import MainMenu from './MainMenu'
import MissionBriefing from './MissionBriefing'
import PauseMenu from './PauseMenu'
import { Button } from '@/components/ui/button'

interface BootOptions {
  /** Level to load after start() (New Game level select). */
  levelId?: string
  /** Save record to restore (Continue). */
  saveData?: SaveGamePayload
  /** Mission to start right after boot (Mission Board before engine). */
  thenMissionId?: string
}

export default function GameShell() {
  const gameEl = useRef<HTMLDivElement | null>(null)
  const mountRef = useRef<HTMLDivElement | null>(null)
  const stopAutosaveRef = useRef<(() => void) | null>(null)
  const briefingAutoPausedRef = useRef(false)
  const campaignAutoPausedRef = useRef(false)
  const bootingRef = useRef(false)

  const [debug, setDebug] = useState(false)
  const engineStatus = useGameStore((s) => s.engineStatus)
  const bootError = useGameStore((s) => s.bootError)
  const content = useGameStore((s) => s.content)
  const contentLoading = useGameStore((s) => s.contentLoading)
  const contentError = useGameStore((s) => s.contentError)
  const bigMapOpen = useGameStore((s) => s.bigMapOpen)
  const briefingMissionId = useGameStore((s) => s.briefingMissionId)

  // ?debug=1 — resolved client-side only.
  useEffect(() => {
    try {
      setDebug(new URLSearchParams(window.location.search).get('debug') === '1')
    } catch {
      setDebug(false)
    }
  }, [])

  // ------------------------------------------------------------------
  // Content + saves + persisted settings
  // ------------------------------------------------------------------
  const refreshSaves = useCallback(async () => {
    const saves = await loadSlots()
    const st = useGameStore.getState()
    st.setSaves(saves)
    st.setLeaderboard(saves)
  }, [])

  useEffect(() => {
    let cancelled = false
    const persisted = loadPersistedSettings()
    if (Object.keys(persisted).length > 0) {
      useGameStore.getState().applySettings(persisted)
    }
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/content/all')
        if (!res.ok) throw new Error(`Content API failed (HTTP ${res.status})`)
        const bundle = (await res.json()) as ContentBundle
        if (!bundle.levels || bundle.levels.length === 0) {
          throw new Error('Content bundle contains no levels')
        }
        if (!cancelled) useGameStore.getState().setContent(bundle)
      } catch (err) {
        if (!cancelled) {
          useGameStore
            .getState()
            .setContentError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    void load()
    void refreshSaves()
    return () => {
      cancelled = true
    }
  }, [refreshSaves])

  // ------------------------------------------------------------------
  // Boot / quit
  // ------------------------------------------------------------------
  const quitEngine = useCallback(
    (toMenu = true): void => {
      stopAutosaveRef.current?.()
      stopAutosaveRef.current = null
      const engine = engineRef.current
      engineRef.current = null
      briefingAutoPausedRef.current = false
      campaignAutoPausedRef.current = false
      try {
        engine?.dispose()
      } catch {
        /* mid-boot failure — dispose may throw on partial state */
      }
      if (toMenu) {
        useGameStore.getState().resetToMenu()
        void refreshSaves()
      }
    },
    [refreshSaves],
  )

  const boot = useCallback(
    async (opts: BootOptions = {}): Promise<void> => {
      if (bootingRef.current) return
      const st = useGameStore.getState()
      if (st.engineStatus === 'running' || st.engineStatus === 'booting') return
      bootingRef.current = true
      st.setEngineStatus('booting')

      const bundle = st.content
      if (!bundle) {
        bootingRef.current = false
        st.setEngineStatus('error', 'Game content not loaded — try refreshing.')
        return
      }

      // The engine's event handler (fresh closure per boot; reads live
      // state via getState() so nothing goes stale).
      const onEvent = (evt: EngineEvent): void => {
        const state = useGameStore.getState()
        const engine = engineRef.current
        switch (evt.type) {
          case 'missionStarted':
            // AudioSystem plays its own jingle; engine toast renders in HUD.
            if (state.briefingMissionId) state.setBriefingMissionId(null)
            break
          case 'missionCompleted': {
            state.triggerFlourish()
            if (engine) {
              const slot = state.activeSaveSlot
              void saveGame(engine, slot).then(() => refreshSaves())
              const campaign = state.content?.campaign
              if (campaign) {
                const completed = getLiveCompleted(engine)
                if (campaign.missions.every((m) => completed.has(m.id))) {
                  state.setOverlay('campaign')
                }
              }
            }
            break
          }
          case 'playerWasted':
            state.setOverlay('wasted')
            break
          case 'playerBusted':
            state.setOverlay('busted')
            break
          case 'garagePanel':
            // Round 9: the GarageSystem drives the bay-management
            // overlay (E at the pad / walk-away leash / wasted-busted).
            state.setGaragePanelOpen(evt.open)
            if (evt.open) {
              try {
                engine?.input.exitPointerLock()
              } catch {
                /* not started — ignore */
              }
            }
            break
          case 'gunShopPanel':
            // Round 10: the CityServices shop counter sheet (E at the
            // ammo pad / walk-away leash / wasted-busted).
            state.setGunShopOpen(evt.open)
            if (evt.open) {
              try {
                engine?.input.exitPointerLock()
              } catch {
                /* not started — ignore */
              }
            }
            break
          case 'notification':
            if (evt.kind === 'danger') state.triggerDamageFlash()
            break
          default:
            break
        }
      }

      try {
        if (!mountRef.current) throw new Error('Mount point missing')

        // 1. client-only engine import (three.js never touches SSR)
        const { createGameEngine } = await import('@/game/engine')
        const engine = createGameEngine() as GameEngine
        engineRef.current = engine
        // QA/debug hook: the live engine instance on window (console
        // bisection, monkey-patch tests — see worklog round 5).
        ;(window as unknown as { __owEngine?: GameEngine }).__owEngine = engine
        engine.onHudSync((hudState) => useGameStore.getState().setHud(hudState))
        engine.onEvent(onEvent)

        // 2. gameplay systems — registration ORDER matters for init():
        //    npcs before missions (MissionSystem.init hooks onNpcKilled);
        //    missions bootstraps 'pickups'; audio last.
        const [{ NPCManager }, { TrafficSystem }, { PolicePursuit }, { PoliceHelicopter }, { WeaponSystem }, { MissionSystem }, { CityServices }, { GarageSystem }, { AudioSystem }, { RadioSystem }] =
          await Promise.all([
            import('@/game/ai/NPCManager'),
            import('@/game/ai/TrafficSystem'),
            import('@/game/ai/PolicePursuit'),
            import('@/game/ai/PoliceHelicopter'),
            import('@/game/gameplay/WeaponSystem'),
            import('@/game/gameplay/MissionSystem'),
            import('@/game/gameplay/CityServices'),
            import('@/game/gameplay/GarageSystem'),
            import('@/game/audio/AudioSystem'),
            import('@/game/audio/RadioSystem'),
          ])
        engine.registerSystem('weapons', new WeaponSystem())
        engine.registerSystem('npcs', new NPCManager())
        engine.registerSystem('missions', new MissionSystem())
        engine.registerSystem('services', new CityServices())
        engine.registerSystem('garage', new GarageSystem())
        engine.registerSystem('traffic', new TrafficSystem())
        engine.registerSystem('pursuit', new PolicePursuit())
        engine.registerSystem('heli', new PoliceHelicopter())
        engine.registerSystem('audio', new AudioSystem())
        engine.registerSystem('radio', new RadioSystem())

        // 3. boot (saveData restores level + player + system fragments)
        await engine.start(mountRef.current, bundle, { saveData: opts.saveData ?? null })

        // 4. New Game level select (start() defaults to downtown/saved level)
        if (opts.levelId && opts.levelId !== bundle.levels[0]?.id) {
          const result = engine.loadLevel(opts.levelId)
          if (!result.ok) engine.notify(result.message ?? 'Level load failed', 'warning')
        }

        // 5. persisted settings → live audio buses + GPU performance mode
        const s: GameSettings = useGameStore.getState().settings
        applyAudioVolumes(engine, {
          master: s.masterVolume,
          music: s.musicVolume,
          sfx: s.sfxVolume,
        })
        if (s.performanceMode) engine.setPerformanceMode(true)
        // Persisted radio station → live radio system (−1 = OFF). Only
        // applied when the player actually HAS a stored preference — the
        // save slot's own radioStation (restored via applySaveData during
        // engine.start) wins otherwise. The old unconditional apply
        // stomped a save's station with the default 0 on fresh installs
        // (the "boot race" from the round-5 worklog).
        const persistedPrefs = loadPersistedSettings()
        if (typeof persistedPrefs.radioStation === 'number') {
          engine.radioSetStation(persistedPrefs.radioStation)
        }

        // 6. session bookkeeping
        const activeSlot = opts.saveData?.slot ?? useGameStore.getState().activeSaveSlot
        useGameStore.getState().setActiveSaveSlot(activeSlot)
        stopAutosaveRef.current?.()
        stopAutosaveRef.current = scheduleAutosave(engine, activeSlot)

        // 7. mission requested from the (engineless) Mission Board
        if (opts.thenMissionId) {
          const result = engine.startMission(opts.thenMissionId)
          if (!result.ok) engine.notify(result.message ?? 'Cannot start mission', 'warning')
        }

        useGameStore.getState().setScreen('playing')
        useGameStore.getState().setEngineStatus('running')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        quitEngine(false)
        useGameStore.getState().setEngineStatus('error', msg)
      } finally {
        bootingRef.current = false
      }
    },
    [quitEngine, refreshSaves],
  )

  // Dispose the engine when the shell unmounts (page navigation).
  useEffect(() => {
    return () => quitEngine(false)
  }, [quitEngine])

  // ------------------------------------------------------------------
  // Briefing / campaign auto-pause (in-game modals freeze the sim)
  // ------------------------------------------------------------------
  useEffect(() => {
    const st = useGameStore.getState()
    const engine = engineRef.current
    if (!engine || st.engineStatus !== 'running') return
    try {
      if (briefingMissionId && !st.hud?.paused && !briefingAutoPausedRef.current) {
        engine.setPaused(true)
        briefingAutoPausedRef.current = true
        engine.input.exitPointerLock()
      } else if (!briefingMissionId && briefingAutoPausedRef.current) {
        briefingAutoPausedRef.current = false
        engine.setPaused(false)
      }
    } catch {
      /* engine mid-teardown — ignore */
    }
  }, [briefingMissionId])

  const overlay = useGameStore((s) => s.overlay)
  useEffect(() => {
    const st = useGameStore.getState()
    const engine = engineRef.current
    if (!engine || st.engineStatus !== 'running') return
    try {
      if (overlay === 'campaign' && !st.hud?.paused && !campaignAutoPausedRef.current) {
        engine.setPaused(true)
        campaignAutoPausedRef.current = true
        engine.input.exitPointerLock()
      } else if (overlay !== 'campaign' && campaignAutoPausedRef.current) {
        campaignAutoPausedRef.current = false
        engine.setPaused(false)
      }
    } catch {
      /* ignore */
    }
  }, [overlay])

  // ------------------------------------------------------------------
  // M key / Escape capture (engine owns every other binding)
  // ------------------------------------------------------------------
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent): void => {
      const st = useGameStore.getState()
      if (st.engineStatus !== 'running') return
      const key = e.key
      const lower = key.toLowerCase()
      const mapOpen = st.bigMapOpen
      const garageOpen = st.garagePanelOpen
      const gunShopOpen = st.gunShopOpen
      const modal = mapOpen || garageOpen || gunShopOpen || st.briefingMissionId !== null || st.overlay === 'campaign'

      if (modal) {
        // Full-screen modal up: the engine must not see ANY keydown
        // (keyup still passes so held keys clear).
        e.stopPropagation()
        if (mapOpen) {
          if (key === ' ' || key.startsWith('Arrow')) e.preventDefault()
          if (lower === 'm' || key === 'Escape') {
            e.preventDefault()
            st.setBigMapOpen(false)
          }
        } else if (garageOpen) {
          // Round 9: E or Escape closes the bay panel.
          if (key === ' ' || key.startsWith('Arrow')) e.preventDefault()
          if (lower === 'e' || key === 'Escape') {
            e.preventDefault()
            st.setGaragePanelOpen(false)
            // Tell the system too (its own leash state must reset).
            const gs = (engineRef.current?.systems as unknown as
              | { garage?: { onUiClosed?: () => void } }
              | undefined)?.garage
            gs?.onUiClosed?.()
          }
        } else if (gunShopOpen) {
          // Round 10: E or Escape leaves the gun-shop counter.
          if (key === ' ' || key.startsWith('Arrow')) e.preventDefault()
          if (lower === 'e' || key === 'Escape') {
            e.preventDefault()
            st.setGunShopOpen(false)
            const svc = (engineRef.current?.systems as unknown as
              | { services?: { onUiClosed?: () => void } }
              | undefined)?.services
            svc?.onUiClosed?.()
          }
        } else if (st.briefingMissionId && key === 'Escape') {
          e.preventDefault()
          st.setBriefingMissionId(null)
        }
        return
      }

      // M toggles the big map while actively playing.
      if (lower === 'm' && st.screen === 'playing' && !st.hud?.paused) {
        e.preventDefault()
        e.stopPropagation()
        st.setBigMapOpen(true)
        try {
          engineRef.current?.input.exitPointerLock()
        } catch {
          /* not started — ignore */
        }
      }
    }
    // Capture phase on window fires BEFORE the engine's bubble-phase
    // keydown listener, letting us swallow keys for the UI modal states.
    window.addEventListener('keydown', onKeydown, true)
    return () => window.removeEventListener('keydown', onKeydown, true)
  }, [])

  // ------------------------------------------------------------------
  // Handlers for child components
  // ------------------------------------------------------------------
  const closeBriefing = useCallback((): void => {
    useGameStore.getState().setBriefingMissionId(null)
  }, [])

  const briefingStart = useCallback(
    (missionId: string): { ok: boolean; message?: string } | 'booting' => {
      const engine = engineRef.current
      const st = useGameStore.getState()
      if (engine) {
        const result = engine.startMission(missionId)
        if (result.ok) {
          // Resume if this briefing auto-paused the game (or it came from
          // the pause menu) — start the mission live.
          if (briefingAutoPausedRef.current || st.hud?.paused) {
            briefingAutoPausedRef.current = false
            engine.setPaused(false)
          }
          st.setBriefingMissionId(null)
        }
        return result
      }
      // Engine not booted (Mission Board from the main menu): boot on the
      // campaign's home level and start the mission right after.
      void boot({ levelId: 'downtown', thenMissionId: missionId })
      return 'booting'
    },
    [boot],
  )

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  const running = engineStatus === 'running'

  return (
    <div
      ref={gameEl}
      className="relative h-full w-full overflow-hidden bg-zinc-950 text-zinc-100"
      aria-label="Game"
    >
      {/* 3D canvas mount — the engine appends its WebGL canvas here */}
      <div ref={mountRef} className="absolute inset-0" aria-label="3D game viewport" />

      {/* ---------- pre-boot: main menu over the styled backdrop ---------- */}
      {!running && engineStatus !== 'booting' && engineStatus !== 'error' && (
        <>
          {contentError ? (
            <div className="absolute inset-0 z-30 flex items-center justify-center p-6">
              <div
                role="alert"
                className="max-w-md rounded-xl border border-rose-500/50 bg-rose-950/40 p-5 text-center"
              >
                <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-rose-400" aria-hidden="true" />
                <h3 className="text-base font-bold text-rose-200">Content failed to load</h3>
                <p className="mt-1 text-xs text-zinc-400">{contentError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 border-zinc-700 bg-zinc-900 text-zinc-200"
                  onClick={() => window.location.reload()}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Retry
                </Button>
              </div>
            </div>
          ) : content ? (
            <MainMenu
              onNewGame={(levelId) => void boot({ levelId })}
              onContinue={(record: SaveGameRecord) => void boot({ saveData: record })}
              onOpenBriefing={(missionId) => useGameStore.getState().setBriefingMissionId(missionId)}
              onSavesChanged={() => void refreshSaves()}
            />
          ) : (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-400" aria-hidden="true" />
              <p className="text-xs text-zinc-500">
                {contentLoading ? 'Loading content bundle…' : 'Waiting for content…'}
              </p>
            </div>
          )}
        </>
      )}

      {/* ---------- booting ---------- */}
      {engineStatus === 'booting' && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-zinc-950">
          <span
            className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400"
            aria-hidden="true"
          />
          <p className="text-sm text-zinc-400">Booting engine — streaming the district…</p>
          <p className="text-xs text-zinc-600">loading content · building world · spawning vehicles</p>
        </div>
      )}

      {/* ---------- boot error / WebGL unsupported ---------- */}
      {engineStatus === 'error' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-zinc-950/95 p-6">
          <div
            role="alert"
            className={`max-w-md rounded-xl border p-5 ${
              /webgl/i.test(bootError ?? '')
                ? 'border-amber-500/50 bg-amber-950/30'
                : 'border-rose-500/50 bg-rose-950/30'
            }`}
          >
            <h3 className="mb-2 text-lg font-bold">
              {/webgl/i.test(bootError ?? '') ? 'WebGL unavailable' : 'Boot failed'}
            </h3>
            <p className="mb-3 text-sm text-zinc-300">{bootError}</p>
            <p className="text-xs text-zinc-500">
              {/webgl/i.test(bootError ?? '')
                ? 'This browser or GPU cannot create a WebGL context — the 3D open world needs it.'
                : 'Try again; check the browser console and dev server logs for details.'}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 border-zinc-700 bg-zinc-900 text-zinc-200"
              onClick={() => {
                quitEngine(false)
                useGameStore.getState().setEngineStatus('idle')
                useGameStore.getState().setScreen('menu')
              }}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Back to menu
            </Button>
          </div>
        </div>
      )}

      {/* ---------- running: HUD + overlays ---------- */}
      {running && (
        <>
          <HUD gameEl={gameEl} />
          <DistrictBanner />
          <PauseMenu
            onQuit={() => quitEngine(true)}
            onOpenBriefing={(missionId) => useGameStore.getState().setBriefingMissionId(missionId)}
            onSavesChanged={() => void refreshSaves()}
          />
          {bigMapOpen && <BigMap />}
          <GaragePanel />
          <GunShopPanel />
          <MissionBriefing onStart={briefingStart} onCancel={closeBriefing} />
          <GameOverOverlay onQuit={() => quitEngine(true)} />
          {debug && <DebugBar />}
        </>
      )}
    </div>
  )
}
