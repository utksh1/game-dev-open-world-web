/**
 * InputManager — keyboard + mouse input with action mapping,
 * just-pressed edge detection and multi-mode camera look.
 *
 * Look modes (critical for headless/sandbox preview where pointer lock fails):
 *   1. Pointer lock — click canvas to capture, then movementX/Y drives look.
 *   2. Drag look — hold left or right mouse button and drag.
 *   3. Q/E keys — yaw fallback (engine reads `isDown('yawLeft'/'yawRight')`).
 *
 * All keyboard state is suppressed while a text input / textarea /
 * contenteditable element has focus so menus & chat never move the player.
 */

export type InputAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'jump' // Space — also vehicle handbrake
  | 'interact' // E (also yaw-right fallback while held)
  | 'enterExitVehicle' // F
  | 'cameraToggle' // C
  | 'reload' // R
  | 'weapon1' // Digit1
  | 'weapon2'
  | 'weapon3'
  | 'weapon4'
  | 'weapon5'
  | 'pause' // Escape / KeyP
  | 'map' // KeyM
  | 'photoMode' // KeyV — freeze the world + free camera
  | 'fire' // mouse button 0 held
  | 'yawLeft' // KeyQ (camera fallback)
  | 'yawRight' // KeyE (camera fallback)

const ACTION_CODES: Record<InputAction, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  interact: ['KeyE'],
  enterExitVehicle: ['KeyF'],
  cameraToggle: ['KeyC'],
  reload: ['KeyR'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  weapon5: ['Digit5'],
  pause: ['Escape', 'KeyP'],
  map: ['KeyM'],
  photoMode: ['KeyV'],
  fire: [],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
}

const PREVENT_DEFAULT_CODES = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Tab',
])

export class InputManager {
  private down = new Set<string>()
  private pressed = new Set<string>()
  private mouseDown = new Set<number>()
  private lookDX = 0
  private lookDY = 0
  private pointerLocked = false
  private dragging = false
  private lastDragX = 0
  private lastDragY = 0
  private canvas: HTMLCanvasElement
  private disposed = false

  /** Mouse wheel delta accumulated since last consume (positive = up). */
  wheelDelta = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    canvas.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('mousemove', this.onMouseMove)
    canvas.addEventListener('click', this.onCanvasClick)
    canvas.addEventListener('contextmenu', this.onContextMenu)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** True while any of the action's keys is held. */
  isDown(action: InputAction): boolean {
    if (this.isTyping()) return false
    if (action === 'fire') return this.mouseDown.has(0)
    const codes = ACTION_CODES[action]
    for (const c of codes) if (this.down.has(c)) return true
    return false
  }

  /**
   * One-shot edge detection: true exactly once per physical press.
   * Consumes the press so subsequent calls in the same frame return false.
   */
  consumePress(action: InputAction): boolean {
    if (this.isTyping()) return false
    const codes = ACTION_CODES[action]
    for (const c of codes) {
      if (this.pressed.has(c)) {
        this.pressed.delete(c)
        return true
      }
    }
    return false
  }

  /** Is the pointer currently locked to the canvas? */
  getPointerLocked(): boolean {
    return this.pointerLocked
  }

  /** Accumulated look delta in pixels since the last call (and resets it). */
  consumeLookDelta(): { dx: number; dy: number } {
    const out = { dx: this.lookDX, dy: this.lookDY }
    this.lookDX = 0
    this.lookDY = 0
    return out
  }

  /** Accumulated wheel delta since last call (resets it). */
  consumeWheel(): number {
    const w = this.wheelDelta
    this.wheelDelta = 0
    return w
  }

  /** Call at the end of each rendered frame: clears just-pressed edges. */
  endFrame(): void {
    this.pressed.clear()
  }

  /** Attempt to grab pointer lock (no-op if unsupported/unfocused). */
  requestPointerLock(): void {
    try {
      const p = this.canvas.requestPointerLock() as unknown
      if (p && typeof (p as Promise<void>).catch === 'function') {
        ;(p as Promise<void>).catch(() => {
          /* headless / user-gesture rejected — drag-look & Q/E still work */
        })
      }
    } catch {
      /* Pointer lock unavailable (headless test) — fallbacks active */
    }
  }

  exitPointerLock(): void {
    try {
      if (document.pointerLockElement === this.canvas) document.exitPointerLock()
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.canvas.removeEventListener('click', this.onCanvasClick)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    this.exitPointerLock()
    this.down.clear()
    this.pressed.clear()
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private isTyping(): boolean {
    if (typeof document === 'undefined') return false
    const el = document.activeElement
    if (!el) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if ((el as HTMLElement).isContentEditable) return true
    return false
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTyping()) return
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault()
    if (!e.repeat) this.pressed.add(e.code)
    this.down.add(e.code)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code)
  }

  private onBlur = () => {
    // Lose all held state when the window loses focus (alt-tab safety).
    this.down.clear()
    this.mouseDown.clear()
    this.dragging = false
  }

  private onMouseDown = (e: MouseEvent) => {
    this.mouseDown.add(e.button)
    if (e.button === 0 || e.button === 2) {
      this.dragging = true
      this.lastDragX = e.clientX
      this.lastDragY = e.clientY
    }
  }

  private onMouseUp = (e: MouseEvent) => {
    this.mouseDown.delete(e.button)
    if (this.mouseDown.size === 0) this.dragging = false
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.pointerLocked) {
      // Pointer-lock mode: relative movement always drives look.
      this.lookDX += e.movementX
      this.lookDY += e.movementY
    } else if (this.dragging && (this.mouseDown.has(0) || this.mouseDown.has(2))) {
      // Drag-look fallback (headless / user declined pointer lock).
      this.lookDX += e.clientX - this.lastDragX
      this.lookDY += e.clientY - this.lastDragY
      this.lastDragX = e.clientX
      this.lastDragY = e.clientY
    }
  }

  private onCanvasClick = () => {
    if (!this.pointerLocked && !this.isTyping()) this.requestPointerLock()
  }

  private onContextMenu = (e: Event) => {
    e.preventDefault() // right-drag is camera look, not a context menu
  }

  private onWheel = (e: WheelEvent) => {
    if (this.isTyping()) return
    e.preventDefault()
    this.wheelDelta += Math.sign(e.deltaY)
  }

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas
  }
}
