/**
 * AudioSystem — REAL WebAudio. THE gap fix: the original C++ AudioSystem
 * was 100 % fake — `init()` was literally `return true`, no device was
 * ever opened and no sound was ever produced. This module synthesizes
 * every sound procedurally (no asset files needed):
 *
 *   guns (pistol/smg/rifle/shotgun) · reload clicks · footsteps ·
 *   vehicle engine (saw osc 60–220 Hz by speed, starts/stops on
 *   enter/exit) · horn · police siren (wanted > 0, positional,
 *   alternates two tones) · pickup chime · mission stings · ui clicks ·
 *   damage thud · wanted-up sting · melee whoosh · crash
 *   plus a quiet ambient music pad (2 detuned oscs + slow LFO) that
 *   intensifies slightly with the wanted level.
 *
 * Registered as engine system 'audio'. Other systems call
 * `audio.play(name, { position, volume })` — sounds with a position are
 * spatialized through a PannerNode with the listener locked to the
 * camera. The AudioContext is created lazily (autoplay-policy safe) and
 * resumed from update() whenever it is suspended; one-shot voices are
 * capped at 12 with oldest-first stealing.
 *
 * Aliases: other systems already call 'reload_start'/'reload_end'/
 * 'pickup'/'damage_thud'/'crash'/'melee' — all mapped below.
 */
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { Vec3 } from '@/game/types'

// ---------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------

export interface AudioVolumes {
  master: number
  music: number
  sfx: number
}

export interface AudioPlayOptions {
  /** World position — enables PannerNode spatialization (listener = camera). */
  position?: Vec3
  /** Per-sound gain multiplier (0..1.5, default 1). */
  volume?: number
}

interface OneShotVoice {
  out: GainNode
  endsAt: number
  kill: (t: number) => void
}

interface EngineLoop {
  osc: OscillatorNode
  filter: BiquadFilterNode
  gain: GainNode
}

interface SirenLoop {
  osc: OscillatorNode
  gain: GainNode
  panner: PannerNode
  high: boolean
  swap: number
  repos: number
}

interface MusicPad {
  oscA: OscillatorNode
  oscB: OscillatorNode
  gain: GainNode
  lfo: OscillatorNode
  base: number
}

interface HeliLoop {
  noise: AudioBufferSourceNode
  thump: OscillatorNode
  lfo: OscillatorNode
  gain: GainNode
  panner: PannerNode
  repos: number
}

/** Legacy fallbacks for older WebAudio implementations (both optional —
 *  feature-detected at runtime, always present in lib.dom typings). */
interface LegacyPanner {
  setPosition?(x: number, y: number, z: number): void
}
interface LegacyListener {
  setPosition?(x: number, y: number, z: number): void
  setOrientation?(
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void
}
type MaybeLegacyPanner = PannerNode & LegacyPanner
type MaybeLegacyListener = AudioListener & LegacyListener

const MAX_VOICES = 12
const SIREN_LOW = 640
const SIREN_HIGH = 950
const SIREN_SWAP_SEC = 0.45
const SIREN_REPOS_SEC = 0.5
const ENGINE_HZ_MIN = 60
const ENGINE_HZ_MAX = 220
const ENGINE_KMH_SPAN = 130

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------
// System
// ---------------------------------------------------------------------

export class AudioSystem implements EngineSystem {
  private engine: GameEngine | null = null
  private disposed = false

  // Lazy AudioContext + buses (master → music + sfx).
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private musicBus: GainNode | null = null
  private sfxBus: GainNode | null = null
  private volumes: AudioVolumes = { master: 0.8, music: 0.35, sfx: 0.9 }

  // One-shot voice pool (cap MAX_VOICES, steal oldest).
  private voices: OneShotVoice[] = []
  private noiseBuffer: AudioBuffer | null = null

  // Continuous loops.
  private engineLoop: EngineLoop | null = null
  private siren: SirenLoop | null = null
  private pad: MusicPad | null = null
  private padWanted = -1
  private padSuppressed = false
  private heli: HeliLoop | null = null

  // First user gesture → create + resume the context (autoplay policy).
  private gestureSeen = false
  private onGesture: (() => void) | null = null

  // Timers.
  private time = 0
  private stepTimer = 0.2
  private tmpFwd = { x: 0, y: 0, z: -1 }

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.disposed = false

