'use client'
/**
 * DebugBar — ?debug=1 cheat toolbar (moved verbatim from the Task 2-b
 * boot page). Buttons poke the live engine + registered systems through
 * narrow structural views; failures surface as engine notifications.
 */
import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { engineRef } from '@/game/state'
import type { GameEngine } from '@/game/engine'
import {
  debugCompleteObjective,
  debugGarageOwnership,
  debugGiveAllWeapons,
  debugRaceStatus,
  debugSkipTime,
  debugSpawnPolice,
  debugSuppressWantedDecay,
  debugTeleportGarage,
  debugTeleportService,
  getGaragePrompt,
  getGarageStatus,
  getServicePrompt,
} from './engineViews'
import { loadSlot, saveGame } from '@/game/gameplay/SaveSystem'

export default function DebugBar() {
  const [engine, setEngine] = useState<GameEngine | null>(null)
  // Re-render on a light timer so HUD-relevant cheats (wanted level) are
  // reflected in button state; the actions themselves are fire-and-forget.
  useEffect(() => {
    const t = window.setInterval(() => {
      setEngine(engineRef.current)
    }, 500)
    return () => window.clearInterval(t)
  }, [])

  if (!engine) return null

  const run = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      engine.notify(
        `Debug action failed (${label}): ${err instanceof Error ? err.message : String(err)}`,
        'danger',
      )
    }
  }

  const buttons: { label: string; fn: () => void }[] = [
    {
      label: 'Give all weapons',
      fn: () => debugGiveAllWeapons(engine),
    },
    {
      label: 'Start mission_01',
      fn: () => {
        const r = engine.startMission('mission_01')
        if (!r.ok) engine.notify(r.message ?? 'Cannot start mission_01', 'warning')
      },
    },
    {
      label: 'Start mission_03 (delivery)',
      fn: () => {
        const r = engine.startMission('mission_03')
        if (!r.ok) engine.notify(r.message ?? 'Cannot start mission_03', 'warning')
      },
    },
    {
      label: 'Start street race (side)',
      fn: () => {
        let r = engine.startMission('side_mission_street_race')
        if (!r.ok && /sports car/i.test(r.message ?? '')) {
          // QA convenience: hop next to the nearest sports car, then retry.
          const all = engine.vehicles.getNearby(engine.player.position, 800)
          const sports = all
            .map((n) => engine.vehicles.getById(n.id))
            .find((v) => v && v.data.vehicleClass.toLowerCase().includes('sport'))
          if (sports) {
            engine.teleportPlayer({ x: sports.position.x + 3, y: 0, z: sports.position.z + 3 })
            r = engine.startMission('side_mission_street_race')
          }
        }
        if (!r.ok) engine.notify(r.message ?? 'Cannot start street race', 'warning')
      },
    },
    {
      label: 'Race status',
      fn: () => engine.notify(debugRaceStatus(engine), 'info'),
    },
    {
      label: 'TP to clinic',
      fn: () => {
        if (!debugTeleportService(engine, 'clinic')) engine.notify('No clinic in this level', 'warning')
      },
    },
    {
      label: 'TP to gun shop',
      fn: () => {
        if (!debugTeleportService(engine, 'ammo')) engine.notify('No gun shop in this level', 'warning')
      },
    },
    {
      label: "TP to Pay'n'Spray",
      fn: () => {
        if (!debugTeleportService(engine, 'spray')) engine.notify('No spray bay in this level', 'warning')
      },
    },
    {
      label: 'TP to garage',
      fn: () => {
        if (!debugTeleportGarage(engine)) engine.notify('No garage in this level', 'warning')
      },
    },
    {
      label: 'Garage: free ownership',
      fn: () => {
        if (!debugGarageOwnership(engine)) engine.notify('You already own the lockup', 'info')
        else engine.notify('Debug: garage ownership granted', 'success')
      },
    },
    {
      label: 'Garage status',
      fn: () => {
        const g = getGarageStatus(engine)
        const prompt = getGaragePrompt(engine)
        engine.notify(
          g
            ? `owned=${g.owned} · bays=${g.carsInside}/${g.baysUnlocked} · bay1=${g.stored ? `${g.stored.name} (${g.stored.health}/${g.stored.maxHealth})` : 'empty'}${prompt ? ` · action=${prompt.action}` : ''}`
            : 'no garage in this level',
          'info',
        )
      },
    },
    {
      label: 'Service prompt status',
      fn: () => {
        const p = getServicePrompt(engine)
        engine.notify(
          p
            ? `near: ${p.name} ($${p.price}) · vehicle=${p.inVehicle} · ready=${p.wouldDoSomething}`
            : 'not near any service',
          'info',
        )
      },
    },
    {
      label: 'Cheat: complete objective',
      fn: () => {
        const done = debugCompleteObjective(engine)
        if (!done) engine.notify('No active mission objective', 'warning')
      },
    },
    {
      label: 'TP to waypoint',
      fn: () => {
        const m = engine.getHudState().mission
        if (!m?.waypoint) {
          engine.notify('No active waypoint', 'warning')
          return
        }
        // Land with a view of the objective: 40 m out (gate/beacon visible,
        // then walk or drive in to claim — checkpoint radius is 12 m).
        engine.teleportPlayer({ x: m.waypoint.x, y: 0, z: m.waypoint.z + 40 })
        engine.notify('Debug: teleported to waypoint', 'info')
      },
    },
    {
      label: 'Wanted +1',
      fn: () => {
        const level = Math.min(5, engine.getHudState().player.wantedLevel + 1)
        engine.setWantedLevel(level)
        debugSuppressWantedDecay(engine) // keep the debug state stable
        engine.notify(`Wanted level ${level}`, 'warning')
      },
    },
    {
      label: 'Spawn police',
      fn: () => debugSpawnPolice(engine),
    },
    {
      label: 'Heat 3 (pursuit test)',
      fn: () => {
        engine.setWantedLevel(3)
        debugSuppressWantedDecay(engine)
        engine.notify('Wanted 3 — enter a car to trigger pursuit', 'warning')
      },
    },
    {
      label: 'Heat 4 (air unit test)',
      fn: () => {
        engine.setWantedLevel(4)
        debugSuppressWantedDecay(engine)
        engine.notify('Wanted 4 — AIR UNIT inbound (works on foot too)', 'warning')
      },
    },
    {
      label: 'Heat 5 (SWAT ropes test)',
      fn: () => {
        engine.setWantedLevel(5)
        debugSuppressWantedDecay(engine)
        engine.notify('Wanted 5 — the chopper will fast-rope SWAT squads', 'warning')
      },
    },
    {
      label: 'Air unit status',
      fn: () => {
        const sys = engine.systems.heli as
          | { getHelicopter?: () => { state: string; searchlightOn: boolean; swatDeployed?: number; rappelling?: boolean } | null; isPlayerLit?: () => boolean }
          | undefined
        const h = sys?.getHelicopter?.() ?? null
        engine.notify(
          `heli ${h ? h.state : 'grounded'} · light ${h ? h.searchlightOn : '-'} · playerLit ${sys?.isPlayerLit?.() ?? '-'} · swat ${h?.swatDeployed ?? 0}${h?.rappelling ? ' · ROPES OUT' : ''}`,
          'info',
        )
      },
    },
    {
      label: 'Radio next station',
      fn: () => {
        if (engine.vehicles.playerVehicleId === null) {
          engine.notify('Enter a vehicle first (radio plays while driving)', 'warning')
          return
        }
        engine.radioNext()
      },
    },
    {
      label: 'Pursuit status',
      fn: () => {
        const sys = engine.systems.pursuit as
          | { isPursuing?: () => boolean; getPursuit?: () => unknown[]; getArrestCountdown?: () => number | null }
          | undefined
        const pvId = engine.vehicles.playerVehicleId
        const pv = pvId ? engine.vehicles.getById(pvId) : null
        engine.notify(
          `wanted ${engine.getHudState().player.wantedLevel} · driving ${!!pv && !pv.destroyed} · sys ${!!sys} · pursuing ${sys?.isPursuing?.() ?? '?'} · cruisers ${sys?.getPursuit?.().length ?? '?'} · arrestIn ${sys?.getArrestCountdown?.() ?? '-'}`,
          'info',
        )
      },
    },
    {
      label: 'Enter nearest car',
      fn: () => {
        const v = engine.vehicles.getNearest(engine.player.position, 500)
        if (!v) {
          engine.notify('No drivable vehicle within 500 m', 'warning')
          return
        }
        // Place the player right beside the driver door, then enter.
        engine.teleportPlayer({
          x: v.position.x - v.forwardZ * (v.data.width / 2 + 1.6),
          y: v.position.y,
          z: v.position.z + v.forwardX * (v.data.width / 2 + 1.6),
        })
        engine.enterOrExitVehicle()
        engine.notify(`Debug: hopped into ${v.data.name}`, 'info')
      },
    },
    {
      label: 'Spawn + enter fresh sedan',
      fn: () => {
        // QA: a sturdy PARKED car at the player's feet — no coasting traffic,
        // no wrecks; built for box-in / arrest-flow testing.
        const data =
          engine.content.vehicles.find((v) => v.vehicleClass.toLowerCase().includes('sedan')) ??
          engine.content.vehicles.find((v) => v.type !== 'helicopter')
        if (!data) {
          engine.notify('No sedan content available', 'warning')
          return
        }
        const p = engine.player.position
        // spawnVehicle needs a THREE.Vector3 (findFreeSpot calls .clone()).
        const v = engine.vehicles.spawnVehicle(
          data,
          new THREE.Vector3(p.x + 3, 0, p.z + 3),
          0,
          false,
        )
        engine.teleportPlayer({ x: p.x + 3, y: 0, z: p.z + 1 })
        engine.enterOrExitVehicle()
        engine.notify(`Debug: spawned a fresh ${data.name} (parked)`, 'info')
      },
    },
    {
      label: 'Damage vehicle 60',
      fn: () => {
        const id = engine.vehicles.playerVehicleId
        const v = id ? engine.vehicles.getById(id) : engine.vehicles.getNearest(engine.player.position, 30)
        if (!v) {
          engine.notify('No vehicle within 30 m', 'warning')
          return
        }
        v.applyDamage(60)
        engine.notify(`${v.data.name} — damage 60 (${Math.max(0, Math.round((v.health / Math.max(1, v.data.durability)) * 100))}% left)`, 'warning')
      },
    },
    {
      label: 'Time +6h',
      fn: () => debugSkipTime(engine),
    },
    {
      label: 'Photo mode (V)',
      fn: () => {
        engine.togglePhotoMode()
        const st = engine.getPhotoState()
        engine.notify(st.active ? `Photo mode ON — FOV ${st.fov}°` : 'Photo mode OFF', 'info')
      },
    },
    {
      label: 'Save slot 1',
      fn: () => void saveGame(engine, 1),
    },
    {
      label: 'Load slot 1',
      fn: () => void loadSlot(engine, 1),
    },
    {
      label: '+$1000',
      fn: () => {
        engine.player.addMoney(1000)
        engine.notify('+$1,000', 'success')
      },
    },
    {
      label: 'Heal',
      fn: () => {
        engine.restorePlayer(100, 100)
        engine.notify('Healed', 'success')
      },
    },
    {
      label: 'Damage 30',
      fn: () => engine.damagePlayer(30, 'debug cheat'),
    },
  ]

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-50 border-t border-amber-500/30 bg-black/85 p-2 backdrop-blur-sm"
      role="toolbar"
      aria-label="Debug toolbar"
    >
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <span
          className="mr-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300"
          aria-hidden="true"
        >
          debug
        </span>
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            onClick={(e) => {
              e.currentTarget.blur() // keep keyboard focus on the game
              run(b.label, b.fn)
            }}
            className="rounded border border-zinc-700 bg-zinc-900/90 px-2 py-1 text-[11px] leading-tight text-zinc-200 transition-colors hover:border-amber-500/60 hover:bg-zinc-800 hover:text-amber-200 focus-visible:border-amber-400 focus-visible:outline-none"
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}
