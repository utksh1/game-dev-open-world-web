/**
 * RadioSystem — procedural radio stations for the ride (round-5 feature).
 *
 * Five fully synthesized stations, no audio assets: a step-sequencer
 * schedules bars ahead of the WebAudio clock from update() (fixed step),
 * so music pauses naturally with the sim and never drifts:
 *
 *   0 · PULSE FM    — synthwave: driving 8th-note bass, 4-on-the-floor
 *                     kick, snare 2&4, arpeggio lead, warm pad chords.
 *   1 · DUST 95.4   — lo-fi chill: swung drums, mellow 7th chords on a
 *                     triangle wave, vinyl crackle ticks.
 *   2 · RIOT RADIO  — punk: fast power-chord saws, aggressive drums.
 *   3 · NIGHT DRIVE — ambient: slow stacked chord swells + echoing arp.
 *   4 · EMPIRE TALK — talk radio: a "DJ" voice (bandpassed sawtooth with
 *                     syllable envelopes) over static, callers, breaks.
 *
 * Behavior: auto-plays while the player drives (vehicleEntered), pauses on
 * exit (vehicleExited). R while driving = next station (the engine routes
 * it — R on foot still reloads). Output lands on the AudioSystem music
 * bus, so the settings' music slider governs it, and the ambient pad
 * ducks while a station is on. The chosen station persists in ow_settings.
 *
 * Registered as engine system 'radio'.
 */
import type { EngineSystem, GameEngine } from '@/game/engine'

// ---------------------------------------------------------------------
// Station metadata (mirrored by the HUD widget via engineViews)
// ---------------------------------------------------------------------

export interface RadioStationMeta {
  id: string
  name: string
  tagline: string
  /** Tailwind-friendly accent (amber/rose/emerald/zinc/orange — no blue). */
  accent: string
  bpm: number
  /** On-air host (round 8 DJ interludes + widget credit). */
  dj: string
}

export const RADIO_STATIONS: RadioStationMeta[] = [
  { id: 'pulse', name: 'PULSE FM', tagline: 'neon all night', accent: '#f59e0b', bpm: 108, dj: 'DJ NOVA' },
  { id: 'dust', name: 'DUST 95.4', tagline: 'dusty loops for slow streets', accent: '#a78b4a', bpm: 76, dj: 'MOSS' },
  { id: 'riot', name: 'RIOT RADIO', tagline: 'three chords & the truth', accent: '#f43f5e', bpm: 172, dj: 'RIOT ROSA' },
  { id: 'night', name: 'NIGHT DRIVE', tagline: 'fm waves for empty highways', accent: '#10b981', bpm: 60, dj: 'THE NIGHTOWL' },
  { id: 'talk', name: 'EMPIRE TALK', tagline: 'the city talks back', accent: '#d4d4d8', bpm: 96, dj: 'BARRY BLUNT' },
]

export interface RadioState {
  /** Station index into RADIO_STATIONS, or null when the radio is OFF. */
  station: number | null
  playing: boolean
  trackTitle: string
  /** ~0..1 sequencer phase for the widget's EQ bars. */
  level: number
  /** Round 8: the line the DJ is "saying" right now (null between
   *  interludes) + the host name — the widget swaps the track line for
   *  an ON AIR credit while this is live. */
  djLine: string | null
  djName: string | null
}

interface AudioView {
  getMusicBus?: () => GainNode | null
  getAudioContext?: () => AudioContext | null
  setPadSuppressed?: (on: boolean) => void
}

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const LOOKAHEAD_SEC = 0.35 // schedule this far ahead of the audio clock
const BARS_PER_TRACK = 8 // new "track" (title) every 8 bars
const RADIO_MASTER_GAIN = 0.5
const FADE_SEC = 0.35