    // Gameplay-driven sounds.
    engine.onEvent((evt) => {
      if (this.disposed) return
      switch (evt.type) {
        case 'missionCompleted':
          this.play('mission_complete')
          break
        case 'missionFailed':
          this.play('mission_failed')
          break
        case 'vehicleEntered':
          this.startEngineLoop()
          break
        case 'vehicleExited':
          this.stopEngineLoop()
          break
        case 'wantedLevelChanged':
          if (evt.level > 0) {
            this.play('wanted_up')
            this.startSiren()
          } else {
            this.stopSiren()
          }
          break
        case 'notification':
          // The engine reports player damage as "−N HP (source)" danger
          // notifications — piggyback on those for the damage thud.
          if (evt.kind === 'danger' && /[−-]\d+\s*HP/.test(evt.text)) {
            this.play('damage')
          }
          break
        default:
          break
      }
    })

    // Unlock the AudioContext on the first real user gesture.
    if (typeof window !== 'undefined') {
      this.onGesture = () => {
        this.gestureSeen = true
        this.ensureContext()
        this.safeResume()
      }
      window.addEventListener('pointerdown', this.onGesture, true)
      window.addEventListener('keydown', this.onGesture, true)
    }
  }

  update(dt: number): void {
    if (this.disposed) return
    this.time += dt

    // Create the context once a gesture has been seen (autoplay-safe).
    if (this.gestureSeen && !this.ctx) this.ensureContext()
    const ctx = this.ctx
    if (!ctx) return
    if (ctx.state === 'suspended') this.safeResume()

    const engine = this.engine
    if (!engine) return

    this.updateListener(engine)

    // --- vehicle engine loop: start/stop + pitch by speed --------------
    const drivingId = engine.vehicles.playerVehicleId
    if (drivingId !== null) {
      if (!this.engineLoop) this.startEngineLoop()
      const vehicle = engine.vehicles.getById(drivingId)
      if (vehicle && this.engineLoop) {
        // Same speed the HUD publishes (player.speedKmh).
        const norm = clamp(Math.abs(vehicle.getSpeedKmh()) / ENGINE_KMH_SPAN, 0, 1)
        const wobble = Math.sin(this.time * 9) * (0.8 + norm * 2.2)
        this.engineLoop.osc.frequency.setTargetAtTime(
          ENGINE_HZ_MIN + (ENGINE_HZ_MAX - ENGINE_HZ_MIN) * norm + wobble,
          ctx.currentTime,
          0.08,
        )
        this.engineLoop.gain.gain.setTargetAtTime(0.12 + 0.16 * norm, ctx.currentTime, 0.15)
      }
    } else {
      this.stopEngineLoop()
    }

    // --- siren: on while wanted, alternating two tones, positional -----
    const wanted = engine.player.wantedLevel
    if (wanted > 0) {
      if (!this.siren) this.startSiren()
    } else {
      this.stopSiren()
    }
    if (this.siren) {
      const s = this.siren
      s.swap -= dt
      if (s.swap <= 0) {
        s.swap = SIREN_SWAP_SEC
        s.high = !s.high
        try {
          s.osc.frequency.setValueAtTime(s.high ? SIREN_HIGH : SIREN_LOW, ctx.currentTime)
        } catch {
          /* ignore */
        }
      }
      s.repos -= dt
      if (s.repos <= 0) {
        s.repos = SIREN_REPOS_SEC
        this.positionSiren()
      }
    }

    // --- ambient pad intensity follows the wanted level ----------------
    if (this.pad && wanted !== this.padWanted) {
      this.padWanted = wanted
      this.pad.base = 0.045 + wanted * 0.011
      if (!this.padSuppressed) {
        try {
          this.pad.gain.gain.setTargetAtTime(this.pad.base, ctx.currentTime, 1.5)
        } catch {
          /* ignore */
        }
      }
    }

    // --- footsteps while walking / running ------------------------------
    this.updateFootsteps(engine, dt)

    // --- prune finished one-shot voices ---------------------------------
    const now = ctx.currentTime
    this.voices = this.voices.filter((v) => v.endsAt > now - 0.25)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopEngineLoop()
    this.stopSiren()
    this.stopMusicPad()
    this.stopHelicopterLoop()
    this.setPadSuppressed(false)
    const t = this.ctx?.currentTime ?? 0
    for (const v of this.voices) v.kill(t)
    this.voices = []
    if (this.onGesture && typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.onGesture, true)
      window.removeEventListener('keydown', this.onGesture, true)
      this.onGesture = null
    }
    const ctx = this.ctx
    this.ctx = null
    this.masterGain = null
    this.musicBus = null
    this.sfxBus = null
    this.noiseBuffer = null
    if (ctx) {
      try {
        const p = ctx.close() as unknown as Promise<void> | undefined
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {
        /* ignore */
      }
    }
    this.engine = null
  }

  // =================================================================
  // Public API
  // =================================================================

