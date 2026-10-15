/**
 * Time — fixed-timestep 60 Hz simulation clock with variable render rate.
 * Fixes the original C++ project's documented dt² integration bug
 * (position += velocity * dt * dt) by centralizing fixed-dt stepping.
 *
 * Usage: once per animation frame call `tick(nowMs)`; it returns how many
 * fixed simulation steps to run this frame (0..MAX_STEPS). `deltaTime`
 * is ALWAYS 1/60 so integration is deterministic.
 */
export class Time {
  /** Fixed simulation step in seconds (60 Hz). */
  static readonly FIXED_DT = 1 / 60
  readonly fixedDt = Time.FIXED_DT

  /** Total simulated time in seconds (only advances in fixed steps). */
  elapsed = 0
  /** Fixed delta (1/60). Alias for readability in update(dt) signatures. */
  readonly deltaTime = Time.FIXED_DT
  /** Total rendered frames since start. */
  frameCount = 0
  /** Smoothed frames-per-second (rolling window of 30 frames). */
  fps = 60

  /** Wall-clock render delta of the current frame (seconds, clamped). */
  frameDt = 0

  private static readonly MAX_STEPS = 5 // spiral-of-death guard
  private static readonly MAX_FRAME_DT = 0.25 // after tab-away, drop time

  private acc = 0
  private lastNow = 0
  private started = false
  private fpsWindow: number[] = []
  private lastFrameNow = 0

  /**
   * Advance the clock. Returns the number of fixed steps to simulate
   * this frame (each step = Time.FIXED_DT of simulated time).
   */
  tick(nowMs: number): number {
    if (!this.started) {
      this.started = true
      this.lastNow = nowMs
      this.lastFrameNow = nowMs
      return 0
    }

    // --- render-rate accounting (fps) ---
    const rawFrameDt = Math.max(0, (nowMs - this.lastFrameNow) / 1000)
    this.lastFrameNow = nowMs
    this.frameCount++
    if (rawFrameDt > 0.0001) {
      this.fpsWindow.push(1 / rawFrameDt)
      if (this.fpsWindow.length > 30) this.fpsWindow.shift()
      let sum = 0
      for (const f of this.fpsWindow) sum += f
      this.fps = sum / this.fpsWindow.length
    }

    // --- fixed-step accumulation ---
    this.frameDt = Math.min(rawFrameDt, Time.MAX_FRAME_DT)
    this.acc += this.frameDt

    let steps = 0
    while (this.acc >= Time.FIXED_DT && steps < Time.MAX_STEPS) {
      this.acc -= Time.FIXED_DT
      this.elapsed += Time.FIXED_DT
      steps++
    }
    if (steps >= Time.MAX_STEPS) this.acc = 0 // can't keep up — drop backlog
    return steps
  }

  reset(): void {
    this.acc = 0
    this.elapsed = 0
    this.frameCount = 0
    this.fpsWindow = []
    this.fps = 60
    this.started = false
  }
}