// Procedural track-title word banks per station.
const TITLE_WORDS: Record<string, [string[], string[]]> = {
  pulse: [
    ['NEON', 'CHROME', 'MIDNIGHT', 'TURBO', 'LASER', 'ELECTRIC', 'PHANTOM', 'SUNSET'],
    ['REVENGE', 'HIGHWAY', 'HEARTBEAT', 'CASCADE', 'PURSUIT', 'MIRAGE', 'OVERDRIVE', 'DREAMS'],
  ],
  dust: [
    ['SUNDAY', 'VELVET', 'RAINFALL', 'PAPER', 'SLOW', 'HONEY', 'CORNER', 'ORANGE'],
    ['CAFÉ', 'STATIC', 'SUNROOM', 'TAPES', 'AFTERNOON', 'WINDOW', 'SMOKE', 'LOOPS'],
  ],
  riot: [
    ['CONCRETE', 'BROKEN', 'RAT RACE', ' LAST TRAIN', 'DIRT', 'RIOT', 'STATIC', 'BURNING'],
    ['CITY', 'KIDS', 'NIGHTS', 'ANTHEM', 'GUTTER', 'WEEKEND', 'SIRENS', 'PROMISE'],
  ],
  night: [
    ['PALE', 'DISTANT', 'EMPTY', 'QUIET', 'SLOW', 'FADING', 'COASTAL', '3AM'],
    ['SKYLINE', 'HEADLIGHTS', 'TIDE', 'SIGNAL', 'PASSAGE', 'MOTEL', 'HORIZON', 'GLOW'],
  ],
  talk: [
    ['THE TRUTH ABOUT', 'EXCLUSIVE:', 'DEBATE:', 'CALLERS ON', 'LIVE FROM', 'RERUN:', 'WEEKDAY', 'CITY COUNCIL'],
    ['THE DOCKS', 'STREET RACING', 'POLICE BUDGET', 'THE MAYOR', 'TRAFFIC', 'THE HEIST', 'NOBODY', 'EVERYTHING'],
  ],
}

// Round 8 — DJ interlude line banks (music stations only; TALK already
// is the DJ). One line is picked per interlude and "spoken" over a
// static bed between tracks, mirrored in the radio widget as ON AIR.
const DJ_LINES: Record<string, string[]> = {
  pulse: [
    'You are locked into PULSE — the night shift starts now',
    'This one goes out to everyone still driving',
    'Charging up the grid — stay electric out there',
    'Four on the floor, all night long — PULSE FM',
  ],
  dust: [
    'Easy like Sunday morning, every morning',
    'DUST 95.4 — warm hiss, cold coffee',
    'Slow down. The city can wait five minutes',
    'That tape wore out in all the right places',
  ],
  riot: [
    'TURN IT UP — the neighbors already hate you',
    'Three chords and the truth, city kids',
    'LOUDER than your landlord — RIOT RADIO',
    'This one is for the rat race runners',
  ],
  night: [
    'Empty highways, full hearts — NIGHT DRIVE',
    'Keep your eyes on the skyline',
    'No requests tonight — only roads',
    'This frequency goes out to the 3AM faithful',
  ],
}

/** Per-station DJ voice pitch (Hz) — flavor, not realism. */
const DJ_VOICE_HZ: Record<string, number> = {
  pulse: 148,
  dust: 118,
  riot: 156,
  night: 106,
}

/** Chance a track change gets a DJ interlude first. */
const DJ_INTERLUDE_CHANCE = 0.55

// Chord banks (Hz) — built from equal-temperament helpers below.
function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