  /** Fire a named procedural sound (see the header for the full list). */
  play(name: string, opts?: AudioPlayOptions): void {
    if (this.disposed) return
    const ctx = this.ensureContext()
    if (!ctx) return
    this.spawnVoice(name, opts ?? {})
  }

  /** Update the mixer (each value 0..1, partial updates allowed). */
  setVolumes(v: Partial<AudioVolumes>): void {
    this.volumes = {
      master: clamp(v.master ?? this.volumes.master, 0, 1),
      music: clamp(v.music ?? this.volumes.music, 0, 1),
      sfx: clamp(v.sfx ?? this.volumes.sfx, 0, 1),
    }
    const ctx = this.ctx
    if (ctx) {
      const t = ctx.currentTime
      try {
        this.masterGain?.gain.setTargetAtTime(this.volumes.master, t, 0.05)
        this.musicBus?.gain.setTargetAtTime(this.volumes.music, t, 0.05)
        this.sfxBus?.gain.setTargetAtTime(this.volumes.sfx, t, 0.05)
      } catch {
        /* ignore */
      }
    }
  }

  getVolumes(): AudioVolumes {
    return { ...this.volumes }
  }

  /** The shared music bus (master → music). Radio connects its output here
   *  so the music volume slider governs both the ambient pad and stations. */
  getMusicBus(): GainNode | null {
    this.ensureContext()
    return this.musicBus
  }

  /** Access to the shared AudioContext (radio scheduler clock). */
  getAudioContext(): AudioContext | null {
    this.ensureContext()
    return this.ctx
  }

  /** Duck the ambient pad while a radio station is playing (and restore). */
  setPadSuppressed(on: boolean): void {
    if (this.padSuppressed === on) return
    this.padSuppressed = on
    const ctx = this.ctx
    if (!ctx || !this.pad) return
    const target = on ? 0.0001 : this.pad.base
    try {
      this.pad.gain.gain.setTargetAtTime(target, ctx.currentTime, on ? 0.4 : 1.2)
    } catch {
      /* ignore */
    }
  }

  /** True once the WebAudio context exists (autoplay policy satisfied). */
  hasContext(): boolean {
    return this.ctx != null && this.ctx.state === 'running'
  }

  // ---- helicopter rotor loop (driven by the PoliceHelicopter system) ----

  /** Procedural "wop-wop-wop": band-passed noise + low sine thump, both
   *  amplitude-modulated by a ~12 Hz LFO, spatialized at the chopper. */
  startHelicopterLoop(): void {
    const ctx = this.ensureContext()
    if (!ctx || this.heli || !this.sfxBus) return
    try {
      const noise = ctx.createBufferSource()
      noise.buffer = this.getNoise(ctx)
      noise.loop = true
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 210
      bp.Q.value = 0.55
      const thump = ctx.createOscillator()
      thump.type = 'sine'
      thump.frequency.value = 58
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      // Rotor chop LFO: fast enough to blur into a buzz with a beat.
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 12.4
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = 0.55
      lfo.connect(lfoGain).connect(gain.gain)
      const panner = ctx.createPanner()
      panner.panningModel = 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = 30
      panner.maxDistance = 420
      panner.rolloffFactor = 0.85
      noise.connect(bp).connect(gain)
      thump.connect(gain)
      gain.connect(panner).connect(this.sfxBus)
      noise.start()
      thump.start()
      lfo.start()
      gain.gain.setTargetAtTime(0.5, ctx.currentTime, 0.5)
      this.heli = { noise, thump, lfo, gain, panner, repos: 0 }
    } catch {
      /* ignore */
    }
  }

  /** Move the rotor loop's spatial position (throttled internally). */
  updateHelicopterLoop(pos: Vec3): void {
    const h = this.heli
    if (!h) return
    h.repos -= 1 / 60
    if (h.repos > 0) return
    h.repos = 0.5
    this.setNodePosition(h.panner, pos)
  }

