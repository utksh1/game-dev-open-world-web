/**
 * Pickups — shared world-pickup manager (cash drops from NPCs, ammo
 * crates / enemy ammo drops for the WeaponSystem, mission collectibles
 * for the MissionSystem). One manager, registered ONCE as the engine
 * system `'pickups'` (the MissionSystem bootstraps it during its own
 * init so every game automatically has it).
 *
 * Pickups are small spinning octahedrons with a soft glow sprite,
 * auto-collected when the player comes within 2 m. Effects are applied
 * here (cash → player money, ammo → WeaponSystem reserve, custom →
 * caller-provided onCollect callback). Respawn-capable for static
 * crates (ammo crates near the gun shop).
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { Vec3, WeaponId } from '@/game/types'

export type PickupKind = 'cash' | 'ammo' | 'item'

export interface PickupSpawnOptions {
  kind: PickupKind
  /** Cash amount or ammo rounds. */
  amount?: number
  /** For kind 'ammo': which weapon the rounds go to. */
  weaponId?: WeaponId
  /** Group tag — MissionSystem removes all pickups of its mission on cleanup. */
  missionId?: string
  /** Label shown in the pickup notification (defaults per kind). */
  label?: string
  /** Seconds until the pickup reappears after collection (static crates). */
  respawnSec?: number
  /** Custom collection handler (returning false leaves the pickup). */
  onCollect?: () => boolean
}

interface Pickup {
  id: string
  mesh: THREE.Mesh
  glow: THREE.Sprite
  baseY: number
  phase: number
  active: boolean
  respawnTimer: number
  opts: PickupSpawnOptions
}

/** What the WeaponSystem exposes to the pickup manager (loose coupling). */
interface WeaponAmmoApi {
  addAmmo?: (weaponId: WeaponId, amount: number) => void
}

const OCTA = new THREE.OctahedronGeometry(0.32)
const GLOW_TEX = makeGlowTexture()
const KIND_COLORS: Record<PickupKind, number> = {
  cash: 0x34d399, // emerald
  ammo: 0xfbbf24, // amber
  item: 0xfb7185, // rose
}
const KIND_LABELS: Record<PickupKind, string> = {
  cash: 'cash',
  ammo: 'ammo',
  item: 'item',
}
const COLLECT_RADIUS = 2

export class PickupManager implements EngineSystem {
  private engine: GameEngine | null = null
  private scene: THREE.Scene | null = null
  private pickups: Pickup[] = []
  private counter = 0
  private time = 0

  /** Spawn a pickup at a world position. Returns the pickup id. */
  spawn(pos: Vec3, opts: PickupSpawnOptions): string {
    if (!this.scene) return ''
    const id = `pickup_${++this.counter}`
    const color = KIND_COLORS[opts.kind]
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.9,
      roughness: 0.35,
    })
    const mesh = new THREE.Mesh(OCTA, mat)
    mesh.position.set(pos.x, Math.max(pos.y, 0) + 0.9, pos.z)
    mesh.castShadow = false

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: GLOW_TEX,
        color,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    )
    glow.scale.setScalar(2.2)
    glow.position.copy(mesh.position)

    this.scene.add(mesh)
    this.scene.add(glow)
    this.pickups.push({
      id,
      mesh,
      glow,
      baseY: mesh.position.y,
      phase: Math.random() * Math.PI * 2,
      active: true,
      respawnTimer: 0,
      opts,
    })
    return id
  }

  /** Remove one pickup by id. */
  remove(id: string): void {
    const idx = this.pickups.findIndex((p) => p.id === id)
    if (idx < 0) return
    this.disposePickup(this.pickups[idx])
    this.pickups.splice(idx, 1)
  }

  /** Remove every pickup tagged with the given mission id. */
  removeByMission(missionId: string): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      if (this.pickups[i].opts.missionId === missionId) {
        this.disposePickup(this.pickups[i])
        this.pickups.splice(i, 1)
      }
    }
  }

  /** Live pickup positions (minimap / debugging). */
  getPositions(): { id: string; kind: PickupKind; position: Vec3 }[] {
    return this.pickups
      .filter((p) => p.active)
      .map((p) => ({
        id: p.id,
        kind: p.opts.kind,
        position: { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z },
      }))
  }

  // ------------------------------------------------------------------
  // EngineSystem hooks
  // ------------------------------------------------------------------

  init(engine: GameEngine): void {
    this.engine = engine
    this.scene = engine.scene
  }

  update(dt: number): void {
    this.time += dt
    const engine = this.engine
    if (!engine) return
    const player = engine.player
    const px = player.position.x
    const pz = player.position.z

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i]

      // respawn logic
      if (!p.active) {
        if (p.opts.respawnSec) {
          p.respawnTimer -= dt
          if (p.respawnTimer <= 0) {
            p.active = true
            p.mesh.visible = true
            p.glow.visible = true
          }
        }
        continue
      }

      // spin + bob
      p.phase += dt * 3
      p.mesh.rotation.y += dt * 2.4
      p.mesh.position.y = p.baseY + Math.sin(p.phase) * 0.15
      p.glow.position.y = p.mesh.position.y
      const pulse = 0.4 + 0.2 * Math.sin(this.time * 4 + p.phase)
      ;(p.glow.material as THREE.SpriteMaterial).opacity = pulse

      // auto-collect
      const dx = p.mesh.position.x - px
      const dz = p.mesh.position.z - pz
      if (dx * dx + dz * dz < COLLECT_RADIUS * COLLECT_RADIUS && !player.dead) {
        if (this.applyEffect(p)) {
          if (p.opts.respawnSec) {
            p.active = false
            p.respawnTimer = p.opts.respawnSec
            p.mesh.visible = false
            p.glow.visible = false
          } else {
            this.disposePickup(p)
            this.pickups.splice(i, 1)
          }
        }
      }
    }
  }

  dispose(): void {
    for (const p of this.pickups) this.disposePickup(p)
    this.pickups.length = 0
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private applyEffect(p: Pickup): boolean {
    const engine = this.engine
    if (!engine) return false
    if (p.opts.onCollect && p.opts.onCollect() === false) return false

    const amount = p.opts.amount ?? 0
    switch (p.opts.kind) {
      case 'cash': {
        engine.player.addMoney(amount)
        engine.notify(`Picked up $${amount}`, 'success')
        break
      }
      case 'ammo': {
        const weapons = engine.systems.weapons as unknown as WeaponAmmoApi | undefined
        if (p.opts.weaponId && weapons?.addAmmo) {
          weapons.addAmmo(p.opts.weaponId, amount)
          engine.notify(`+${amount} ${p.opts.weaponId} rounds`, 'success')
        } else {
          engine.notify('Ammo pickup', 'info')
        }
        break
      }
      case 'item': {
        engine.notify(`Collected ${p.opts.label ?? KIND_LABELS.item}`, 'success')
        break
      }
    }
    this.playPickupSound()
    return true
  }

  private playPickupSound(): void {
    interface AudioLike {
      play?: (name: string, opts?: { position?: Vec3; volume?: number }) => void
    }
    const audio = this.engine?.systems.audio as unknown as AudioLike | undefined
    audio?.play?.('pickup')
  }

  private disposePickup(p: Pickup): void {
    this.scene?.remove(p.mesh)
    this.scene?.remove(p.glow)
    ;(p.mesh.material as THREE.Material).dispose()
    ;(p.glow.material as THREE.Material).dispose()
  }
}

function makeGlowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30)
  grad.addColorStop(0, 'rgba(255,255,255,0.9)')
  grad.addColorStop(0.4, 'rgba(255,255,255,0.35)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