const PULSE_BASS = [40, 40, 43, 45] // E2 E2 G2 A2
const PULSE_ARP = [64, 67, 71, 74] // E4 G4 B4 D5
const PULSE_CHORDS = [
  [52, 59, 64], // Em
  [48, 55, 60], // C
  [55, 62, 67], // G
  [50, 57, 62], // D
]
const DUST_CHORDS = [
  [53, 57, 60, 64], // Fmaj7
  [52, 55, 59, 62], // Em7
  [50, 53, 57, 60], // Dm7
  [48, 52, 55, 59], // Cmaj7
]
const RIOT_ROOTS = [40, 40, 43, 45, 40, 40, 38, 43] // E E G A E E D G (per bar)
const NIGHT_CHORDS = [
  [57, 64, 69, 71], // Am9-ish
  [53, 60, 65, 67], // Fmaj9-ish
  [55, 62, 67, 69], // G(9)
  [50, 57, 62, 64], // D(m9)
]

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class RadioSystem implements EngineSystem {
  private engine: GameEngine | null = null
  private disposed = false

  /** null = OFF. Index into RADIO_STATIONS. */
  private station: number | null = 0
  private playing = false

  // Audio graph (lazily connected to the AudioSystem music bus).
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private delay: DelayNode | null = null

  // Sequencer clock (all in AudioContext time).
  private nextBarTime = 0
  private barIndex = 0
  private trackSeed = 1
  private trackTitle = ''
  private level = 0
  private levelDecay = 0

  private titleTrackCounter = 0

  // Round 8 — DJ interlude state (music stations).
  /** Bars of DJ talk left to schedule (0 = none pending). */
  private djBars = 0
  /** True while a title roll is deferred until the interlude ends. */
  private pendingTitleRoll = false
  private djLine: string | null = null
  /** Wall-clock ms until the DJ line stops being "on air". */
  private djLineUntil = 0

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.disposed = false

    engine.onEvent((evt) => {
      if (this.disposed) return
      if (evt.type === 'vehicleEntered') this.setPlaying(true)
      else if (evt.type === 'vehicleExited') this.setPlaying(false)
    })
  }

  update(dt: number): void {
    if (this.disposed) return
    this.levelDecay -= dt
    if (this.levelDecay <= 0) this.level = Math.max(0, this.level - dt * 3)

    if (!this.playing || this.station === null) return

    const audio = this.audio()
    const ctx = audio?.getAudioContext?.() ?? null
    if (!ctx) return

    if (this.ctx !== ctx || !this.out) {
      this.connect(ctx, audio)
      if (!this.out) return
    }

    // Schedule bars until the lookahead window is filled.
    const beat = 60 / RADIO_STATIONS[this.station].bpm
    const barDur = beat * 4
    while (this.nextBarTime < ctx.currentTime + LOOKAHEAD_SEC) {
      const t = Math.max(this.nextBarTime, ctx.currentTime + 0.02)
      this.scheduleBar(t, beat)
      this.nextBarTime = t + barDur
      this.barIndex++
      this.titleTrackCounter++
      if (this.titleTrackCounter >= BARS_PER_TRACK) {
        this.titleTrackCounter = 0
        const id = RADIO_STATIONS[this.station].id
        if (
          this.station !== null &&
          DJ_LINES[id] &&
          this.djBars <= 0 &&
          Math.random() < DJ_INTERLUDE_CHANCE
        ) {
          // DJ interlude: 2 bars of talk, THEN the new track title.
          this.djBars = 2
          this.pendingTitleRoll = true
          this.djLine = DJ_LINES[id][Math.floor(Math.random() * DJ_LINES[id].length)]
          this.djLineUntil = performance.now() + barDur * 2 * 1000 + 250
        } else {
          this.rollTrackTitle()
        }
      }
      this.level = 1
      this.levelDecay = 0.12
    }
  }

  dispose(): void {
    this.teardown()
    this.engine = null
  }

  getSaveData(): Record<string, unknown> {
    return { radioStation: this.station }
  }
  applySaveData(data: Record<string, unknown>): void {
    const v = data.radioStation
    if (typeof v === 'number' && v >= 0 && v < RADIO_STATIONS.length) this.station = v
    else if (v === null || v === -1) this.station = null
  }

  // =================================================================
  // Public API (HUD widget / engine facade / settings boot)
  // =================================================================

  /** Cycle +1 (wraps: last station → OFF → first). */
  nextStation(): void {
    if (this.station === null) this.setStation(0)
    else if (this.station >= RADIO_STATIONS.length - 1) this.setStation(null)
    else this.setStation(this.station + 1)
  }
  prevStation(): void {
    this.setStation(this.station === null ? RADIO_STATIONS.length - 1 : this.station - 1)
  }

  /** Absolute set; null = OFF. -1 also means OFF (settings serialization). */
  setStation(index: number | null): void {
    const engine = this.engine
    if (index === -1) index = null
    if (index !== null) {
      if (!Number.isInteger(index) || index < 0 || index >= RADIO_STATIONS.length) return
    }
    const changed = index !== this.station
    this.station = index
    if (index === null) {
      const wasPlaying = this.playing
      this.setPlaying(false)
      // Toast only for in-session player action (not boot restore).
      if (engine && changed && wasPlaying) engine.notify('📻 Radio off', 'info')
      return
    }
    // Fresh track on every hop.
    this.barIndex = 0
    this.titleTrackCounter = 0
    this.clearDj()
    this.trackSeed = (Math.random() * 0xffffffff) >>> 0
    this.rollTrackTitle()
    const driving = !!engine && engine.vehicles.playerVehicleId !== null
    if (driving) this.setPlaying(true)
    const meta = RADIO_STATIONS[index]
    // Only toast when the change is player-initiated in-session (boot-time
    // restore of the persisted setting stays silent).
    if (engine && changed && (driving || this.playing)) {
      engine.notify(`📻 ${meta.name} — “${this.trackTitle}”`, 'info')
    }
  }

  getRadioState(): RadioState {
    const onAir = this.djLine !== null && performance.now() < this.djLineUntil
    return {
      station: this.station,
      playing: this.playing && this.station !== null,
      trackTitle: this.station === null ? '' : this.trackTitle,
      level: this.level,
      djLine: onAir ? this.djLine : null,
      djName:
        this.station === null
          ? null
          : onAir
            ? RADIO_STATIONS[this.station].dj
            : null,
    }
  }

  /** Engine facade helper: is the sequencer live right now. */
  isPlaying(): boolean {
    return this.playing && this.station !== null
  }

  // =================================================================
  // Internals — transport
  // =================================================================

  private setPlaying(on: boolean): void {
    if (this.disposed) return
    const want = on && this.station !== null
    if (want === this.playing) return
    this.playing = want
    const ctx = this.ctx
    if (this.out && ctx) {
      try {
        this.out.gain.setTargetAtTime(want ? RADIO_MASTER_GAIN : 0.0001, ctx.currentTime, FADE_SEC)
      } catch {
        /* ignore */
      }
    }
    this.audio()?.setPadSuppressed?.(want)
    if (want) {
      // Resume from "now" so the first bar is immediate.
      this.barIndex = 0
      this.titleTrackCounter = 0
      this.clearDj()
      this.nextBarTime = 0 // clamped in update()
      if (!this.trackTitle) this.rollTrackTitle()
    }
  }

  /** Cancel any pending DJ interlude (station hop / transport restart). */
  private clearDj(): void {
    this.djBars = 0
    this.pendingTitleRoll = false
    this.djLine = null
    this.djLineUntil = 0
  }

  private connect(ctx: AudioContext, audio: AudioView | null): void {
    const bus = audio?.getMusicBus?.() ?? null
    if (!bus) return
    try {
      const out = ctx.createGain()
      out.gain.value = this.playing ? RADIO_MASTER_GAIN : 0.0001
      out.connect(bus)
      // A touch of slap delay gives synth lines space (used by NIGHT/arp).
      const delay = ctx.createDelay(1.0)
      delay.delayTime.value = 0.28
      const fb = ctx.createGain()
      fb.gain.value = 0.32
      const wet = ctx.createGain()
      wet.gain.value = 0.22
      delay.connect(fb).connect(delay)
      delay.connect(wet).connect(out)
      this.ctx = ctx
      this.out = out
      this.delay = delay
      this.nextBarTime = Math.max(this.nextBarTime, ctx.currentTime + 0.05)
    } catch {
      this.out = null
    }
  }

  private teardown(): void {
    this.disposed = true
    this.playing = false
    this.audio()?.setPadSuppressed?.(false)
    const out = this.out
    const ctx = this.ctx
    this.out = null
    this.delay = null
    this.ctx = null
    if (out && ctx) {
      try {
        out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.1)
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          out.disconnect()
        } catch {
          /* ignore */
        }
      }, 500)
    }
  }

  private audio(): AudioView | null {
    return (this.engine?.systems.audio as unknown as AudioView | undefined) ?? null
  }

  private rollTrackTitle(): void {
    const idx = this.station ?? 0
    const id = RADIO_STATIONS[idx].id
    const banks = TITLE_WORDS[id] ?? TITLE_WORDS.pulse
    const rnd = mulberry(this.trackSeed + this.barIndex * 7919)
    const a = banks[0][Math.floor(rnd() * banks[0].length)]
    const b = banks[1][Math.floor(rnd() * banks[1].length)]
    this.trackTitle = `${a} ${b}`.replace(/\s+/g, ' ').trim()
    if (this.titleTrackCounter === 0) this.trackSeed = (rnd() * 0xffffffff) >>> 0
  }

  // =================================================================
  // Internals — synth voices (all schedule at absolute times)
  // =================================================================

  private noise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf
    const len = Math.floor(ctx.sampleRate * 1.5)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuf = buf
    return buf
  }

  private env(param: AudioParam, t: number, peak: number, attack: number, release: number): void {
    param.setValueAtTime(0.0001, t)
    param.linearRampToValueAtTime(peak, t + attack)
    param.exponentialRampToValueAtTime(0.0001, t + attack + release)
  }

  private tone(
    t: number,
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    opts?: { detune?: number; lp?: number; dest?: AudioNode },
  ): void {
    const ctx = this.ctx
    const out = this.out
    if (!ctx || !out) return
    try {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = freq
      if (opts?.detune) o.detune.value = opts.detune
      const g = ctx.createGain()
      this.env(g.gain, t, vol, Math.min(0.02, dur * 0.2), dur)
      let dest: AudioNode = opts?.dest ?? out
      if (opts?.lp) {
        const f = ctx.createBiquadFilter()
        f.type = 'lowpass'
        f.frequency.value = opts.lp
        o.connect(g).connect(f).connect(dest)
      } else {
        o.connect(g).connect(dest)
      }
      o.start(t)
      o.stop(t + dur + 0.1)
    } catch {
      /* ignore */
    }
  }

  private kick(t: number, vol = 0.9): void {
    const ctx = this.ctx
    const out = this.out
    if (!ctx || !out) return
    try {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(130, t)
      o.frequency.exponentialRampToValueAtTime(42, t + 0.11)
      const g = ctx.createGain()
      this.env(g.gain, t, vol, 0.002, 0.16)
      o.connect(g).connect(out)
      o.start(t)
      o.stop(t + 0.22)
    } catch {
      /* ignore */
    }
  }

  private snare(t: number, vol = 0.5, bright = 1900): void {
    const ctx = this.ctx
    const out = this.out
    if (!ctx || !out) return
    try {
      const n = ctx.createBufferSource()
      n.buffer = this.noise(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = bright
      bp.Q.value = 0.9
      const g = ctx.createGain()
      this.env(g.gain, t, vol, 0.002, 0.14)
      n.connect(bp).connect(g).connect(out)
      n.start(t, Math.random())
      n.stop(t + 0.2)
      const o = ctx.createOscillator()
      o.type = 'triangle'
      o.frequency.value = 196
      const og = ctx.createGain()
      this.env(og.gain, t, vol * 0.5, 0.002, 0.08)
      o.connect(og).connect(out)
      o.start(t)
      o.stop(t + 0.12)
    } catch {
      /* ignore */
    }
  }

  private hat(t: number, vol = 0.22, dur = 0.045): void {
    const ctx = this.ctx
    const out = this.out
    if (!ctx || !out) return
    try {
      const n = ctx.createBufferSource()
      n.buffer = this.noise(ctx)
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 7200
      const g = ctx.createGain()
      this.env(g.gain, t, vol, 0.001, dur)
      n.connect(hp).connect(g).connect(out)
      n.start(t, Math.random())
      n.stop(t + dur + 0.05)
    } catch {
      /* ignore */
    }
  }

  /** Bandpassed "voice" syllable — the EMPIRE TALK DJ & callers. */
  private voiceSyllable(t: number, dur: number, baseHz: number, vol: number): void {
    const ctx = this.ctx
    const out = this.out
    if (!ctx || !out) return
    try {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.setValueAtTime(baseHz * (0.92 + Math.random() * 0.16), t)
      // wandering pitch = speech-ish inflection
      o.frequency.linearRampToValueAtTime(baseHz * (0.85 + Math.random() * 0.3), t + dur)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 900 + Math.random() * 700
      bp.Q.value = 2.4
      const g = ctx.createGain()
      this.env(g.gain, t, vol, 0.015, dur)
      o.connect(bp).connect(g).connect(out)
      o.start(t)
      o.stop(t + dur + 0.05)
    } catch {
      /* ignore */
    }
  }

  private staticBed(t: number, dur: number): void {
    const ctx = this.ctx
    const out = this.out
    if (!ctx || !out) return
    try {
      const n = ctx.createBufferSource()
      n.buffer = this.noise(ctx)
      n.loop = true
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 2600
      bp.Q.value = 0.4
      const g = ctx.createGain()
      g.gain.value = 0.028
      n.connect(bp).connect(g).connect(out)
      n.start(t)
      n.stop(t + dur)
    } catch {
      /* ignore */
    }
  }

  // -----------------------------------------------------------------
  // Per-station bar scheduling
  // -----------------------------------------------------------------

  private scheduleBar(t: number, beat: number): void {
    const station = this.station
    if (station === null) return
    // Round 8: a pending DJ interlude preempts the music bars (the
    // sequencer keeps time through it — the next track starts on the
    // grid the moment the DJ hands back).
    if (this.djBars > 0) {
      this.barDJ(t, beat, this.djBars)
      this.djBars--
      if (this.djBars === 0 && this.pendingTitleRoll) {
        this.pendingTitleRoll = false
        this.rollTrackTitle()
      }
      return
    }
    switch (RADIO_STATIONS[station].id) {
      case 'pulse':
        this.barPulse(t, beat)
        break
      case 'dust':
        this.barDust(t, beat)
        break
      case 'riot':
        this.barRiot(t, beat)
        break
      case 'night':
        this.barNight(t, beat)
        break
      case 'talk':
        this.barTalk(t, beat)
        break
      default:
        break
    }
  }

  /**
   * Round 8 — music-station DJ interlude bar. First bar (which === 2):
   * static bed + station-pitched "voice" syllables + a soft heartbeat
   * kick so the mix never goes fully dead. Second bar (which === 1):
   * station-ID jingle (three ascending tones through the delay, like
   * the EMPIRE TALK logo) + a short voice tag.
   */
  private barDJ(t: number, beat: number, which: number): void {
    const station = this.station
    if (station === null) return
    const id = RADIO_STATIONS[station].id
    const voice = DJ_VOICE_HZ[id] ?? 132
    const rnd = mulberry(this.trackSeed + this.barIndex * 409)
    const barDur = beat * 4
    this.staticBed(t, barDur)
    if (which === 2) {
      // Chatter across the bar with speech-ish pauses.
      let tt = t + beat * 0.15
      while (tt < t + barDur * 0.92) {
        const dur = 0.07 + rnd() * 0.13
        if (rnd() > 0.16) this.voiceSyllable(tt, dur, voice, 0.17)
        tt += dur + (rnd() < 0.24 ? 0.1 + rnd() * 0.18 : 0.02)
      }
      // Soft heartbeat kick keeps the pulse alive under the talk.
      this.kick(t, 0.3)
      this.kick(t + beat * 2.5, 0.22)
    } else {
      // Station-ID jingle.
      for (const [i, m] of [72, 76, 79].entries()) {
        this.tone(t + i * 0.16, hz(m), 0.22, 'triangle', 0.15, { dest: this.delay ?? undefined })
        this.tone(t + i * 0.16, hz(m), 0.22, 'triangle', 0.11)
      }
      this.tone(t + 0.55, hz(67), 0.5, 'sine', 0.13)
      // Short voice tag ("...stay with us").
      let tt = t + beat * 2.4
      while (tt < t + barDur * 0.95) {
        const dur = 0.06 + rnd() * 0.1
        if (rnd() > 0.2) this.voiceSyllable(tt, dur, voice * 1.05, 0.13)
        tt += dur + 0.03
      }
    }
  }

  /** PULSE FM — synthwave. */
  private barPulse(t: number, beat: number): void {
    const eighth = beat / 2
    const sixteenth = beat / 4
    const rnd = mulberry(this.trackSeed + this.barIndex * 131)
    // drums
    for (let i = 0; i < 4; i++) {
      this.kick(t + i * beat, 0.85)
      this.snare(t + i * beat + beat / 2, 0.4)
      this.hat(t + i * beat, 0.16)
      this.hat(t + i * beat + eighth, 0.1)
      this.hat(t + i * beat + beat / 2, 0.14)
      this.hat(t + i * beat + beat / 2 + eighth, 0.09)
    }
    // bass: driving 8ths, root motion per beat
    for (let i = 0; i < 4; i++) {
      const root = PULSE_BASS[i]
      for (let j = 0; j < 2; j++) {
        const f = hz(root + (j === 1 && rnd() < 0.2 ? 12 : 0))
        this.tone(t + i * beat + j * eighth, f, eighth * 0.9, 'sawtooth', 0.34, { lp: 700 })
      }
    }
    // pad chord (whole bar)
    const chord = PULSE_CHORDS[this.barIndex % PULSE_CHORDS.length]
    for (const m of chord) {
      this.tone(t, hz(m), beat * 4, 'sawtooth', 0.06, { lp: 1400, detune: 6 })
      this.tone(t, hz(m), beat * 4, 'sawtooth', 0.05, { lp: 1400, detune: -6 })
    }
    // arp lead every other bar (16ths, echoing)
    if (this.barIndex % 2 === 1 && this.delay) {
      for (let i = 0; i < 8; i++) {
        if (rnd() < 0.22) continue
        const m = PULSE_ARP[i % PULSE_ARP.length] + (i >= 4 ? 12 : 0)
        this.tone(t + i * 2 * sixteenth, hz(m), sixteenth * 1.6, 'square', 0.1, {
          lp: 3200,
          dest: this.delay,
        })
        this.tone(t + i * 2 * sixteenth, hz(m), sixteenth * 1.6, 'square', 0.06, { lp: 3200 })
      }
    }
  }

  /** DUST 95.4 — lo-fi with swing. */
  private barDust(t: number, beat: number): void {
    const swing = beat * 0.58 // swung 8th
    const rnd = mulberry(this.trackSeed + this.barIndex * 977)
    // lazy drums: kick 1 & 3+swing, snare 2 & 4, hats swung
    this.kick(t, 0.6)
    this.kick(t + 2 * beat + swing, 0.5)
    this.snare(t + beat, 0.3, 1500)
    this.snare(t + 3 * beat, 0.32, 1500)
    for (let i = 0; i < 8; i++) {
      this.hat(t + (i >> 1) * beat + (i % 2 ? swing : 0), i % 2 ? 0.05 : 0.08, 0.06)
    }
    // mellow 7th chord stabs on the triangle wave
    const chord = DUST_CHORDS[this.barIndex % DUST_CHORDS.length]
    const hit = (when: number, vol: number): void => {
      for (const m of chord) this.tone(when, hz(m), 0.6, 'triangle', vol, { lp: 1100 })
    }
    hit(t, 0.12)
    hit(t + 2 * beat + swing, 0.1)
    if (rnd() < 0.4) hit(t + 3 * beat + beat / 2, 0.07)
    // walking bass on the root
    const root = chord[0] - 24
    this.tone(t, hz(root), beat * 1.4, 'sine', 0.3)
    this.tone(t + 2 * beat + swing, hz(root + (rnd() < 0.5 ? 7 : 5)), beat * 1.2, 'sine', 0.26)
    // vinyl crackle: sparse ticks
    for (let i = 0; i < 10; i++) {
      if (rnd() < 0.5) continue
      this.hat(t + rnd() * beat * 4, 0.03 + rnd() * 0.02, 0.012)
    }
  }

  /** RIOT RADIO — punk. */
  private barRiot(t: number, beat: number): void {
    const eighth = beat / 2
    const rnd = mulberry(this.trackSeed + this.barIndex * 313)
    const root = RIOT_ROOTS[this.barIndex % RIOT_ROOTS.length]
    // drums: fast 8th kicks, snare 2 & 4, crash-y open hat each bar start
    for (let i = 0; i < 8; i++) {
      this.kick(t + i * eighth, i % 2 === 0 ? 0.7 : 0.4)
      this.hat(t + i * eighth, 0.14, i === 0 ? 0.22 : 0.05)
    }
    this.snare(t + beat, 0.55, 2400)
    this.snare(t + 3 * beat, 0.55, 2400)
    if (this.barIndex % 4 === 3) {
      this.snare(t + 3 * beat + eighth * 3, 0.5, 2400)
      this.snare(t + 3 * beat + eighth * 3.5, 0.55, 2400)
    }
    // power chords: root + fifth saws, palm-muted 8ths
    for (let i = 0; i < 8; i++) {
      const mute = rnd() < 0.2
      const vol = mute ? 0.1 : 0.16
      const dur = mute ? eighth * 0.4 : eighth * 0.85
      this.tone(t + i * eighth, hz(root + 12), dur, 'sawtooth', vol, { lp: 2600 })
      this.tone(t + i * eighth, hz(root + 19), dur, 'sawtooth', vol * 0.8, { lp: 2600 })
    }
    // shout-along lead on the last bar
    if (this.barIndex % 4 === 3) {
      for (let i = 0; i < 4; i++) {
        this.tone(t + i * beat, hz(root + 24 + (i % 2) * 3), beat * 0.7, 'square', 0.09, { lp: 2200 })
      }
    }
  }

  /** NIGHT DRIVE — ambient swells. */
  private barNight(t: number, beat: number): void {
    const barDur = beat * 4
    const chord = NIGHT_CHORDS[this.barIndex % NIGHT_CHORDS.length]
    for (const m of chord) {
      this.tone(t, hz(m), barDur, 'sine', 0.11)
      this.tone(t, hz(m + 12), barDur, 'triangle', 0.05, { detune: 4 })
    }
    // slow echoing arp through the delay
    if (this.delay) {
      const step = beat / 2
      for (let i = 0; i < 8; i++) {
        const m = chord[i % chord.length] + 24
        this.tone(t + i * step, hz(m), step * 1.8, 'sine', 0.07, { dest: this.delay })
        this.tone(t + i * step, hz(m), step * 1.8, 'sine', 0.045)
      }
    }
  }

  /** EMPIRE TALK — the city talks back. */
  private barTalk(t: number, beat: number): void {
    const rnd = mulberry(this.trackSeed + this.barIndex * 613)
    const barDur = beat * 4
    this.staticBed(t, barDur)
    const segment = this.barIndex % 4
    if (segment < 2) {
      // DJ monologue: syllables across the bar with pauses
      let tt = t + beat * 0.2
      while (tt < t + barDur * 0.94) {
        const dur = 0.07 + rnd() * 0.13
        if (rnd() > 0.18) this.voiceSyllable(tt, dur, 128, 0.16)
        tt += dur + (rnd() < 0.22 ? 0.12 + rnd() * 0.2 : 0.02)
      }
    } else if (segment === 2) {
      // "Caller": higher, faster, slightly distorted
      let tt = t + beat * 0.1
      while (tt < t + barDur * 0.9) {
        const dur = 0.05 + rnd() * 0.09
        if (rnd() > 0.12) this.voiceSyllable(tt, dur, 196, 0.13)
        tt += dur + 0.015
      }
    } else {
      // Station-ID jingle: three ascending bright notes + logo tone
      for (const [i, m] of [76, 79, 83].entries()) {
        this.tone(t + i * 0.16, hz(m), 0.22, 'triangle', 0.14, { dest: this.delay ?? undefined })
        this.tone(t + i * 0.16, hz(m), 0.22, 'triangle', 0.1)
      }
      this.tone(t + 0.55, hz(71), 0.5, 'sine', 0.12)
    }
  }
}