  stopHelicopterLoop(): void {
    const h = this.heli
    if (!h) return
    this.heli = null
    const ctx = this.ctx
    try {
      h.gain.gain.setTargetAtTime(0.0001, ctx?.currentTime ?? 0, 0.3)
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        h.noise.stop()
        h.thump.stop()
        h.lfo.stop()
        h.gain.disconnect()
        h.panner.disconnect()
      } catch {
        /* ignore */
      }
    }, 900)
  }

  // =================================================================
  // Context + buses
  // =================================================================

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null
    if (this.ctx) return this.ctx
    if (typeof window === 'undefined') return null
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      const ctx = new Ctor()
      this.ctx = ctx

      // master → destination, music + sfx → master.
      this.masterGain = ctx.createGain()
      this.masterGain.gain.value = this.volumes.master
      this.masterGain.connect(ctx.destination)
      this.musicBus = ctx.createGain()
      this.musicBus.gain.value = this.volumes.music
      this.musicBus.connect(this.masterGain)
      this.sfxBus = ctx.createGain()
      this.sfxBus.gain.value = this.volumes.sfx
      this.sfxBus.connect(this.masterGain)

      this.safeResume()
      this.startMusicPad()
      return ctx
    } catch {
      this.ctx = null
      return null
    }
  }

  private safeResume(): void {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'suspended') return
    try {
      const p = ctx.resume() as unknown as Promise<void> | undefined
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* ignore */
    }
  }

  private setNodePosition(node: AudioNode, pos: Vec3): void {
    try {
      const p = node as PannerNode
      if (typeof p.positionX?.setValueAtTime === 'function') {
        p.positionX.setValueAtTime(pos.x, 0)
        p.positionY.setValueAtTime(pos.y, 0)
        p.positionZ.setValueAtTime(pos.z, 0)
      } else {
        ;(p as MaybeLegacyPanner).setPosition?.(pos.x, pos.y, pos.z)
      }
    } catch {
      /* ignore */
    }
  }

  /** Keep the WebAudio listener glued to the game camera. */
  private updateListener(engine: GameEngine): void {
    const ctx = this.ctx
    if (!ctx) return
    try {
      const cam = engine.camera
      const pos = cam.position
      // Camera forward = -Z basis column of the world matrix.
      const e = cam.matrixWorld.elements
      const fx = -e[8]
      const fy = -e[9]
      const fz = -e[10]
      const l = ctx.listener
      if (typeof l.positionX?.setValueAtTime === 'function') {
        l.positionX.setValueAtTime(pos.x, 0)
        l.positionY.setValueAtTime(pos.y, 0)
        l.positionZ.setValueAtTime(pos.z, 0)
        l.forwardX.setValueAtTime(fx, 0)
        l.forwardY.setValueAtTime(fy, 0)
        l.forwardZ.setValueAtTime(fz, 0)
        l.upX.setValueAtTime(e[4], 0)
        l.upY.setValueAtTime(e[5], 0)
        l.upZ.setValueAtTime(e[6], 0)
      } else {
        const legacy = l as MaybeLegacyListener
        legacy.setPosition?.(pos.x, pos.y, pos.z)
        legacy.setOrientation?.(fx, fy, fz, e[4], e[5], e[6])
      }
      this.tmpFwd.x = fx
      this.tmpFwd.y = fy
      this.tmpFwd.z = fz
    } catch {
      /* ignore */
    }
  }

  // =================================================================
  // One-shot voices
  // =================================================================

  private getNoise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer
    const len = Math.floor(ctx.sampleRate * 2)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuffer = buf
    return buf
  }

  private makeDest(ctx: AudioContext, opts: AudioPlayOptions): AudioNode {
    if (!opts.position || !this.sfxBus) return this.sfxBus ?? ctx.destination
    try {
      const p = ctx.createPanner()
      p.panningModel = 'equalpower'
      p.distanceModel = 'inverse'
      p.refDistance = 7
      p.maxDistance = 160
      p.rolloffFactor = 1.1
      this.setNodePosition(p, opts.position)
      p.connect(this.sfxBus)
      return p
    } catch {
      return this.sfxBus ?? ctx.destination
    }
  }

  private spawnVoice(name: string, opts: AudioPlayOptions): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime

    // Voice cap: steal the oldest one-shot.
    while (this.voices.length >= MAX_VOICES) {
      const victim = this.voices.shift()
      victim?.kill(t)
    }

    const dest = this.makeDest(ctx, opts)
    const out = ctx.createGain()
    out.gain.value = clamp(opts.volume ?? 1, 0, 1.5)
    out.connect(dest)

    const dur = this.buildSound(name, ctx, t, out)
    if (dur <= 0) {
      try {
        out.disconnect()
      } catch {
        /* ignore */
      }
      return
    }
    const endsAt = t + dur
    const voice: OneShotVoice = {
      out,
      endsAt,
      kill: (at: number) => {
        try {
          out.gain.cancelScheduledValues(at)
          out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), at)
          out.gain.exponentialRampToValueAtTime(0.0001, at + 0.03)
          setTimeout(() => {
            try {
              out.disconnect()
            } catch {
              /* ignore */
            }
          }, 80)
        } catch {
          /* ignore */
        }
      },
    }
    this.voices.push(voice)
  }

  /** Envelope helper: exponential attack/decay on a gain param. */
  private env(param: AudioParam, t: number, peak: number, attack: number, decay: number): void {
    param.setValueAtTime(0.0001, t)
    param.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + attack)
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay)
  }

  /** White-noise burst source (random offset into a cached 2 s buffer). */
  private noise(ctx: AudioContext, t: number, dur: number, rate = 1): AudioBufferSourceNode {
    const src = ctx.createBufferSource()
    src.buffer = this.getNoise(ctx)
    src.playbackRate.value = rate
    const max = Math.max(0, src.buffer.duration - dur - 0.01)
    src.start(t, Math.random() * max, dur)
    return src
  }

  /**
   * Build one procedural sound into `out`. Returns its duration in
   * seconds (0 = unknown name → nothing scheduled).
   */
  private buildSound(name: string, ctx: AudioContext, t: number, out: GainNode): number {
    switch (name) {
      case 'gunshot_pistol':
        return this.gunshot(ctx, t, out, { noiseDur: 0.13, bp: 1900, ng: 0.85, thump: [170, 55, 0.09, 0.6] })
      case 'gunshot_smg':
        return this.gunshot(ctx, t, out, { noiseDur: 0.09, bp: 2500, ng: 0.7, thump: [150, 70, 0.05, 0.5] })
      case 'gunshot_rifle':
        return this.gunshot(ctx, t, out, { noiseDur: 0.22, bp: 0, ng: 1.0, thump: [130, 45, 0.16, 0.8], lpSweep: [3200, 350] })
      case 'gunshot_shotgun':
        return this.gunshot(ctx, t, out, { noiseDur: 0.3, bp: 0, ng: 1.1, thump: [110, 40, 0.22, 0.9], lpSweep: [2600, 220] })

      case 'reload':
        // Two clicks (mag out + mag in).
        this.click(ctx, t, out, 900)
        this.click(ctx, t + 0.18, out, 700)
        return 0.28
      case 'reload_start':
        this.click(ctx, t, out, 900)
        return 0.06
      case 'reload_end':
        this.click(ctx, t, out, 620)
        this.click(ctx, t + 0.07, out, 980)
        return 0.13

      case 'footstep': {
        const n = this.noise(ctx, t, 0.07, 0.85 + Math.random() * 0.3)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 480
        const g = ctx.createGain()
        this.env(g.gain, t, 0.3, 0.005, 0.05)
        n.connect(lp).connect(g).connect(out)
        return 0.09
      }

      case 'horn': {
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.45, t + 0.02)
        g.gain.setValueAtTime(0.45, t + 0.32)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 1400
        for (const f of [400, 505]) {
          const o = ctx.createOscillator()
          o.type = 'square'
          o.frequency.value = f
          o.connect(lp)
          o.start(t)
          o.stop(t + 0.5)
        }
        lp.connect(g).connect(out)
        return 0.5
      }

      case 'pickup':
      case 'pickup_chime': {
        for (const [i, freq] of [880, 1318].entries()) {
          const o = ctx.createOscillator()
          o.type = 'sine'
          o.frequency.value = freq
          const g = ctx.createGain()
          this.env(g.gain, t + i * 0.09, 0.3, 0.01, 0.16)
          o.connect(g).connect(out)
          o.start(t + i * 0.09)
          o.stop(t + i * 0.09 + 0.2)
        }
        return 0.3
      }

      case 'race_countdown': {
        // Single bright blip — one per 3/2/1 tick.
        const o = ctx.createOscillator()
        o.type = 'square'
        o.frequency.value = 880
        const g = ctx.createGain()
        this.env(g.gain, t, 0.22, 0.005, 0.12)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 2600
        o.connect(lp).connect(g).connect(out)
        o.start(t)
        o.stop(t + 0.16)
        return 0.18
      }

      case 'race_go': {
        // Rising two-tone GO! (A5 → E6).
        for (const [i, freq] of [880, 1318.5].entries()) {
          const o = ctx.createOscillator()
          o.type = 'square'
          o.frequency.value = freq
          const g = ctx.createGain()
          this.env(g.gain, t + i * 0.11, 0.3, 0.008, 0.22)
          const lp = ctx.createBiquadFilter()
          lp.type = 'lowpass'
          lp.frequency.value = 3000
          o.connect(lp).connect(g).connect(out)
          o.start(t + i * 0.11)
          o.stop(t + i * 0.11 + 0.3)
        }
        return 0.45
      }

      case 'checkpoint': {
        // Quick two-note sweep — brighter than pickup, shorter than a jingle.
        for (const [i, freq] of [1318.5, 1760].entries()) {
          const o = ctx.createOscillator()
          o.type = 'sine'
          o.frequency.value = freq
          const g = ctx.createGain()
          this.env(g.gain, t + i * 0.07, 0.32, 0.008, 0.12)
          o.connect(g).connect(out)
          o.start(t + i * 0.07)
          o.stop(t + i * 0.07 + 0.18)
        }
        return 0.25
      }

      case 'mission_complete': {
        // Three ascending notes (C5 · E5 · G5).
        for (const [i, freq] of [523.25, 659.25, 783.99].entries()) {
          const o = ctx.createOscillator()
          o.type = 'triangle'
          o.frequency.value = freq
          const g = ctx.createGain()
          this.env(g.gain, t + i * 0.13, 0.35, 0.012, 0.14)
          o.connect(g).connect(out)
          o.start(t + i * 0.13)
          o.stop(t + i * 0.13 + 0.19)
        }
        return 0.5
      }

      case 'mission_failed': {
        // Two descending notes (G4 · D4).
        for (const [i, freq] of [392, 293.66].entries()) {
          const o = ctx.createOscillator()
          o.type = 'sawtooth'
          o.frequency.value = freq
          const lp = ctx.createBiquadFilter()
          lp.type = 'lowpass'
          lp.frequency.value = 900
          const g = ctx.createGain()
          this.env(g.gain, t + i * 0.22, 0.3, 0.015, 0.26)
          o.connect(lp).connect(g).connect(out)
          o.start(t + i * 0.22)
          o.stop(t + i * 0.22 + 0.32)
        }
        return 0.6
      }

      case 'ui_click': {
        const o = ctx.createOscillator()
        o.type = 'square'
        o.frequency.value = 1800
        const g = ctx.createGain()
        this.env(g.gain, t, 0.12, 0.002, 0.025)
        o.connect(g).connect(out)
        o.start(t)
        o.stop(t + 0.05)
        const n = this.noise(ctx, t, 0.02)
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 4000
        const ng = ctx.createGain()
        this.env(ng.gain, t, 0.15, 0.002, 0.02)
        n.connect(hp).connect(ng).connect(out)
        return 0.06
      }

      case 'damage':
      case 'damage_thud': {
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.setValueAtTime(100, t)
        o.frequency.exponentialRampToValueAtTime(48, t + 0.12)
        const g = ctx.createGain()
        this.env(g.gain, t, 0.55, 0.004, 0.13)
        o.connect(g).connect(out)
        o.start(t)
        o.stop(t + 0.18)
        const n = this.noise(ctx, t, 0.07)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 700
        const ng = ctx.createGain()
        this.env(ng.gain, t, 0.35, 0.003, 0.07)
        n.connect(lp).connect(ng).connect(out)
        return 0.2
      }

      case 'wanted_up': {
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 1800
        const g = ctx.createGain()
        this.env(g.gain, t, 0.28, 0.01, 0.2)
        lp.connect(g).connect(out)
        for (const [mult, vol] of [[1, 1], [1.5, 0.55]] as const) {
          const o = ctx.createOscillator()
          o.type = 'square'
          o.frequency.setValueAtTime(330 * mult, t)
          o.frequency.exponentialRampToValueAtTime(660 * mult, t + 0.16)
          const og = ctx.createGain()
          og.gain.value = vol
          o.connect(og).connect(lp)
          o.start(t)
          o.stop(t + 0.24)
        }
        return 0.26
      }

      case 'melee': {
        // Whoosh: band-passed noise sweeping up.
        const n = this.noise(ctx, t, 0.13)
        const bp = ctx.createBiquadFilter()
        bp.type = 'bandpass'
        bp.Q.value = 1.4
        bp.frequency.setValueAtTime(350, t)
        bp.frequency.exponentialRampToValueAtTime(1400, t + 0.12)
        const g = ctx.createGain()
        this.env(g.gain, t, 0.3, 0.02, 0.1)
        n.connect(bp).connect(g).connect(out)
        return 0.16
      }

      case 'crash': {
        const n = this.noise(ctx, t, 0.32)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.setValueAtTime(3800, t)
        lp.frequency.exponentialRampToValueAtTime(260, t + 0.3)
        const ng = ctx.createGain()
        this.env(ng.gain, t, 0.9, 0.004, 0.3)
        n.connect(lp).connect(ng).connect(out)
        // Metallic ring (inharmonic partials).
        for (const freq of [813, 1089]) {
          const o = ctx.createOscillator()
          o.type = 'square'
          o.frequency.value = freq
          const g = ctx.createGain()
          this.env(g.gain, t, 0.16, 0.004, 0.3)
          o.connect(g).connect(out)
          o.start(t)
          o.stop(t + 0.36)
        }
        const thump = ctx.createOscillator()
        thump.type = 'sine'
        thump.frequency.setValueAtTime(90, t)
        thump.frequency.exponentialRampToValueAtTime(38, t + 0.18)
        const tg = ctx.createGain()
        this.env(tg.gain, t, 0.6, 0.004, 0.19)
        thump.connect(tg).connect(out)
        thump.start(t)
        thump.stop(t + 0.24)
        return 0.4
      }

      case 'explosion': {
        // Deep boom: sub-sine drop + roaring noise + crack transient.
        const boom = ctx.createOscillator()
        boom.type = 'sine'
        boom.frequency.setValueAtTime(150, t)
        boom.frequency.exponentialRampToValueAtTime(26, t + 0.65)
        const bg = ctx.createGain()
        this.env(bg.gain, t, 1.0, 0.006, 0.65)
        boom.connect(bg).connect(out)
        boom.start(t)
        boom.stop(t + 0.7)

        const roar = this.noise(ctx, t, 1.1)
        const rlp = ctx.createBiquadFilter()
        rlp.type = 'lowpass'
        rlp.frequency.setValueAtTime(2600, t)
        rlp.frequency.exponentialRampToValueAtTime(180, t + 0.9)
        const rg = ctx.createGain()
        this.env(rg.gain, t, 0.8, 0.004, 0.95)
        roar.connect(rlp).connect(rg).connect(out)

        const crack = this.noise(ctx, t, 0.12)
        const chp = ctx.createBiquadFilter()
        chp.type = 'highpass'
        chp.frequency.value = 2200
        const cg = ctx.createGain()
        this.env(cg.gain, t, 0.7, 0.002, 0.1)
        crack.connect(chp).connect(cg).connect(out)
        return 0.55
      }

      default:
        return 0
    }
  }

  /** Gunshot = noise crack (+ optional lowpass sweep) + sine body thump. */
  private gunshot(
    ctx: AudioContext,
    t: number,
    out: GainNode,
    cfg: {
      noiseDur: number
      bp: number // 0 = lowpass sweep instead of bandpass
      ng: number
      thump: [from: number, to: number, dur: number, gain: number]
      lpSweep?: [from: number, to: number]
    },
  ): number {
    const n = this.noise(ctx, t, cfg.noiseDur)
    const g = ctx.createGain()
    this.env(g.gain, t, cfg.ng, 0.002, cfg.noiseDur)
    if (cfg.bp > 0) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = cfg.bp
      bp.Q.value = 0.8
      n.connect(bp).connect(g)
    } else {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(cfg.lpSweep?.[0] ?? 3000, t)
      lp.frequency.exponentialRampToValueAtTime(cfg.lpSweep?.[1] ?? 300, t + cfg.noiseDur)
      n.connect(lp).connect(g)
    }
    g.connect(out)

    const [from, to, dur, gain] = cfg.thump
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(from, t)
    o.frequency.exponentialRampToValueAtTime(to, t + dur)
    const og = ctx.createGain()
    this.env(og.gain, t, gain, 0.003, dur)
    o.connect(og).connect(out)
    o.start(t)
    o.stop(t + dur + 0.05)

    return cfg.noiseDur + 0.06
  }

  /** Mechanical click (reload, dry fire). */
  private click(ctx: AudioContext, t: number, out: GainNode, freq: number): void {
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = freq
    const g = ctx.createGain()
    this.env(g.gain, t, 0.35, 0.002, 0.03)
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + 0.05)
    const n = this.noise(ctx, t, 0.018)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 2800
    const ng = ctx.createGain()
    this.env(ng.gain, t, 0.2, 0.002, 0.018)
    n.connect(hp).connect(ng).connect(out)
  }

  // =================================================================
  // Footsteps (self-driven — cadence follows actual move speed)
  // =================================================================

  private updateFootsteps(engine: GameEngine, dt: number): void {
    const player = engine.player
    if (
      engine.vehicles.playerVehicleId !== null ||
      player.dead ||
      player.swimming ||
      !player.grounded
    ) {
      this.stepTimer = 0.15
      return
    }
    const speed = Math.hypot(player.velocity.x, player.velocity.z)
    if (speed < 0.6) {
      this.stepTimer = Math.max(this.stepTimer, 0.15)
      return
    }
    this.stepTimer -= dt
    if (this.stepTimer <= 0) {
      this.stepTimer = clamp(1.6 / speed, 0.3, 0.62)
      this.play('footstep', { volume: speed > 5 ? 0.8 : 0.55 })
    }
  }

  // =================================================================
  // Continuous loops: engine / siren / music pad
  // =================================================================

  private startEngineLoop(): void {
    const ctx = this.ensureContext()
    if (!ctx || this.engineLoop || !this.sfxBus) return
    try {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = ENGINE_HZ_MIN
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 700
      filter.Q.value = 1.2
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      osc.connect(filter).connect(gain).connect(this.sfxBus)
      osc.start()
      gain.gain.setTargetAtTime(0.12, ctx.currentTime, 0.3)
      this.engineLoop = { osc, filter, gain }
    } catch {
      /* ignore */
    }
  }

  private stopEngineLoop(): void {
    const loop = this.engineLoop
    if (!loop) return
    this.engineLoop = null
    const ctx = this.ctx
    try {
      loop.gain.gain.setTargetAtTime(0.0001, ctx?.currentTime ?? 0, 0.12)
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        loop.osc.stop()
        loop.gain.disconnect()
      } catch {
        /* ignore */
      }
    }, 600)
  }

  private startSiren(): void {
    const ctx = this.ensureContext()
    if (!ctx || this.siren || !this.sfxBus) return
    try {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = SIREN_LOW
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      const panner = ctx.createPanner()
      panner.panningModel = 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = 12
      panner.maxDistance = 220
      panner.rolloffFactor = 0.9
      osc.connect(gain).connect(panner).connect(this.sfxBus)
      osc.start()
      gain.gain.setTargetAtTime(0.16, ctx.currentTime, 0.4)
      this.siren = { osc, gain, panner, high: false, swap: SIREN_SWAP_SEC, repos: 0 }
      this.positionSiren()
    } catch {
      /* ignore */
    }
  }

  private stopSiren(): void {
    const s = this.siren
    if (!s) return
    this.siren = null
    const ctx = this.ctx
    try {
      s.gain.gain.setTargetAtTime(0.0001, ctx?.currentTime ?? 0, 0.2)
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        s.osc.stop()
        s.gain.disconnect()
        s.panner.disconnect()
      } catch {
        /* ignore */
      }
    }, 800)
  }

  /** Park the siren at the nearest police officer (fallback: behind player). */
  private positionSiren(): void {
    const engine = this.engine
    const s = this.siren
    if (!engine || !s) return
    const player = engine.player.position
    let best: { x: number; y: number; z: number } | null = null
    let bestDist = Infinity
    const npcsSystem = engine.systems.npcs as unknown as
      | { getNPCs?: () => { type: string; position: Vec3; alive: boolean }[] }
      | undefined
    const list = npcsSystem?.getNPCs?.() ?? []
    for (const n of list) {
      if (!n.alive || (n.type !== 'police' && n.type !== 'swat')) continue
      const d = Math.hypot(n.position.x - player.x, n.position.z - player.z)
      if (d < bestDist) {
        bestDist = d
        best = { x: n.position.x, y: n.position.y + 1, z: n.position.z }
      }
    }
    if (!best) {
      // No police spawned yet — keep the siren audible but distant.
      best = {
        x: player.x - this.tmpFwd.x * 30,
        y: player.y + 1,
        z: player.z - this.tmpFwd.z * 30,
      }
    }
    this.setNodePosition(s.panner, best)
  }

  /** Quiet ambient pad: two detuned saws + slow gain LFO on the music bus. */
  private startMusicPad(): void {
    const ctx = this.ctx
    if (!ctx || this.pad || !this.musicBus) return
    try {
      const oscA = ctx.createOscillator()
      oscA.type = 'sawtooth'
      oscA.frequency.value = 55 // A1
      const oscB = ctx.createOscillator()
      oscB.type = 'sawtooth'
      oscB.frequency.value = 55.35 // ~+11 cents detune
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 320
      const gain = ctx.createGain()
      const base = 0.045
      gain.gain.value = base
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 0.07
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = 0.018
      lfo.connect(lfoGain).connect(gain.gain)
      oscA.connect(lp)
      oscB.connect(lp)
      lp.connect(gain).connect(this.musicBus)
      oscA.start()
      oscB.start()
      lfo.start()
      this.pad = { oscA, oscB, gain, lfo, base }
      this.padWanted = -1 // force refresh on first update
    } catch {
      /* ignore */
    }
  }

  private stopMusicPad(): void {
    const pad = this.pad
    if (!pad) return
    this.pad = null
    const ctx = this.ctx
    try {
      pad.gain.gain.setTargetAtTime(0.0001, ctx?.currentTime ?? 0, 0.15)
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        pad.oscA.stop()
        pad.oscB.stop()
        pad.lfo.stop()
        pad.gain.disconnect()
      } catch {
        /* ignore */
      }
    }, 700)
  }
}
