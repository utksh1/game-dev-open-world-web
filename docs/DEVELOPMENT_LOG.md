# Project Worklog — GTA-like Open World Engine: Web Rebuild

## Project Purpose
The user audited https://github.com/utksh1/game-dev-open-world (commit 0e10d54).
Verdict: **documentation claims 100% complete ("all 10 phases, production-ready"),
but the C++ build delivers ~25%** — with link-breaking duplicate symbols, a UB
crash in the frame-present path, an empty HUD/Minimap/Menu/Audio, a print-only
ContentLoader (0 of 32 asset files ever parsed), dead A*/traffic/LOD/vehicle
code, and a fabricated VERIFICATION.md.

**Our mission**: address ALL documented gaps by delivering the promised engine
as a fully-playable web application (Next.js 16 + Three.js + Prisma), which
actually loads and parses the repo's real asset files.

## Completed by Lead (Task ID: 0) — SETUP
- Cloned & audited the original repo (full gap report: `src/data/gapAnalysis.ts`)
- Copied all 32 asset files → `content/` (levels, missions, campaign, vehicles, npcs)
- Installed `three` + `@types/three`
- **THE CONTRACT**: `src/game/types.ts` — all shared types (parsed content
  shapes, HudState, SaveGamePayload, IGameEngine facade, EngineEvent union).
  ALL agents must conform to these types. Do not rename/move.
- Server ContentLoader: `src/lib/content/loader.ts` — parses ALL asset formats
  (verified: 4 levels, 14 missions, campaign, 7 vehicles, 5 NPCs, objectives,
  enemy waves, reward ranges, docks/water/traffic/npc spawns).
- API routes:
  - `GET /api/content/all` → ContentBundle (JSON)
  - `GET/POST/DELETE /api/saves` → save slots (Prisma)
- Prisma: `SaveGame` model pushed to SQLite (slot, money, position, stateJson...)
- `bun run db:push` + lint: CLEAN
- Parser smoke test passed (start_position fix applied)

## Architecture (binding for all agents)
```
src/game/types.ts        # CONTRACT (lead) — shared types
src/game/state.ts        # zustand store: useGameStore (HUD-facing state) — lead will create skeleton, 2-b extends
src/game/core/           # 2-a: Engine loop, Time, InputManager
src/game/physics/        # 2-a: PhysicsWorld (AABB vs buildings, raycast)
src/game/renderer/       # 2-a: Three.js scene, lights, skybox, camera FPS/TPS
src/game/world/          # 2-a: WorldStreamer + LOD from LevelData
src/game/vehicles/       # 2-a: VehicleController (.vehicle stats), VehicleManager
src/game/ai/             # 2-b: A* pathfinder, NPCManager (states+reactions), TrafficSystem
src/game/gameplay/       # 2-b: MissionSystem (15 objective types), WeaponSystem, Inventory, SaveSystem
src/game/audio/          # 2-b: WebAudio (procedural engine/gun/footstep/ambient)
src/game/engine.ts       # 2-a implements GameEngine facade (IGameEngine), 2-b extends via engine.registerSystems()
src/components/game/     # 2-b: HUD, Minimap, PauseMenu, MissionBriefing, MainMenu, GameShell
src/app/page.tsx         # 2-b: landing page (gap analysis + playable game)
```

### Key contract facts
- `IGameEngine` (see types.ts) is the facade: start/dispose/setPaused/loadLevel/
  toggleCameraMode/enterOrExitVehicle/cycleWeapon/fireWeapon/reloadWeapon/
  startMission/teleportPlayer/damagePlayer/restorePlayer/getHudState/
  onHudSync/onEvent/buildSavePayload/applySavePayload
- HUD sync: engine calls `onHudSync` callback at ~10Hz with a full `HudState`
- UI never touches Three.js directly — only HudState + engine commands
- Weapons: fists/pistol/smg/rifle/shotgun (WeaponId union)
- Wanted level 0..5; money starts 500; player spawn = level.spawnPoint
- Fixed timestep 60Hz sim, variable render (matches original doc's "Fixed timestep game loop (60 Hz)")
- No port numbers in fetch URLs — only relative `/api/...` paths
- shadcn/ui components exist in src/components/ui — use them for menus/panels
- NO blue/indigo primary palette (rules) — use emerald/amber/rose/slate/zinc + dark game aesthetic
- Footer (if any on landing page) must be sticky (min-h-screen flex flex-col + mt-auto)

## Task ID: 0 — Lead setup — COMPLETE (this section)

---

## Task ID: 2-a — Engine core + facade + boot page — COMPLETE

**Situation on pickup**: the previous agent had already written
`src/game/core/PlayerController.ts` and `src/game/engine.ts` (found on disk,
complete) but timed out before `src/app/page.tsx`, verification and handoff.
This task: line-by-line spec review + fixes of both files, the boot page,
full browser verification, and this handoff.

### Modules in scope
- `src/game/core/PlayerController.ts` — reviewed, spec-compliant (no changes needed):
  accel 40 m/s², walk 3 / run 6.5 m/s (Shift), jump v₀ 7.5, gravity 20, air
  control 30%, semi-implicit Euler on FIXED dt (the C++ dt² bug fix is
  documented in its header), swim (surface-locked, 40% speed, no jump),
  sliding AABB collision, box character with limb swing / idle sway / swim
  and dead poses, `setVisible` for FPS/driving hiding, stats
  health 100 / armor 0 / money 500 / xp 0 / wanted 0, armor-first
  `damage()` + `onDamaged`/`onDeath` callbacks. Exports:
  `PlayerController`, `PLAYER_EYE_HEIGHT = 1.65`, `PlayerIntent`,
  `PlayerCallbacks`. Instance API: `position` (feet, THREE.Vector3),
  `velocity`, `group`, `health/maxHealth/armor/maxArmor/money/xp/wantedLevel`,
  `dead/grounded/swimming`, `update(dt, intent, physics)`, `damage(n, source?)`,
  `restore(health?, armor?)`, `respawnAt(vec3)`, `addMoney(delta)`,
  `addXp(n)`, `getLevel()`, `getSpeedKmh()`, `setVisible(bool)`,
  `setWorldBounds(sizeX, sizeZ)`, `dispose()`.
- `src/game/engine.ts` — reviewed; ONE spec gap fixed: `damagePlayer` now also
  fires the red-flash cue (`notify('−X HP (source)', 'danger')` →
  `'notification'` EngineEvent with kind `danger`; Task 2-b's HUD should flash
  red on `notification` events of kind `danger`).
- `src/game/renderer/Renderer.ts` — one-line fix: `PCFSoftShadowMap` →
  `PCFShadowMap` (removed in three r186; silenced a console warning).
- `src/app/page.tsx` — **NEW** temporary boot-test page (see below). Task 2-b
  REPLACES it with the real landing page (gap analysis + GameShell).

### engine.ts — EXACT exported API (Task 2-b builds on this)
```ts
export class GameEngine implements IGameEngine { /* see below */ }
export function createGameEngine(): IGameEngine   // factory used by UI

export type WeaponsAction =
  | { type: 'cycle'; dir: 1 | -1 }
  | { type: 'select'; slot: 1 | 2 | 3 | 4 | 5 }
  | { type: 'fire' }
  | { type: 'fireRelease' }
  | { type: 'reload' }
export type MissionAction = 'interact'
export interface SystemSaveFragment {
  missionsCompleted?: string[]; campaignProgress?: number
  weaponsOwned?: WeaponId[]; currentWeapon?: WeaponId | null
  inventory?: InventoryItem[]; [key: string]: unknown
}
export interface EngineSystem {          // ALL hooks optional (?.-safe)
  init?(engine: GameEngine): void        // on registerSystem (or at start if pre-registered)
  update?(dt: number): void              // fixed 1/60 step, SKIPPED while paused
  onAction?(action: WeaponsAction | MissionAction): void
  startMission?(missionId: string): EngineCommandResult | void
  getHudWeapon?(): WeaponState | null
  getWeaponsOwned?(): WeaponId[] | null
  getHudInventory?(): InventoryItem[] | null
  getHudMission?(): MissionRuntime | null
  getSaveData?(): SystemSaveFragment
  applySaveData?(data: SystemSaveFragment): void
  dispose?(): void                       // engine.dispose() cascade
}
export interface EngineSystems {         // engine.systems: readonly EngineSystems
  npcs?: EngineSystem; traffic?: EngineSystem; missions?: EngineSystem
  weapons?: EngineSystem; audio?: EngineSystem
  [name: string]: EngineSystem | undefined   // custom names allowed
}
export interface EngineServices {        // engine.services snapshot object
  scene; camera; webglRenderer; time; input; physics; world; vehicles
  player; content; level
}
```
GameEngine public members beyond `IGameEngine` (start/dispose/setPaused/
loadLevel/toggleCameraMode/enterOrExitVehicle/cycleWeapon/fireWeapon/
reloadWeapon/startMission/teleportPlayer/damagePlayer/restorePlayer/
getHudState/onHudSync/onEvent/buildSavePayload/applySavePayload):
- service getters (throw before `start()`): `scene` `camera` `webglRenderer`
  `time` `input` `physics` `world` `vehicles` `player` `content` `level`,
  plus `services` (all of them in one object — same instance each call).
- `systems`, `registerSystem(name, system)` (re-register replaces + disposes
  the old one), `addUpdateHook(fn) → unregister fn` (fixed step, paused-skipped),
  `emitEvent(evt)`, `onEvent(cb)` / `onHudSync(cb)` (subscriber Sets, no dupes),
  `notify(text, kind='info')` (last 5, 4 s sim-time expiry + `'notification'`
  event), `setWantedLevel(0..5)` (clamps + `'wantedLevelChanged'`).
- `cycleWeapon(dir)` → `{ok:false,'Weapon system not available'}` when no
  system; `fireWeapon`/`reloadWeapon` no-op without a system;
  `startMission` → `{ok:false,'Mission system not available'}` without one.
- `enterOrExitVehicle()`: nearest DRIVABLE vehicle ≤ 4 m; emits
  `vehicleEntered`/`vehicleExited`; player mesh hidden while driving; exit
  places player at the vehicle's left-side exit spot.
- WASTED flow: `damagePlayer` (armor-first) → death → `'playerWasted'` event,
  3 s corpse pause, respawn at hospital building front
  (`level.buildings` type contains 'hospital', offset z + size.z/2 + 4) else
  level spawnPoint; health 100, −$100, wanted cleared.
- Day/night: 24 h per 10 real min from `level.timeOfDay`; drives Skybox,
  Lighting (+lamp pool), WorldAssets night factor, vehicle headlights,
  `hud.dayTime`. `loadLevel` resets the clock to the new level's timeOfDay.

### INPUT WIRING — owned by the engine, 2-b must NOT re-bind keys
W/A/S/D move (camera-relative) or drive (throttle/steer) · Shift run ·
Space jump (press) / handbrake (held, driving) · mouse-look = pointer-lock
(click canvas) or hold-drag · Q/E HELD = yaw fallback · **C** camera fps⇄tps ·
**F** enter/exit vehicle · **E PRESS** → `systems.missions?.onAction('interact')` ·
**R** → weapons `{type:'reload'}` · **Digit1..5** → weapons
`{type:'select',slot:1..5}` · **LMB held** → weapons `{type:'fire'}` each fixed
step (+ `{type:'fireRelease'}` on release) · **Esc/P** → setPaused(!paused) ·
M NOT wired (2-b big-map binds it) · InputManager suppresses keys while typing
in inputs and on window blur.

### Boot instructions (2-b)
```ts
const { createGameEngine } = await import('@/game/engine') // client-only
const engine = createGameEngine()
engine.onHudSync(useGameStore.getState().setHud)   // src/game/state.ts exists
engine.onEvent((evt) => { /* missionStarted/Completed/Failed, wantedLevelChanged, ... */ })
await engine.start(containerEl, content /* GET /api/content/all */, { saveData? })
engine.registerSystem('weapons', new WeaponSystem())   // before OR after start
engine.registerSystem('missions', new MissionSystem()) // ('npcs','traffic','audio' likewise)
```
Systems registered BEFORE `start()` get `init(engine)` during start; after →
immediately. `applySavePayload` is called by `start()` when `opts.saveData`
is given — AFTER system inits, so systems receive their `applySaveData` then.

### Boot-test page (temporary, replaced by 2-b)
`src/app/page.tsx`: fetch `/api/content/all` → dynamic `import('@/game/engine')`
(client-only, SSR-safe) → `engine.start(mount, content)` (downtown) → overlay
(FPS, POS, SPD, money/HP/wanted/cam badge, notifications, controls hint,
PAUSED banner) with booting / error / WebGL-unsupported states.

### Verification evidence
- `bun run lint` → CLEAN.
- agent-browser on http://localhost:3000/ (headless SwiftShader): page renders
  the 3D city (pixel scan: 192 unique colors, sky gradient, buildings/roads —
  not blank, no Next error overlay); movement verified via synthetic keydown
  (W+Shift): POS 500.0/0.0/500.0 → 500.0/0.0/492.5 (≈6.5 m/s run — dt² fix
  holds at 3 FPS headless, fixed-step sim time-dilates correctly); `C`
  toggled TPS→FPS badge; `P`/`Esc` pause toggled + unpaused (NOTE: browsers
  swallow the FIRST Escape to release pointer-lock — expected web behavior);
  day clock advanced in overlay; browser console: NO errors, no page errors.
- `dev.log`: `GET / 200`, `GET /api/content/all 200`, no compile errors.

### Deviations / limitations (precise for 2-b)
1. Weapons hook actions are discriminated-union OBJECTS
   (`{type:'reload'}`, `{type:'select',slot}`, `{type:'fire'}`,
   `{type:'fireRelease'}`, `{type:'cycle',dir}`) — not the plain strings
   suggested in the task brief ('reload'/'weapon1'...). Type-safe and richer;
   the mapping is documented in the engine header and above. Missions use the
   string `'interact'`.
2. `systems` typing is `EngineSystem` (structured interface) rather than
   `unknown` — narrower, still fully optional-safe via `?.`.
3. `startMission` no-system message is 'Mission system not available'
   (spec suggested 'Missions not available' — same semantics).
4. Player spawns via engine (passes `level.spawnPoint` to PlayerController) —
   "reads level spawnPoint" satisfied indirectly.
5. Hospital search uses `type.includes('hospital')` (tolerant) instead of
   strict `===`.
6. Time spiral-guard: max 5 fixed steps/frame, frameDt clamped to 0.25 s
   (after tab-away, backlog dropped) — sub-12-FPS machines run sim slower
   than real time by design (headless SwiftShader showed 3 FPS).
7. Vehicles: 7 content vehicles × authored spawnLocations spawned per level;
   helicopters are display-only. VehicleManager Task 2-b API:
   `spawnVehicle(data, pos, yaw, isTraffic, forceId?)`, `removeVehicle(id)`,
   `getNearby(pos, r)`, `getById(id)`, `roadGraph` via `world.getRoadGraph()`.
8. Zustand store skeleton `src/game/state.ts` (useGameStore: setHud/
   setContent/setScreen/…) — 2-b extends it.
---
Task ID: 2-b
Agent: full-stack-developer (completed across 2 runs; verified by lead via agent-browser)
Task: All gameplay systems + AI (Pathfinder, NPCManager, TrafficSystem, WeaponSystem,
MissionSystem, Pickups, SaveSystem, AudioSystem) + ?debug=1 debug bar on boot page.

Work Log:
- Built src/game/ai/Pathfinder.ts — A* over RoadGraph (the original C++ findPath was never called)
- Built src/game/ai/NPCManager.ts — NPCs from .npc data + level npcSpawns; states
  idle/walk/run/flee/chase/dead (original had DRIVING/FLEEING unimplemented);
  reactions from .npc files (gunshot→flee r30, crash→investigate, bump→complain);
  police wanted escalation 1-5 (armed at 3+, SWAT at 4+), wanted decay 45s/level,
  BUSTED (police within 2.5m for 3s → -$200 + teleport to police station);
  spawnEnemy/raycastNPCs/getNPCs/notifyGunshot/fleeAll APIs; onNpcKilled callback
- Built src/game/ai/TrafficSystem.ts — traffic from .trafficSpawns + road graph
  lane-following, density by level, obstacle stop + honk, crash notify, wanted on hit
- Built src/game/gameplay/WeaponSystem.ts — 5 weapons with REAL timed reload
  (1.8s + progress; original was instant), hitscan damage via NPC raycast +
  physics raycast, muzzle flash, tracers, recoil, ammo pickups
- Built src/game/gameplay/MissionSystem.ts — ALL 15 objective types (goto/interact/
  timer/survive/eliminate/defend/collect/chase/race/steal/observe/locate/escort/
  escape/destroy), enemy waves from .mission enemies with spawnTrigger, campaign
  unlock chain from campaign_main.campaign, side-mission repeatable + random
  reward in [min,max], world markers at startPosition, E-to-start, fail on
  death/busted, getAvailableMissions()/startMission()/getHudMission()/save hooks
- Built src/game/gameplay/Pickups.ts — health/armor/cash/ammo/crate pickups,
  gun-shop ammo crates notification observed live
- Built src/game/gameplay/SaveSystem.ts — saveGame/loadSlot/loadSlots/scheduleAutosave
  (30s) → POST/GET /api/saves + localStorage fallback (original C++ SaveSystem
  wrote to a non-existent saves/ dir and was never called)
- Built src/game/audio/AudioSystem.ts — real WebAudio (original init() was
  `return true`): procedural gunshots per weapon, reload clicks, footsteps,
  engine (pitch by speed), horn, positional siren by wanted, jingles, ambient pad
- Boot page src/app/page.tsx now registers systems in order: weapons, npcs,
  missions, traffic, audio; ?debug=1 shows debug bar (give weapons, start
  mission_01/03, cheat objective, wanted+1, spawn police, save/load slot 1,
  +$1000, heal)

Stage Summary (key APIs for Task 2-c):
- MissionSystem: getAvailableMissions(): AvailableMission[{id,name,description,
  difficulty,rewards,isSide,marker:{position,available}}], startMission(id),
  getHudMission() → MissionRuntime, onAction('interact')
- NPCManager: spawnEnemy(type,pos,opts), raycastNPCs(origin,dir,maxDist),
  getNPCs(): NpcInfo[], notifyGunshot(pos), onNpcKilled callback set by missions
- TrafficSystem: getTraffic(): TrafficInfo[], notifyCrash(pos)
- WeaponSystem: getHudWeapon() → WeaponState, getWeaponsOwned(), actions:
  {type:'select',slot}|{type:'fire'}|{type:'fireRelease'}|{type:'reload'}|{type:'cycle',dir}
- SaveSystem: saveGame(engine,slot), loadSlot(engine,slot), loadSlots(),
  scheduleAutosave(engine,slot,intervalMs?) → stop fn, slots 1-9
- AudioSystem: play(name,{position,volume}), setVolumes({master,music,sfx});
  auto-reacts to engine events (mission jingles, sirens, engine voice)
- Registration order in page: weapons → npcs → missions → traffic → audio
- VERIFIED by lead (agent-browser + VLM screenshot): 3D city renders, debug bar
  works, "Start mission_03" → "Mission started — Special Delivery" notification,
  zero console/page errors, save API round-trip 200 (dev.log)

---
Task ID: 2-c
Agent: full-stack-developer (components) + lead (landing page, fixes, QA)
Task: Full game UI (HUD, minimap, big map, menus, briefing, overlays) + landing page

Work Log:
- Built src/components/game/: GameShell (orchestrator: gesture-driven boot, system
  registration weapons→npcs→missions→traffic→audio, event handling, autosave,
  M big-map key capture), HUD (health/armor bars, money, wanted stars, weapon
  panel w/ reload progress, speedometer when driving, mission objective tracker,
  crosshair, interaction prompts, notifications, confetti on mission complete),
  Minimap (canvas 2D, roads/buildings/water/traffic/NPC blips/waypoint, rotate
  w/ player), BigMap (M key full-screen district map: roads, building labels,
  mission markers w/ names, click-to-waypoint, legend, 100m scale bar), MainMenu
  (tabs: Play/Continue/Missions/Controls/Settings/Credits; district cards w/
  parsed level data; 3 save slots w/ money/playtime/relative time; engineless
  campaign unlock chain), MissionBoard (campaign + side missions w/ lock states
  from campaign_main.campaign), MissionBriefing (difficulty badge, objectives,
  rewards, requirements, Start/Cancel), PauseMenu (Resume/Save/Load/Mission
  Board/Settings/Quit), GameOverOverlay (WASTED/BUSTED), SettingsPanel (volume
  sliders→AudioSystem, sensitivity, FPS toggle, minimap rotate), DebugBar
  (?debug=1 cheats, preserved from 2-b page), engineViews (structural views +
  formatters + mission listing resolution)
- Extended src/game/state.ts: settings (persisted), engineRef, activeSaveSlot,
  engineStatus machine, overlay state, resetToMenu
- Lead: wrote landing page src/app/page.tsx (hero w/ audit story + stat chips,
  10-phase gap analysis cards w/ doc-claim quotes + 3 progress bars each
  [claimed/actual/rebuild], game section mounting GameShell, controls keycaps,
  feature cards, sticky footer w/ repo credit); fixed lint errors (DebugBar
  ref-in-render → state; HUD stale eslint-disable); fixed missing
  engineViews.formatDistance export (build-breaking); page mount detection via
  useSyncExternalStore

Stage Summary:
- VERIFIED (agent-browser + VLM, desktop + mobile):
  * Landing renders: hero, gap cards, controls, footer — zero console errors
  * Game boot: 3D city + HUD (clock, $500, 5 stars, LV/XP, minimap) — zero errors
  * Pause menu: PAUSED + Resume/Save/Load/Mission Board/Settings/Quit ✓
  * Big map (M): district map w/ roads, Bank/Hospital labels, mission markers
    ("Speed Pursuit", "Silent Takedown"), player arrow, legend ✓
  * Mission flow: Mission Board → Special Delivery briefing (objectives, $5000 +
    250 XP rewards) → Start → HUD tracker "Pick up the van · 23m" + green
    waypoint beacon in world ✓
  * Save/load: pause → Save Game → Slot 1 → "$500 · just now" in UI; API
    round-trip confirmed (slot 1, $500, downtown, missions: 0) ✓
  * Campaign unlock chain correct per campaign_main.campaign (mission_03 start;
    02/01 locked until 03; 05 until 01; 04 until 05) ✓
  * Mobile 390×844: no horizontal overflow, stacked layout ✓
  * Footer sticky at viewport bottom ✓; `bun run lint` clean ✓
- Known synthetic-event note: engine keys are matched by e.code; synthetic
  KeyboardEvents must include code ('Escape', 'KeyM'...) — Playwright press
  keydown without code does not trigger engine actions. Real user input works.

---
Task ID: 3 (final)
Agent: Lead
Task: Final QA sweep, worklog completion, recurring webDevReview cron job

Work Log:
- Full agent-browser QA passed (see Task 2-c section for the detailed evidence)
- bun run lint: clean; dev.log: no errors; APIs verified (/api/content/all,
  /api/saves GET/POST both 200)
- Created recurring webDevReview cron job (job_id 460205, every 15 min,
  Asia/Calcutta) with full project context + handover pointers

Stage Summary:
- PROJECT COMPLETE for this phase: all 10 documented engine phases rebuilt,
  all 32 original asset files parsed and driving live gameplay, 15-minute
  recurring review cycle armed for continuous improvement

---
Task ID: cron-webDevReview-202610150734 (round 1)
Agent: Lead (recurring 15-min webDevReview cycle)
Task: Status assessment, QA, then feature + styling round

## Current project status assessment
- Fresh QA via agent-browser: landing renders, game boots (3D city + HUD),
  movement/weapon-fire/vehicle-enter all work, ZERO console/page errors,
  `bun run lint` clean, APIs 200. Project stable — no bugs found this round.
- Focus selected per requirements: new features + mandatory styling polish.

## Completed modifications (this round)
1. FEATURE — Night gameplay cycle (src/game/ai/NPCManager.ts + engine.ts):
   - engine.ts: public `dayTime` getter + `advanceTime(hours)` debug helper
   - NPCManager: night window 21:00–06:00 → wanted decay 45s→70s, +1 police
     per response tier while wanted, one-shot "Night falls — police patrols
     double down" / "Dawn breaks" toasts on transition
2. FEATURE — Big-map fast travel (BigMap.tsx):
   - POIs parsed from live level data: hospitals (H), police stations (P),
     safehouse (S = level.spawnPoint); always drawn, highlighted in mode
   - Toolbar toggle + T key; click POI (≤30 m radius) → hop for $50 fare
     (engine.player.addMoney), 30 s cooldown, blocked during active mission
     with friendly toasts; auto-exits vehicle via engine.teleportPlayer
   - Legend + cursor + border states update with mode
3. STYLING — DistrictBanner.tsx (new): GTA-style cinematic splash — large
   italic serif district name + type/weather/traffic small-caps subtitle,
   bottom-right, framer-motion slide/hold 4.5 s/fade; triggers on boot +
   every levelLoaded event; wired into GameShell
4. STYLING — HUD critical health state: heartbeat vignette (pulsing rose
   radial, 1.6 s cycle), pulsing heart icon + bar opacity at ≤25% HP,
   ring-rose border on the bar, aria-label "— critical"
5. DEBUG — DebugBar cheats: "Time +6h" (fires night/dawn transitions —
   testability) + "Damage 30" (critical-state testing)
6. Landing page controls list: added "T (in map) — Fast travel" entry

## Verification results
- lint clean; dev.log no errors; zero console errors through all tests
- District banner: DOM + VLM-confirmed (italic serif, subtitle, bottom-right)
- Fast travel: POIs render w/ labels (H/P/S); clicked Hospital → $500→$450
  fare deducted, "Fast traveled to Hospital — $50 fare" toast, map auto-close
- Night cycle: Time +6h ×2 → "Night falls" toast + dark scene; ×1 more →
  "Dawn breaks" toast (transition watcher verified both directions)
- Critical health: 3× Damage 30 → "Health 10% — critical" aria-label +
  heartbeat vignette element confirmed in DOM; damage toasts visible

## Unresolved issues / risks + next-phase priorities
- Night emissive window/street-lamp visibility felt dim in one test view —
  recommend tuning CityBuilder emissive intensity + lamp PointLight pool
  range next round (styling/perf tradeoff)
- Fast-travel POIs currently only authored-building POIs (4-5 per level);
  could add road-node POIs for denser coverage
- Police vehicle pursuit at wanted 3+ (cars, not just foot units) still
  open — biggest remaining gameplay-depth item
- Side-hustle reward balancing + race/chase objective polish remain
- Recommend next round: night lighting polish → police vehicle pursuit
---
Task ID: cron-webDevReview-202610150745 (round 2)
Agent: Lead (recurring 15-min webDevReview cycle)
Task: Status assessment, QA, then feature + styling round (police pursuit focus)

## Current project status assessment (at round start)
- Full QA via agent-browser: landing renders, game boots (canvas + HUD),
  pause menu, Mission Board → briefing → Start Mission → objective tracker
  all work. ZERO console errors, lint clean, APIs 200. Project STABLE.
- Focus selected: the #1 open gameplay-depth item from round 1's list —
  police VEHICLE pursuit — plus vehicle damage FX, NPC speech polish,
  night lighting readability (round 1's top styling recommendation).

## Completed modifications (this round)
1. FEATURE — PolicePursuit system (NEW src/game/ai/PolicePursuit.ts,
   registered as engine system 'pursuit' in GameShell):
   - Activates at wanted ≥ 3 while the player is DRIVING (foot pursuit
     stays NPCManager's job). Cruiser count = wanted − 1 (max 4).
   - Spawns on road-graph nodes 70–150 m out using the parsed
     vehicle_police .vehicle stats; kinematic chase with velocity lead,
     rubber-banded speed (26 + wanted·1.8 m/s base, catches up > 60 m,
     eases < 12 m), yaw steering, building collisions, separation.
   - RAMS: contact damages both cars (player takes ~2×), shoves the
     player's car, camera shake, crash audio, cooldown-gated toasts.
   - ARREST: player vehicle stopped < 1.5 m/s with cruiser ≤ 5.5 m for
     3 s → BUSTED (playerBusted event → overlay, $200 fine, wanted 0,
     respawn at police station, mirrors NPCManager's flow).
   - DEPLOY hand-off: player bails out → cruiser brakes, spawns 2 duty
     officers via NEW NPCManager.spawnDutyPolice() (SWAT leads at 4+),
     then disengages. Cruisers despawn > 140 m or after 12 s.
   - Stealing a pursuit cruiser → +1 wanted ("Heat rising").
2. FEATURE — Vehicle damage & explosion FX:
   - VehicleManager: manager-level destroyed detection (`!wasDestroyed &&
     v.destroyed`) so ALL death paths (rams, crashes, cheats) fire —
     fixes silent destruction that bypassed the controller's
     collision-branch flag.
   - Explosion: double fireball sprites (additive radial-gradient
     texture, scale 1.4→6.6, 0.55 s) + dark smoke burst + shake 0.7 +
     NEW AudioSystem 'explosion' sound (sub-sine boom + noise roar +
     crack) + engine onExplosion hook: area damage (NPCs ≤ 5.5 m up to
     70 dmg, player ≤ 38 dmg), crowd panic radius 28 m.
   - Damage-tier smoke in VehicleController: ≤ 50% health → wispy steam
     from the hood; ≤ 25% → dark smoke; destroyed → thick dark puffs.
     Smoke particles now tint per tier (warm-gray vs near-black).
   - HUD speedometer: condition bar pulses rose at ≤ 25%; new warning
     labels "⚠ smoking" (≤ 30%) / "⚠ engine critical — bail out" (≤ 25%).
3. FEATURE — NPC speech bubble expansion (NPCManager):
   - FLEE_SHOUTS ("Run!", "He's got a gun!"…) at flee start (45%,
     one-shot) · WOUNDED_GRUNTS on non-lethal damage (2.5 s cooldown) ·
     ambient street chatter: a nearby civilian mutters a day/night
     contextual line every ~14 s (AMBIENT_DAY/AMBIENT_NIGHT).
   - Fixed pre-existing speech-material leak: expiry/re-show now remove
     + dispose sprite materials (was: orphaned invisible sprites).
4. BUG FIX (found via QA!) — traffic double-integration: AI traffic
   cars ran BOTH VehicleManager's full v.update() (idle) AND
   TrafficSystem's kinematic driveCar() → 2× effective speed, corner
   cutting, phantom building damage (exploded cars after the
   destroyed-detection fix exposed it). VehicleManager now runs
   updateVisuals-only for `isTraffic` vehicles; motion belongs to
   TrafficSystem alone. Traffic speed is now the authored 8–14 m/s.
5. STYLING — night readability pass (round 1's top recommendation):
   - DayNight night keyframes lifted (moon 0.12→0.5, hemi 0.3→0.78,
     sky/fog lifted) — ACES was crushing blacks; VLM rated the first
     pass 4/10 "power outage", final 8/10 "moody noir, readable".
   - Lamps: pool 8→10, intensity 26→44, distance 30→38.
   - Facade window emissive 1.35→2.1, lamp heads 2.4→3.2, storefront
     signs 1.6→2.0, awning stripes 1.2→1.6.
   - AI traffic + pursuit cruisers flip headlight emissives at night
     (TrafficSystem night watcher; cruisers spawn with lights on).
6. STYLING — HUD detail pass:
   - PURSUIT banner (top-center, below mission tracker): pulsing siren
     icon, cruiser count chip, "evade or get boxed in" hint, spring
     entrance/exit, role=alert aria-live.
   - Wanted stars ≥ 3: rose fill + drop-shadow glow + pulsing scale +
     rose ring on the chip (heat tier); aria-label "heavy police heat".
   - Clock: Sun/SunDim/Moon icon by hour (day/dusk/night).
   - Minimap: pursuit cruisers = pulsing rose squares with outline
     (distinct from amber traffic dots, slate foot-police dots).
   - Traffic now brakes for pursuit cruisers (obstacle check via
     pursuit view, 4 m lookahead).
7. DEBUG — DebugBar: "Heat 3 (pursuit test)" (one-click pursuit), "Enter
   nearest car" (teleport beside + enter — fixes slow synthetic-walk QA),
   "Damage vehicle 60" (smoke-tier test). Landing copy updated (feature
   card + game section mention cruiser pursuit).

## Verification results
- bun run lint: CLEAN · dev.log: no compile errors · /api 200s.
- Pursuit (VLM-verified screenshot): 2 cruisers spawned at Heat 3 while
  driving, PURSUIT banner "2 cruisers", lightbars flashing, wanted stars
  rose tier, minimap rose blips, 106 km/h chase, "Cruisers on your tail"
  toast. Ram flow: bike wrecked while driving → ejected −25 HP
  (vehicle-wreck) + black wreck smoke. On foot: pursuit disengaged,
  3 deployed officers chasing (VLM screenshot), banner gone.
- Explosion: "Turbo GT destroyed!" / "Police Cruiser destroyed!" toasts
  fired via manager-level detection during the traffic-bug repro; fireball
  + boom audio + area damage code paths exercised, zero console errors.
- Night: VLM-rated 8/10 readability at midnight (roads/sidewalks/facades
  visible, amber windows, lamp pools); "Night falls"/"Dawn breaks" toasts
  on transitions; moon icon in clock (DOM-verified).
- Traffic fix: no phantom explosions after fix; game re-booted clean
  post-fix, canvas + HUD + zero console errors.
- Speech: chatter/flee/grunt paths run clean (lint + console); visual
  capture is probabilistic (45%/2 s window) — single NPC in frame during
  test screenshots; shared showSpeech path was QA-verified in round 2-c.
- Note: 5 stale [error] entries in browser console history are from a
  transient mid-edit duplicate const (fixed immediately); current session
  logs ZERO errors.

## Unresolved issues / risks + next-phase priorities
- Arrest-from-vehicle flow not end-to-end verified (needs the player to
  stay stopped 3 s with a cruiser ≤ 5.5 m — bike kept getting wrecked
  first). Code mirrors the QA-verified NPCManager BUSTED flow; recommend
  a quick manual check next round (Heat 3 + enter a sturdy car, stop).
- Pursuit cruisers can visually clip through traffic cars (kinematic,
  no inter-vehicle physics between cruiser↔traffic; traffic brakes for
  them, so rare). Could add a light push-apart like player rams.
- Traffic now drives at TRUE authored speed (8–14 m/s vs the accidental
  2× before) — subjective feel may read "slower"; tune baseSpeed up
  (e.g. 10–17) if it feels sluggish in play.
- Side-hustle reward balancing + race/chase objective polish still open.
- Performance: 10 lamp PointLights + larger pool OK in headless test;
  watch FPS on low-end GPUs (Settings has an FPS counter).
- Recommend next round: arrest-flow manual verify + traffic speed feel
  → race/chase mission polish → side-hustle economy balance.

---
Task ID: cron-webDevReview-202610150827 (round 3)
Agent: Lead (recurring 15-min webDevReview cycle)
Task: Status assessment, QA, then bug-fix + feature round (arrest flow, race polish, economy)

## Current project status assessment (at round start)
- Fresh QA: landing renders, game boots (canvas + HUD $500/100HP), zero console
  errors, `bun run lint` clean, APIs 200. Project STABLE.
- Round-2's unresolved item #1 (arrest-from-vehicle never completing) REPRODUCED
  and ROOT-CAUSED this round → real bug, fixed (below).
- Focus selected: (a) arrest-flow bug fix, (b) race/chase mission polish
  (round-2 priority), (c) side-hustle economy balance, (d) styling detail pass.

## Completed modifications (this round)
1. BUG FIX — Arrest flow was UNREACHABLE (PolicePursuit.ts):
   - Root cause: cruisers ram ANY vehicle ≥ 1.5 m/s. The ram SHOVES a stopped
     car back over the 1.5 m/s "stopped" threshold (velocity addScaledVector
     min(6, impact*0.5) ≈ 3.5 m/s), resetting the 3 s arrest timer every ram
     (0.9 s cooldown) while each ram deals ~24 dmg → car wrecks before arrest.
     Round-2 QA saw exactly this ("bike kept getting wrecked first").
   - FIX: BOX-IN behavior — when player's vehicle is stopped (< 1.5 m/s),
     cruisers approach at ≤ 6 m/s until 6.5 m (BOX_IN_HOLD_M), then brake to
     a full stop and HOLD; ramming is now FLEEING-ONLY (ram condition requires
     player speed ≥ ARREST_SPEED_MS). Arrest timer accumulates cleanly →
     BUSTED. One-shot "BOXED IN — floor it or get busted!" toast when the
     arrest clock starts (boxedInWarned latch).
   - NEW public getArrestCountdown(): seconds-to-BUSTED (or null) for the HUD.
2. BUG FIX — side_mission_street_race auto-completed instantly (loader.ts):
   - The authored file has a `races:` catalog (Downtown Circuit etc.) instead
     of an `# Objectives` list → parsed objectives = [] → beginObjective(0)
     → completeMission() → instant $5-20k + 200 XP payout (verified live:
     $8,222 after one click). Money printer bug.
   - FIX: parseMission synthesizes a race objective from the FIRST catalog
     entry ("Win the Downtown Circuit", targetCount = authored checkpoints=8,
     30 s per checkpoint); generateRaceCheckpoints(count?) honors the authored
     count (clamped 3-12, default 4-6).
3. BUG FIX — race countdown showed "4" (VLM-caught): countdown started at
   3.999 so ceil() displayed 4 for the first second. Now starts at exactly
   3.0 → displays 3 → 2 → 1 → GO! Beeps at 3 (begin) + 2 + 1 (ceil crossings)
   + GO two-tone.
4. FEATURE — Race polish (MissionSystem.ts + types.ts + HUD.tsx):
   - 3-2-1-GO! big overlay: huge white/emerald-stroke digits, italic GO!,
     spring animations, aria-live (MissionRuntime.race.countdown: >0 = digit,
     0 = GO! flash, null = off).
   - Checkpoint GATES: standing torus pair (r 5.4 + thin inner ring, emerald;
     GOLD on final checkpoint) + ground disc, player-facing yaw, pulse +
     opacity breathing, scale-pop flash on claim (gateFlash 0.45 s), hidden
     when the objective moves on / mission ends (dispose cleans geometry).
   - Race HUD bar: CP x/8 progress bar (spring), elapsed + best time
     (monospace tabular), "Get ready…" during countdown.
   - Lap timing + records: raceElapsed accumulates after GO; final checkpoint
     records best time per mission (bestRaceTimes in save fragment);
     "NEW RECORD — 42.1s (was 51.3s)" / "Final checkpoint — X (best Y)" toasts.
   - objectiveProgress: "3/8 · 24.6s" (mm s over 60 s).
   - NEW audio: race_countdown (square blip), race_go (rising two-tone),
     checkpoint (bright two-note sweep) in AudioSystem.
5. FEATURE — Side-hustle economy balance (MissionSystem.ts):
   - Hustle fatigue: repeat completions pay 100% → 70% → 55% → 45% → 40%
     floor (HUSTLE_PAY_MULT by prior-run count, sideHustleCounts persisted in
     save). Keeps the authored $5-20k street-race band from being an infinite
     money printer while replays stay worth it.
   - MISSION PASSED toast suffix: "· repeat 70% pay".
   - MissionBriefing: live chips "run #3 · pays 55%" (amber) + "your best:
     10.8s" (polls the live mission system; static content can't know these).
   - AvailableMission extended: repeatCount, payMultiplier, bestTime.
6. FIX — cruiser↔traffic clipping (round-2 item): light push-apart in
   PolicePursuit between cruisers and nearby traffic (getNearby 6 m, length-
   scaled min distance, half-half shove; player's vehicle excluded — the ram
   block owns that contact).
7. TUNE — traffic speed feel (round-2 item): baseSpeed 8-14 → 10-17 m/s
   (36-61 km/h) per round-2 recommendation.
8. STYLING — BOXED-IN arrest banner (HUD.tsx): pursuit banner escalates to a
   flashing rose "BOXED IN — BUSTED IN 3s · FLOOR IT!" state (pulsing scale,
   rocking siren, 2px border, 30px glow) via 300 ms getArrestCountdown poll.
9. DEBUG — DebugBar additions: "Start street race (side)" (auto-hops to the
   nearest sports car when the 80 m requirement blocks), "TP to waypoint"
   (lands 40 m out — gate visible, then claim on foot/vehicle), "Spawn + enter
   fresh sedan" (parked, sturdy — arrest-flow testing), "Pursuit status"
   (wanted/driving/sys/pursuing/cruisers/arrestIn diagnostic toast).
10. COPY — landing page: game section + "Everything wired" card mention the
    checkpoint races, 3-2-1-GO!, lap records, and box-in arrest.

## Verification results (all agent-browser, ?debug=1)
- bun run lint CLEAN after every edit; dev.log: no compile errors, 200s only.
- RACE E2E: observer captured countdown ["3","2","1","GO!"] (no "4" after
  fix — VLM had caught the pre-fix "4"); tracker "UNDERGROUND RACING · Win the
  Downtown Circuit · 1/8 · 7.3s · 155m · 23s" + race bar "CP 0/8 · 7.3S";
  8× TP claims → "Final checkpoint reached!" + "MISSION PASSED — Underground
  Racing (+$10,203, +200 XP)" ($500→$10,703 exact).
- HUSTLE FATIGUE E2E: 2nd run paid $11,737 = 70% × $16,767 roll (money math);
  briefing showed "run #3 · pays 55%" + "your best: 10.8s" (records persist
  through save POST; API round-trip 200).
- GATE VISUAL (VLM, 40 m approach): "large glowing green vertical ring with a
  thinner brighter inner ring" + "translucent green vertical light beam" +
  "faint green circular disc at the base" + countdown "2" centered in the
  ring; HUD "Win the Downtown Circuit · Get ready… · CP 0/8" with progress bar.
- ARREST E2E (the round-2 unresolved item — NOW VERIFIED): fresh boot →
  "Spawn + enter fresh sedan" (parked 0 km/h) → "Heat 3" → status toast
  "wanted 3 · driving true · pursuing true · cruisers 2" → cruisers arrived,
  boxed in WITHOUT wrecking the sedan → BUSTED: player pulled from the ride,
  $500 → $300 (−$200 fine), on foot at the police station, cruisers cleared.
  Zero console errors through the whole flow.
- Zero browser console errors/warnings + zero page errors in the final
  session; earlier sessions' oddities (instant race payout, wanted anomalies)
  were all traced to the two real bugs above or to dead WebGL contexts.
- ENVIRONMENT NOTE: SwiftShader headless loses the WebGL context
  ("THREE.WebGLRenderer: Context Lost") after ~1-2 min of heavy use — sim
  keeps running (clock/HUD/toasts live) but the 3D view goes white. Fresh
  browser sessions restore it. Not a code bug; QA sessions must stay short.
- TOOLING NOTE: the Bash output pipeline strips the literal "[m" sequence
  (ANSI-filter artifact) — `objectives[mission` displays as `objectivesission`.
  Use the Read tool for viewing code; a scary "corruption" was a false alarm.

## Unresolved issues / risks + next-phase priorities
- Wanted-decay anomaly seen ONLY on dead-WebGL sessions (wanted 3 → 1 in
  seconds, impossible via the 45 s decay) — could not reproduce on a healthy
  context (Heat 3 stayed 3 → pursuit → clean BUSTED). Likely an artifact of
  the broken-context sim state; re-verify only if seen on a healthy session.
- The debug "Spawn + enter fresh sedan" sometimes fails to enter on the very
  first click after boot (race in boot sequence?); a second click always
  worked. Debug-only cosmetic; not user-facing.
- Race opponents (the authored races list 3-7 opponents) — currently a solo
  time-trial vs your best record; AI opponent racers would be the natural
  next depth step (reuse TrafficSystem lane-following + rubber-band speed).
- Chase objective could get the same gate/polish treatment (target vehicle
  highlight ring).
- Night lighting + lamp pool perf on low-end GPUs still worth a profiling pass
  (Settings FPS counter exists for it).
- Recommend next round: AI race opponents → chase polish → perf profiling.

---
Task ID: cron-webDevReview-202610150929 (round 4)
Agent: Lead (recurring 15-min webDevReview cycle)
Task: Status assessment + QA, then AI race opponents (round-3's #1 priority),
chase-target ring polish, performance mode, parser nested-list fix

## Current project status assessment (at round start)
- Fresh QA via agent-browser: landing renders, game boots (2 canvases, HUD
  $500/100HP, clock), movement keys fire, ZERO console/page errors,
  `bun run lint` clean, APIs 200. Project STABLE — no regressions from round 3.
- Focus selected per round-3's recommendation list: (a) AI race opponents
  (top item — races were a solo time-trial), (b) chase/destroy target ring,
  (c) performance mode for low-end GPUs, (d) content-parser nested-list fix
  (found while wiring opponents).

## Completed modifications (this round)
1. FEATURE — AI RACE OPPONENTS (the big one; authored files document 3-7
   rivals per race, races were previously solo):
   - types.ts: MissionObjective.opponents + checkpoints (authored circuit),
     MissionOpponent {name, vehicle, skill}, MissionData.opponents roster,
     RaceHudState {place, racerCount, leaderName}
   - loader.ts: parses objective `opponents:` counts, mission_02's top-level
     opponents roster (Racer 1/2/3 with high/medium skills), and the
     races-catalog opponents count (side race: 3)
   - MissionSystem.ts:
     * NEW RaceOpponent class — kinematic checkpoint racer (isTraffic=true
       spawn → VehicleManager visual-only, motion owned by MissionSystem —
       same pattern as the round-2 traffic fix). Skill-scaled speed
       (24 m/s base), rubber-band pacing vs player progress (way ahead →
       0.86×, behind → 1.2× hunt), corner braking within 28 m of a gate,
       building slide collisions, inter-racer + player-car separation.
     * Numbered overhead marker sprites (canvas texture: amber-bordered dark
       pill "#N Racer N", VLM-verified readable) above each rival.
     * Starting grid: two-wide staggered formation behind the player, facing
       checkpoint 1; frozen during 3-2-1-GO; headlights at night.
     * Standings: shared progress metric (claimed CPs ×1000 − dist to next);
       player place = 1 + opponents ahead; overtake/pass toasts ("You took
       the lead!", "Racer 2 blew past you — P3").
     * LOSS condition: an opponent crossing the final gate first →
       MISSION FAILED "beaten to the finish by Racer 2" (GTA street rules).
       WIN adds "🏁 1st place — the circuit is yours" toast.
     * Authored circuit support: mission_02's 5 fixed checkpoint gates now
       parsed and used (was: random road nodes).
     * Cleanup on mission end/dispose (vehicles + sprites + gate) — VLM
       verified empty scene after MISSION PASSED.
   - HUD.tsx: race place badge (1ST gold / 2ND silver / 3RD bronze / 4TH+
     zinc, spring pop on change, aria-label) + "of N" + "lead: Racer X".
   - Minimap.tsx: opponents = white diamonds w/ dark outline (distinct from
     amber traffic dots, rose pursuit squares); finished rivals dim.
   - MissionBriefing.tsx: "🏁 vs 3 AI rivals" chip on race objectives.
   - engineViews.ts: getRaceOpponents + debugRaceStatus; DebugBar: "Race
     status" button (cp/countdown/place/opponents diagnostic toast).
2. BUG FIX (pre-existing, found via API audit) — parseSections nested-list
   handling: deeper-indented list items (mission_02 checkpoints,
   mission_06 bodyguard positions, mission_08 items, campaign unlocks) were
   absorbed as PHANTOM section entries — mission_02 had 5 bogus auto-
   completing goto objectives, mission_06 spawned 4 phantom bodyguards.
   Rewrote parser with indent tracking: sub-lists attach to the parent
   entry (RawEntry.sub). Post-fix API audit: mission_02 = 2 objectives +
   5 authored checkpoints; mission_06 = bodyguards at 4 authored spots;
   mission_04/05/10 enemy position lists now honored (spawnPositions →
   per-enemy authored spawn points in fireEnemyTriggers).
3. FEATURE — chase/destroy target highlight ring (MissionSystem): pulsing
   amber ground ring hugging the fleeing/wreckable target vehicle
   (VLM-verified "amber ring encircling its base/footprint"), hidden when
   the objective moves on, disposed on cleanup.
4. FEATURE — performance mode (rounds 2-3 perf concern):
   - state.ts: performanceMode setting (persisted in ow_settings);
     SettingsPanel: "Performance mode" switch (low-end GPUs copy)
   - engine.setPerformanceMode(on): live or pre-boot; Renderer drops pixel
     ratio to 1 + shadowMap off (materials recompile via needsUpdate),
     Lighting halves the lamp pool (10→5) + sun shadows off; toast on
     change; GameShell applies the persisted setting at boot.
   - Verified: toggle ON/OFF toasts, localStorage round-trip, scene renders
     clean, zero errors.
5. BUG FIX — z-index layering: DebugBar (z-50) covered the bottom of modal
   dialogs in ?debug=1 (agent-browser hit-test caught the settings switch
   being unclickable). PauseMenu/MainMenu/GameOverOverlay → z-[60];
   MissionBriefing/BigMap → z-[55]. Real hit-test click verified working.
6. COPY — landing page game section + "Everything wired" card: races
   "against 3-7 AI rivals … live 1ST/2ND/3RD standings".

## Verification results (all agent-browser ?debug=1 + VLM)
- lint CLEAN · dev.log 200s only · ZERO console/page errors end-to-end
- RACE E2E (side race): "Grid set: 3 rivals — Racer 1, Racer 2, Racer 3" +
  "Race! 4 racers" toasts; tracker "Win the Downtown Circuit · 1/8 · 40m";
  place badge live transitions 1ST→3RD→4TH (VLM: "4TH … LEADER: RACER 2");
  checkpoint claim → "CP 1/8"; grid3 screenshot: VLM read "#2 Racer 2" and
  "#3 Racer 3" marker pills (amber border, white text); race status toast:
  "race · cp 1/8 · cd 0.0 · elapsed 17.6s · place 4 of 4 · opponents 3/3
  running"; fail path: "MISSION FAILED — out of time" (per-CP timer);
  win path (cheat): "MISSION PASSED — Underground Racing (+$9,808, +200
  XP)" + confetti; post-mission scene VLM-verified EMPTY of rivals/gate.
- MISSION_02 E2E: completed mission_03 (cheat) → board shows "Midnight Run:
  Available" → briefing "🏁 vs 3 AI rivals" → started → authored circuit:
  "cp 0/5" + "250m" + 178 s limit + roster names; completed via cheat.
- CHASE RING E2E: vigilante side mission → locate (cheat) → "Target
  vehicle: Street Bike" → TP + sprint → VLM: "amber/orange ground ring
  hugging a vehicle … encircling its base/footprint".
- PERF MODE E2E: settings switch (real hit-test click after z-fix) →
  "Performance mode ON — shadows off, sharper FPS" toast → off → "OFF";
  ow_settings persisted {"performanceMode":false,...}; scene renders clean.
- ENVIRONMENT NOTE (recurring): headless SwiftShader runs the sim at
  ~25-30% real time (fixed-step time dilation) + occasional WebGL context
  loss after ~1-2 min heavy use — keep QA sessions short; not code bugs.

## Unresolved issues / risks + next-phase priorities
- Opponent-finish fail path verified by code review + the shared
  failMission path, but a full organic loss race (player lapped by the AI)
  wasn't sat through in headless (needs ~3 min real time at dilated sim
  speed) — recommend one manual healthy-session check.
- Race opponents' headlights are set at spawn only; a race spanning a
  day→night transition won't flip them (TrafficSystem's night watcher
  covers traffic only). Minor cosmetic.
- Stealing a rival's car mid-race works (isTraffic flips to player-driven)
  but the rival "freezes" when the player exits — could despawn or resume.
- Pedestrian density tuning + side-hustle deeper balancing still open
  (round-3 carry-overs).
- Next-phase candidates: race opponent headlights-on-transition +
  rival-car-steal handling (small), radio stations (procedural WebAudio
  variety), garage/vehicle persistence between levels, wanted-level
  helicopter pursuit at 5 stars, photo-mode / screenshot key.

---
Task ID: cron-webDevReview-202610151014 (round 5)
Agent: Lead (recurring 15-min webDevReview cycle)
Task: Status assessment + QA, then round-4's top next-phase candidates:
procedural radio stations + 4★+ police helicopter pursuit + styling polish.

## Current project status assessment (at round start)
- Fresh QA via agent-browser: landing renders, game boots (2 canvases),
  movement keys, pause/resume, mission gating (mission_01 correctly locked
  behind mission_03 per the campaign), mission_03 starts, debug bar works,
  ZERO console/page errors, lint clean, APIs 200. Project STABLE.
- Note: "Start mission_01" debug button on a FRESH save shows the locked
  toast (correct behavior) — label could say "(gated)" but not a bug.

## Completed modifications (this round)
1. FEATURE — PROCEDURAL RADIO STATIONS (new system 'radio',
   src/game/audio/RadioSystem.ts, ~720 lines):
   - 5 fully synthesized stations, no assets, WebAudio step-sequencer
     scheduled ahead of the audio clock from update() (pauses with sim):
     PULSE FM (synthwave 108bpm: 8th bass, 4-on-floor kick, arp + echo),
     DUST 95.4 (lo-fi 76bpm: swung drums, maj7/triangle stabs, vinyl
     crackle), RIOT RADIO (punk 172bpm: power-chord saws, fast drums),
     NIGHT DRIVE (ambient: stacked swells + delay arp), EMPIRE TALK
     (procedural DJ "voice" via bandpassed sawtooth syllable envelopes,
     callers, station-ID jingle, static bed).
   - Procedural track titles per station (seeded word banks, rotate every
     8 bars); toast on station change: 📻 NAME — "TITLE".
   - R while DRIVING = next station (wraps last → OFF → first; fixed a
     wrap bug found in QA); R on foot still reloads. Engine routes this
     contextually in frame().
   - Auto-plays on vehicleEntered, fades out on vehicleExited. Output on
     the AudioSystem music bus (music slider governs it); ambient pad
     ducks while a station plays (AudioSystem.setPadSuppressed).
   - AudioSystem additions: getMusicBus/getAudioContext/hasContext,
     setPadSuppressed, helicopter rotor loop (below).
   - RadioWidget.tsx HUD strip while driving (bottom-right above
     speedometer): CSS-animated EQ bars in station accent color, station
     name + live track title, prev/next buttons, "R browse stations" hint,
     AnimatePresence mount/unmount. eqBar keyframes in globals.css.
   - Settings: radioStation in ow_settings (-1 = OFF); SettingsPanel
     radio picker (6-button radiogroup with accent dots); GameShell
     applies the persisted station at boot; RadioWidget syncs the
     setting both ways (covers the R-key path). engineViews
     getRadioState; engine facade radioNext/radioPrev/radioSetStation.
2. FEATURE — 4★+ POLICE HELICOPTER (new system 'heli',
   src/game/ai/PoliceHelicopter.ts, ~530 lines):
   - ACTIVATION wanted ≥ 4 (on foot OR driving — unlike cruisers).
     States: approach (170-220 m out @ 60 m → 33 m/s) → orbit (34 m
     radius, 30-42 m altitude, banking, nose at player) → depart (wanted
     < 4: climbs away, despawns at 280 m/15 s). Mid-departure re-engage
     if heat returns to 4+.
   - Mesh: fuselage/glass nose/POLICE stripe/tail boom+fin/skids, main +
     tail rotors spinning, blinking red/green nav lights + white belly
     strobe (double-flash). Searchlight = SpotLight from the belly aimed
     at a WORLD-space target (child-of-group would ride the airframe —
     QA note) that lags the player (SPOT_SWEEP 5.2 — sweeps, misses on
     hard turns), + additive ground disc (radius 4.6 m, pulsing) at the
     beam hit.
   - GAMEPLAY HOOK: while the disc has the player lit (≤ 6 m), the
     wanted decay is suppressed (npcs.registerCrime(0) every 1.5 s) +
     one-shot "SPOTTED by the air unit — your heat will not cool" toast.
   - Audio: AudioSystem.startHelicopterLoop/stop/update — bandpassed
     noise + 58 Hz sine thump amplitude-chopped by a 12.4 Hz LFO
     ("wop-wop"), PannerNode positional at the chopper.
   - HUD: pursuit banner now shows for heli-only ("AIR PURSUIT") with an
     "AIR UNIT — SPOTTED" chip (amber glow when lit) + copy switch
     ("under the light your heat will not cool"); top-right spinning-
     rotor badge "CHOPPER OVERHEAD" / "LIT — HEAT LOCKED"; minimap rose
     rotor-ring blip (4 spinning blades, amber when lit); "AIR UNIT
     DISPATCHED" / "peeling off" / "Air unit gone" toasts.
   - engineViews getHelicopter/isPlayerLitByHeli; DebugBar: "Heat 4
     (air unit test)", "Air unit status" (state/light/playerLit),
     "Radio next station" buttons.
   - Clean dispose (scene removes, spotlight dispose, disc geo/mat
     dispose, cached materials shared), levelLoaded re-arm.
3. STYLING/UI POLISH: RadioWidget EQ bars (globals.css keyframes),
   banner AIR-UNIT chips, rotor badge, minimap blip, Settings radio
   picker, HINT_ROWS + landing CONTROL_SCHEME now document R (radio
   while driving / reload on foot), landing game-section copy + "Everything
   wired" card mention the chopper + five stations.
4. QA TOOLING: window.__owEngine hook (GameShell) for console-side
   engine inspection/bisection.

## Verification results (all agent-browser ?debug=1 + VLM)
- lint CLEAN; final dev.log: 200s only (incl. 3 autosave POSTs), zero
  500s; zero console/page errors end-to-end.
- RADIO E2E: enter sedan → RadioWidget shows PULSE FM with EQ bars;
  R hops PULSE→DUST (toast "📻 DUST 95.4 — "ORAN…""); next/prev buttons
  hit-tested; 6× R from station 0 wraps 4→OFF→0 (wrap fix verified);
  ow_settings.radioStation synced on every change; Settings picker
  (pause menu) selects RIOT RADIO → aria-checked + persisted 2; radio
  hides on exit, returns on re-entry.
- HELI E2E: Heat 4 on foot → "AIR UNIT DISPATCHED" toast; approach→
  orbit ("heli orbit · light true · playerLit true"); banner "AIR
  PURSUIT" + "AIR UNIT — SPOTTED" chip; top-right "LIT — HEAT LOCKED"
  rose badge; minimap "distinct red/rose blip shaped like a small
  propeller" (VLM); VLM on the daytime orbit shot: "large warm-white
  glowing ellipse (searchlight) on the road" + green nav light in the
  sky; Heat 3 → depart state → despawned + banner cleared + "Air unit
  gone" toast.
- INTEGRATION: driving with heat 4 (parked) → cruisers boxed in →
  BUSTED: $500→$300, wanted cleared, heli peeled off. Zero errors.
- ENVIRONMENT INCIDENT (root-caused, see risks): this round QA hit
  full renderer-process WEDGES (CDP evals timeout; about:blank in the
  same browser still evaluates). CPU profile of a wedge: no long JS
  tasks — 63 s of "(program)" native time (SwiftShader saturation).
  Bisected by monkey-patching system updates via __owEngine: wedge
  persists with ALL gameplay systems neutered AND with the round-4 code
  (git stash A/B) — NOT a code regression. Root cause: the 4 GB box ran
  out of memory (dmesg oom-kill) — next-server had grown to 1.5 GB +
  accumulated Chrome/agent-browser sessions; OOM kills + thrash starved
  the SwiftShader renderers. Mitigations that worked: close ALL browser
  sessions between tests, small viewport (480×360-960×540) +
  performanceMode for visual captures, short sessions.
- DEV-SERVER INCIDENT (fixed): `git stash`/`git stash pop` during the
  A/B test swapped db/custom.db's inode under the running next-server →
  every autosave 500'd ("attempt to write a readonly database" — stale
  handle). Fix: restart the dev server. Also learned: processes spawned
  from a single tool command are reaped at command end (su-session
  cleanup); the dev server must be started DOUBLE-FORKED to survive:
  (bash -c '(setsid nohup bun run dev >> dev.log 2>&1 < /dev/null &)')
  — verified server + saves (200) + content APIs healthy after.

## Unresolved issues / risks + next-phase priorities
- Helicopter 3D BODY not conclusively VLM-verified at close range
  (nav lights + searchlight disc + full state machine + HUD ARE
  verified) — low-res SwiftShader captures show a ~25 px dark object;
  needs one healthy-GPU manual check.
- QA lesson (BINDING for future rounds): do NOT edit files while an
  agent-browser session is live (HMR remount mid-engine-run caused
  earlier wedges/toxic sessions); do NOT git-stash while the dev server
  runs (db inode swap → save 500s — restart server after any stash
  cycle); keep sessions <60 s on this memory-constrained box.
- Radio station default at boot: GameShell applies persisted station
  possibly BEFORE the settings-load effect lands (settings race) — a
  fresh boot with a persisted non-default station may start on the
  default; the widget re-syncs on first drive. Cosmetic.
- Race opponents' headlights don't flip on day→night mid-race (round-4
  carry-over); stealing a rival's car mid-race freezes the rival
  (round-4 carry-over).
- Next-phase candidates: heli spotlight-assisted SWAT rappel at 5★,
  radio DJ segments between tracks on PULSE/RIOT (talk station has
  them), garage/vehicle persistence between levels, photo-mode key,
  pedestrian density + side-hustle balancing (round-3 carry-overs),
  chunk-LOD perf profiling pass.

---
Task ID: cron-webDevReview-202610151115 (round 6)
Agent: Lead
Task: Status assessment + QA, then round-5 carry-over bug fixes (race
headlights mid-race, rival carjack freeze, radio boot race) + round-5
next-phase features (photo mode, 5★ SWAT rappel) + styling polish.

## Current project status assessment (at round start)
- Fresh QA via agent-browser: landing renders, game boots (2 canvases, all
  9 systems), movement, city/HUD render clean (VLM-verified), zero console
  errors, lint clean, dev.log 200-only. Project STABLE — so this round
  fixed the three round-4/5 carry-over BUGS and built two new FEATURES.

## Completed modifications (this round)
1. BUGFIX — race headlights mid-race (round-4 carry-over):
   MissionSystem now tracks `racersNight` (set at spawnRaceOpponents) and
   updateRaceOpponents flips every surviving rival's headlight emissives
   when dayTime crosses 19.5 / 6.5 mid-race (same pattern as the
   TrafficSystem night watcher).
2. BUGFIX — rival carjack freeze (round-4 carry-over) → full CARJACK
   SYSTEM: updateRaceOpponents detects the player ENTERING a rival's ride
   (playerVehicleId match) → carjackRacer(): rival disqualified (progress
   -Infinity, update() never writes the vehicle again — the AI
   position-tug-of-war WAS the "frozen" symptom), the #number pill
   detaches, a panicking pedestrian spawns beside the car (spawnEnemy +
   notifyCrash radius 11 panics bystanders too), registerCrime(1) —
   GTA-style 1★ heat, crash audio + "Racer N carjacked — they are OUT of
   the race" toast. Standings/racerCount/racerAt/debugRaceStatus/
   getRaceOpponents all exclude disqualified (their car IS the player's
   now — no rival blip on the player's dot). Stolen cars are KEPT after
   race cleanup (clearRaceOpponents skips removeVehicle for disqualified
   racers — you jacked it, you drive it); spawnRaceOpponents sweeps
   same-prefix leftovers + suffixes ids to prevent duplicates on re-race.
3. BUGFIX — radio boot settings race (round-5 carry-over): GameShell
   boot step 5 now only applies the persisted radioStation when
   localStorage actually HAS one (loadPersistedSettings().radioStation
   is a number) — the save slot's own station (restored via
   applySaveData) survives on fresh installs; before, the unconditional
   default-0 apply stomped it.
4. FEATURE — PHOTO MODE (V key):
   - InputManager: new action 'photoMode' (KeyV; P stays pause).
   - CameraController: free-fly photo camera — enterPhoto() (detaches at
     the current world pose), updatePhoto(fly/strafe/rise/sprint/ground/
     bounds; pitch-aware drone-style forward, Q/E rise-fall, 9/27 m/s
     speeds, soft ground floor, level clamp, 320 m ceiling), photoZoom
     (wheel, FOV 16–92°), exitPhoto() (restores 70° + snap).
   - engine: _photoMode state; frame() photo branch intercepts ALL keys
     while active — V/Esc/P exit (Escape does NOT fall through to pause
     on the same press; a second press pauses), Space queues a snapshot,
     look/wheel/axes feed the free cam, simStep is never called (world
     frozen). updatePhotoVisuals keeps lights/skybox/chunk-visibility
     following the LENS. capturePhoto(): re-render + toDataURL (no
     preserveDrawingBuffer perf cost) → anchor download
     (openworld-<level>-<hhmmss>-<n>.png) + 📸 toast + photoCaptured
     event. Force-exit hooks on teleport/loadLevel/applySavePayload;
     guarded while paused/wasted. HudState.photoMode published at 10Hz;
     getPhotoState() for UI polling; togglePhotoMode on IGameEngine.
   - HUD: everything wraps in a fade layer (opacity + visibility with
     300ms delayed transition so elements finish fading before they stop
     rendering — pointer-events-auto children die with it); PhotoBar
     pill at top-center (amber PHOTO MODE + live FOV° + WASD/Q-E/Shift/
     wheel/Space/V kbd hints) + white shutter flash + "PHOTO SAVED" chip
     on snap; cinematic overlays: radial vignette + rule-of-thirds
     hairlines. HINT_ROWS + landing CONTROL_SCHEME + game-section copy
     document V. DebugBar "Photo mode (V)" button.
5. FEATURE — 5★ SWAT FAST-ROPE (PoliceHelicopter):
   - While orbiting at wanted 5 (spotlight range, squad cap 6, 11 s
     cooldown, first drop 3 s after spawn): startSwatDrop() spawns 2
     officers per drop at ground anchors ringing the player (7–15 m).
   - Each Rappel: THREE.Line rope from the moving airframe belly to the
     FIXED ground anchor (buffer updated per frame), a small dark
     officer figure (torso/helmet/gun boxes, gentle sway) sliding
     parametrically at 9 m/s; on landing the visuals dispose and a REAL
     hostile SWAT NPC spawns (NPCManager.spawnEnemy) — they chase and
     shoot (QA: they WASTED the player). "ROPES OUT" / "SWAT on the
     ground — rifles up" toasts.
   - depart/despawn instant-lands any ropers mid-slide (no stranded
     visuals). HelicopterInfo + swatDeployed/rappelling; HUD: pulsing
     "SWAT roping down" banner chip + "SWAT DEPLOYED ×N" top-right chip;
     DebugBar "Heat 5 (SWAT ropes test)" + swat info in Air unit status.
6. STYLING: PhotoBar + shutter flash + saved chip + thirds grid +
   vignette; SWAT HUD chips; kbd-styled key hints; landing copy updates.

## Verification results (all agent-browser ?debug=1 + VLM)
- lint CLEAN; dev.log 200-only (zero 4xx/5xx), autosaves 200.
- PHOTO MODE E2E: V → photo:true, simTime frozen (3); W+Shift fly moved
  the camera 74 m in 3 s; wheel-on-canvas zoom 70°→77°; Space →
  snappedAt=1 (download+flash+chip); V exit → sim resumed (4), FOV
  restored 70, camera back at follow height; Escape while photo → exits
  photo WITHOUT pausing (photoAfterEsc=false, pausedAfterEsc=false);
  pause (Esc) still works pre-photo (paused:true); HUD fade + grid
  lines VLM-verified; PhotoBar VLM-read at its measured rect
  ("PHOTO MODE / FOV"), DOM text checks true.
- SWAT E2E: Heat 5 → heli approach→orbit → rappelling:true → officer 1
  landed (swatDeployed:1) → both landed (swatDeployed:2,
  rappelling:false); VLM on screenshot: "AIR PURSUIT / AIR UNIT —
  SPOTTED" banner + "SWAT DEPLOYED x2" chip + 5 stars. The rappelled
  SWAT then killed the player (WASTED (swat)) — hostiles fully armed.
- CARJACK E2E: street race side mission → grid 3 rivals → teleport
  beside Racer 1 → F → "Racer 1 carjacked — they are OUT of the race"
  toast; race live: "place 2 of 3 · opponents 2/3 running" (disqualified
  excluded); player kept driving the stolen Street Bike, race elapsed
  advancing — NO freeze.
- QA tooling note: synthetic WheelEvents must be dispatched on the
  ENGINE CANVAS (InputManager listens there), not window.

## Unresolved issues / risks + next-phase priorities
- Heli 3D body still not conclusively VLM-verified close-up (SwiftShader
  low-res; state machine + all FX + HUD verified) — needs a healthy-GPU
  manual check.
- Photo-mode snapshots in headless QA can't verify the downloaded FILE
  (anchor download); the snap counter/flash/toast all verified — spot
  check one PNG manually in a real browser.
- SWAT rappel officer figures are simple boxes (by design, reads at
  distance); could get simple leg-arm animation later.
- Next-phase candidates: radio DJ segments between tracks on PULSE/RIOT,
  garage/vehicle persistence across levels (stolen race cars persist
  per-level now), photo-mode depth-of-field or tilt-shift shader,
  pedestrian density + side-hustle balancing (round-3 carry-over),
  chunk-LOD perf profiling, minimap photo-mode overlay removal toggle.
- QA lessons (BINDING): no file edits while a session is live; no
  git-stash while dev server runs; short sessions; wheel events target
  the canvas.

---
Task ID: cron-webDevReview-202610151145 (round 7) — IN PROGRESS
Agent: Lead
Task: QA + new features: City Services economy (money sinks) +
day/night pedestrian density (round-3 carry-over) + styling polish.

## Work so far (interim log)
1. QA ROUND 7 (stable): lint clean, dev.log 200-only, landing renders,
   game boots in downtown (engine started, HUD health 100 / money 500 /
   wanted 0). One browser-session wedge (known environmental OOM/
   SwiftShader issue from round 6 — NOT a code regression; memory
   recovered after session close).
2. GAP FOUND: money had NO sinks (only mission payouts + BUSTED fines).
   Also round-3 carry-over "pedestrian density tuning" never done.
3. NEW SYSTEM — src/game/gameplay/CityServices.ts ('services'):
   - clinic ($50, hospital bldg) → full health; ammo ($40, gun shop) →
     refill all owned weapon reserves; Pay'n'Spray ($100, gas station/
     parking/warehouse bldg — VEHICLE REQUIRED) → full vehicle repair +
     wanted cleared, 20 s cooldown.
   - Services derived from authored buildings per level; deterministic
     spawn-point fallbacks (nudged out of walls via physics.collideCircle)
     so every level gets all three.
   - Marker visuals: flat pulsing ground ring + inner disc + floating
     canvas-drawn billboard icon (cross/bullets/spray can) — distinct
     from amber mission cylinders; colors rose/amber/teal.
   - E-key purchase path: engine dispatches 'interact' to services too;
     insufficient funds / noop / cooldown rejection toasts; 'pickup'
     sound on purchase, 'ui_click' on reject.
4. WeaponSystem: +refillAllReserves() / anyReserveBelowMax() (shop API).
5. NPCManager: ambientTarget() now multiplied by crowdFactorForHour()
   (piecewise: 0.4 night, 1.25 morning rush, 1.3 evening rush) —
   round-3 density carry-over CLOSED.
6. UI: HUD ServicePromptPill (kind-colored, E kbd, price, blocked
   states), minimap drawServiceBlip (cross/square/pad), BigMap service
   POIs with $ tags + legend row, DebugBar TP-to-service x3 + prompt
   status, HINT_ROWS + landing CONTROL_SCHEME + copy updated.
7. lint CLEAN; dev compiles OK.

## Remaining this round
- agent-browser E2E: boot → TP to services → E purchases (clinic heal,
  ammo refill, spray repair+heat-clear) → minimap/bigmap blips VLM.
- Final worklog entry.

---
Task ID: cron-webDevReview-202610151145 (round 7) — FINAL
Agent: Lead
Task: Status assessment + QA, then independent feature selection:
City Services economy (money sinks) + day/night pedestrian density
(round-3 carry-over) + full UI/styling integration.

## Current project status assessment
- Round 7 QA at start: lint CLEAN, dev.log 200-only, landing + game boot
  verified via agent-browser (downtown, HUD health 100 / money 500 /
  wanted 0). One renderer wedge (known environmental SwiftShader/OOM —
  mitigated with session restarts, performance mode, short sessions).
- GAP ANALYSIS for this round: money had NO sinks (only payouts + BUSTED
  fines/respawn penalty); round-3 "pedestrian density tuning" carry-over
  still open. Everything else on the candidate list (vehicle damage/smoke
  + explosion, NPC speech bubbles, radio DJ/talk, fast travel, side-hustle
  fatigue balancing, photo mode) already shipped in earlier rounds.

## Completed modifications (this round)
1. NEW SYSTEM — src/game/gameplay/CityServices.ts, registered as
   engine system 'services' (GameShell registers after 'missions'):
   - THREE money sinks per level, derived from authored buildings with
     deterministic road-grid fallbacks + expanding-spiral wall-nudge
     (±48 m, 12 m separation between pads, physics.collideCircle):
       · Street Clinic ($50, hospital bldg / fallback) — full health.
       · Gun Shop ($40, shop|gun bldg / fallback) — tops every OWNED
         weapon's reserve to max.
       · Pay'n'Spray ($100, gas|parking|garage|warehouse bldg, vehicle
         REQUIRED) — full vehicle repair + wanted level cleared, 20 s
         booth cooldown.
   - Marker visuals: flat pulsing ground ring (rose/amber/teal per kind)
     + inner disc + floating canvas-drawn billboard icon (red cross /
     3 bullets / spray can) — distinct visual language vs amber mission
     cylinders; one-time "service spotted" toast at 26 m.
   - E-key purchase (engine dispatches 'interact' to services alongside
     missions); rejection paths: "bring a car", booth cooldown, noop
     (full health/reserves/clean), "Not enough cash" — affordability is
     checked BEFORE addMoney (bug fix: addMoney clamps to 0, a rejected
     purchase used to eat the remaining cash).
   - Sprays derived per level: downtown (clinic 500,514 hospital front ·
     ammo 400,484 gun-shop front · spray 600,500 road block E);
     industrial (clinic 354,370 · ammo 414,370 · spray 300,254 warehouse
     front); residential (gas-station front etc.); harbor (warehouse).
2. BUGFIX — VehicleManager.getNearest now skips destroyed wrecks (the
   player could F-enter a burning wreck and get stuck in a dead car).
3. WeaponSystem: +refillAllReserves() / anyReserveBelowMax() (shop API).
4. NPCManager — round-3 density carry-over CLOSED: ambientTarget() is
   multiplied by exported crowdFactorForHour() (piecewise: 0.4 dead of
   night → 1.25 morning rush 8:30 → 1.0 midday → 1.3 evening rush 17:30
   → 0.6 late evening; floor of 4 NPCs). The street population now
   breathes with the clock.
5. UI/STYLING:
   - HUD ServicePromptPill at the prompts stack (lucide Heart/Zap/
     Paintbrush, kind-colored border/kbd, price, "(bring a car)" /
     "(booth Ns)" contextual suffixes, sr-only blocked state).
   - Minimap: drawServiceBlip (dark circle + kind-colored cross/square/
     dot, distinct from amber mission pulses) in mapRender.ts.
   - BigMap: service POIs with CLINIC $50 / AMMO $40 / SPRAY $100 tags +
     legend row entry.
   - DebugBar: "TP to clinic/gun shop/Pay'n'Spray" + "Service prompt
     status" buttons.
   - HINT_ROWS E-row, landing CONTROL_SCHEME + game-section copy +
     "Everything wired" card document the economy.
   - engineViews: getServices / getServicePrompt / debugTeleportService.

## Verification results (all agent-browser ?debug=1)
- lint CLEAN; dev.log 200-only (zero 4xx/5xx) across the whole round.
- CLINIC E2E: damage 60 → health 40 → E → health 100, money 500→450,
  toast "Patched up — full health for $50". Rejected when full
  ("You're already patched up").
- AMMO E2E: pistol reserve 10 → E → 60 (max) for owned weapons only
  (unowned smg correctly untouched), money 450→410; second E →
  "Reserves already full", no charge.
- PAY'N'SPRAY E2E: fresh sedan (deterministic forceId), health 100→40
  via applyDamage(60), wanted 2, E while driving → vHealth 40→100,
  wanted 2→0, money 500→400, toast "Respray done — car repaired, heat
  gone ($100)"; immediate second E → "Spray booth recharging — 13s".
- INSUFFICIENT FUNDS: money 30 → E at clinic → "Not enough cash — need
  $50" AND money stays 30 (post-fix; pre-fix it was clamped to 0).
- DENSITY: ambientTarget() measured across the clock — 3 AM: 8,
  8:30: 25, noon: 20, 17:30: 26, 22:00: 11 (downtown medium base 20).
- VISUALS: ring materials verified in-scene (#f87171 @500,514 ·
  #fbbf24 @400,484 · #2dd4bf @600,500 — all visible); HUD pill VLM-read
  "E Street Clinic — Patch up · $50"; minimap VLM: "red/rose circular
  badge with a white plus-sign (cross)" north of the player; BigMap VLM:
  AMMO $40 + SPRAY $100 tags + legend "Clinic · gun shop · Pay'n'Spray
  (E to buy)" (CLINIC tag overlaps a mission label at low res — minor).
- LEVEL SWAP: loadLevel('industrial') → services rebuilt at warehouse
  front + fallbacks with correct colors (old rings removed cleanly).
- REGRESSIONS: pause (Esc) toggle on/off still works; the carjack/
  race/radio systems untouched.
- QA screenshots: download/qa-round7/ (boot, clinic marker ×3, walk
  view, minimap crop, bigmap).

## Unresolved issues / risks + next-phase priorities
- BigMap CLINIC tag can overlap a mission label when a mission
  fallback marker lands near the clinic pad (cosmetic; both texts
  legible up close).
- Heli 3D body still not conclusively VLM-verified close-up (round-5/6
  carry-over; all state machine + FX + HUD verified) — needs a
  healthy-GPU manual check.
- Photo-mode snapshot PNG needs one manual spot check in a real browser
  (round-6 carry-over).
- QA environment: renderer wedges on long sessions remain (SwiftShader
  + 4 GB box). BINDING lessons from rounds 6-7: no file edits while a
  session is live; close sessions between test phases; performance mode
  + short sessions for screenshots.
- Next-phase candidates: shop purchase confirm UI (price sheet instead
  of instant buy), garage/vehicle persistence across levels, radio DJ
  segments on PULSE/RIOT (talk station has them), photo-mode DOF/tilt
  shader, chunk-LOD perf profiling, service price tuning against
  mission payouts (side-hustle economy math), wanted-level spray exploit
  guard (block spray while actively boxed in by cruisers).

---
Task ID: cron-webDevReview-202610151215 (round 8) — FINAL
Agent: Lead
Task: Status assessment + QA, then independent feature selection:
garage lockup property system (vehicle persistence across levels +
saves — the round-7 carry-over) + radio DJ interludes on music
stations + styling polish.

## Current project status assessment
- Round 8 QA at start: lint CLEAN, dev.log 200-only, landing renders,
  game boots (health 100 / money 500 / FPS 56 / dayTime 13), pause
  toggle works both ways, City Services clinic TP + E rejection path
  intact, mission_03 starts with proper HUD state (mission_01 correctly
  locked behind mission_03). One browser wedge on screenshot (known
  SwiftShader/OOM environmental issue — session restart fixes it).
- GAP ANALYSIS for this round: the round-7 next-phase list had
  "garage/vehicle persistence across levels" + "radio DJ segments on
  PULSE/RIOT" as top candidates. Everything else on the list (photo
  DOF, chunk-LOD profiling, price tuning) is lower value than a real
  property/economy system.

## Completed modifications (this round)
1. NEW SYSTEM — src/game/gameplay/GarageSystem.ts, registered as
   engine system 'garage' (GameShell registers after 'services'):
   - ONE lockup pad per level (parking/garage building when authored,
     else road block WEST of spawn — spray is EAST), nudged out of
     walls via physics.collideCircle expanding spiral, kept ≥ 12 m
     from CityServices pads.
   - BUY $300 once ("your key works at every garage in the city") →
     owned flag flips the marker icon from PADLOCK to CAR
     (canvas-drawn sprites, lime #a3e635 ring + disc — same visual
     language as services).
   - STORE (driving, garage empty): exits the player at the door,
     snapshots {vehicleDataId, name, health, maxHealth} — DAMAGE
     PERSISTS through storage — despawns the car (loadLevel wipes all
     physical vehicles; the snapshot does not).
   - TAKE OUT (on foot, car inside): spawns at pad + 2.5 m (inside
     the 4 m F-enter range) with the stored health restored.
   - SWAP (driving, car inside): stores the current ride AND pulls
     the stored one out beside the pad — one press.
   - E-key dispatch added to engine.ts frame() (missions → services →
     garage; pads are ≥ 12 m apart so only one is ever in reach).
   - PERSISTENCE: getSaveData/applySaveData fragments; engine
     buildSavePayload/applySavePayload wire garageOwned +
     garageVehicle; SaveGamePayload extended (types.ts, optional
     fields); /api/saves stateJson write + toRecord read extended
     (server round-trip verified). levelLoaded listener rebuilds the
     pad per level; the stored snapshot survives every swap.
2. BUGFIX (found in QA): the SWAP branch nulled this.stored AFTER
   snapshotting the new car — a swap lost the just-stored vehicle
   (stored=null after swap). Fixed: spawnStored(previous) does not
   touch this.stored; the new snapshot stays.
3. BUGFIX (found in QA): retrieved car spawned 3.5 m out but the
   exit position + findFreeSpot nudged it past the 4 m F-enter range
   (measured 4.5 m). Spawn offset reduced to 2.5 m (measured 3.7 m).
4. NEW FEATURE — Radio DJ interludes (music stations):
   - DJ_LINES banks (4 lines each) + DJ_VOICE_HZ pitches for
     PULSE/DUST/RIOT/NIGHT (talk already IS the DJ).
   - On track change (titleTrackCounter ≥ 8): 55% chance of a 2-bar
     interlude — bar 1: static bed + station-pitched voiceSyllable
     chatter + soft heartbeat kick; bar 2: station-ID jingle (3
     ascending tones through the delay) + short voice tag. The new
     track title roll is DEFERRED until the DJ hands back.
   - RadioState += djLine/djName (wall-clock expiry via djLineUntil);
     clearDj() on station hop + transport restart.
   - RadioStationMeta += dj name (DJ NOVA / MOSS / RIOT ROSA / THE
     NIGHTOWL / BARRY BLUNT).
5. UI/STYLING:
   - HUD GaragePromptPill (lime border/kbd, Warehouse icon,
     action-aware copy: Buy the lockup · $300 / Store X (free) /
     Take out X / Swap to X / Lockup is empty, "(X inside)" suffix).
   - HUD top-right GARAGE ownership chip (Warehouse icon + status
     dot: lime = car parked, zinc = empty) with spring entrance.
   - RadioWidget: ON AIR badge (amber, pulsing Mic icon) + "DJ NAME:
     line" swaps the track line while the DJ talks (AnimatePresence
     mode=wait, EQ bars turn amber, border tints amber).
   - Notification icon chips: kind-tinted circular chip behind each
     notification icon (rose/amber/emerald/zinc at 20% bg).
   - Minimap + BigMap garage blips (lime pitched-roof silhouette,
     "GARAGE $300" tag on big map) + BigMap legend row.
   - DebugBar: TP to garage / Garage: free ownership / Garage status.
   - HINT_ROWS E-row, landing CONTROL_SCHEME + Play-the-Rebuild copy
     + "Everything wired" card document the garage + DJ.

## Verification results (all agent-browser ?debug=1)
- lint CLEAN; dev.log 200-only across the round (one Fast-Refresh
  full-reload warning mid-edit — hot reload artifact, not runtime).
- GARAGE BUY: TP to garage → prompt action=buy price=300 → E →
  money 500→200, owned=true, "Lockup bought — your key works at
  every garage in the city".
- GARAGE STORE: spawn+enter sedan → damage 60 → E → player ejected,
  stored={vehicle_sedan, City Sedan, health 40/100}, damaged car
  DESPAWNED (the other nearby sedan was a level-spawned one @100hp,
  verified by id).
- GARAGE TAKE OUT: E on foot → garage_car spawns at 3.7 m (F-range),
  health 40 restored, "City Sedan is out front — F to get in".
- GARAGE SWAP (post-bugfix): store #1 (100hp) → spawn+damage second
  sedan → E at pad → stored={40hp sedan}, garage_car spawns @100hp,
  toast "Swapped — City Sedan stored, City Sedan is out front".
- LEVEL PERSISTENCE: store 40hp sedan downtown → loadLevel('harbor')
  → pad rebuilt at 400,400, stored snapshot intact → E at harbor pad
  → the downtown car spawns at the harbor with 40hp.
- SAVE ROUND-TRIP: buildSavePayload → {garageOwned:true,
  garageVehicle:{...40hp sedan}} → POST /api/saves → GET
  /api/saves?slot=1 returns both fields → page RELOAD → DebugBar
  "Load slot 1" → level=harbor, owned=true, stored=40hp sedan.
- RADIO DJ: sequencer stalls in headless QA (untrusted clicks don't
  unlock AudioContext — known env limitation, same as rounds 5-7;
  audio voices no-op safely). Direct mechanism test: set djBars=2 +
  djLine → scheduleBar → djBars 2→1 (chatter bar, no throw) →
  getRadioState exposes djLine + djName='DJ NOVA' → second
  scheduleBar → djBars=0, pendingTitleRoll cleared, new title rolled
  ("MIDNIGHT CASCADE"). Widget DOM: "On air" badge + DJ credit + the
  DJ line all render while driving.
- REGRESSIONS: pause (Esc) toggle on/off works; clinic E-path
  ("You're already patched up") works with garage prompt correctly
  null at the clinic; HUD garage chip visible when owned.

## Unresolved issues / risks + next-phase priorities
- Radio DJ AUDIO not audible-verified in headless QA (AudioContext
  unlock limitation); the state machine, scheduling routing and
  widget rendering are all verified — one manual listen in a real
  browser recommended.
- Garage pad fallback position (spawn-100 WEST) not verified on all
  four levels (downtown + harbor verified via rebuild + map point).
- BigMap garage tag could overlap the CLINIC tag if fallbacks land
  close (same cosmetic class as the round-7 CLINIC/mission overlap).
- Next-phase candidates: shop purchase confirm sheet (price list
  instead of instant buy), photo-mode DOF/tilt-shift, chunk-LOD perf
  profiling, service price tuning vs mission payouts, wanted-spray
  exploit guard, multiple garage slots (2-3 cars), garage vehicle
  customization (respray color per car).
- QA lessons (BINDING, unchanged): no file edits while a session is
  live; close sessions between phases; synthetic keys need code:;
  untrusted clicks don't unlock WebAudio.

---
Task ID: cron-webDevReview-202610151300 (round 10) — FINAL
Agent: Lead
Task: Status assessment + QA of the unlogged round-9 work, then
independent feature selection: gun-shop weapon counter (the
mission-requirement gap) + bug sweep (7 fixes) + styling polish.

## Current project status assessment
- A prior round-9 session (commits 03:20–05:04, Oct 15) implemented the
  garage multi-bay system + GaragePanel, service confirm sheets and
  vehicle paint customization but NEVER wrote its worklog section —
  this round recovered that log debt via git archaeology + live QA.
- Round-10 QA at start: dev.log 200-only, lint clean, engine boots
  (hp 100 / money 500), pause toggles, garage buy/store/take-out/
  swap/respray(with paint persistence)/expand all verified E2E,
  clinic confirm-card flow works, save round-trip incl. garageBays +
  garageSlotsData verified.
- Bugs found in QA + a `tsc --noEmit` sweep (dev server transpiles
  without type-checking, so several latent errors shipped silently):
  see fixes below.

## Completed modifications (this round)
1. BUGFIX — GarageSystem duplicate spawn ids: bays can put several
   garage cars on the street at once; the shared forceId 'garage_car'
   broke getById/removeVehicle (wrong car matched). Now
   `garage_car_${++counter}` (verified: two take-outs →
   garage_car_1/garage_car_2, uniqueIds=true).
2. BUGFIX — saves/route.ts type error (garageSlotsData cast indexed a
   `| undefined` union): now casts to (GarageVehicleSnapshot | null)[].
3. BUGFIX — engine.onEvent returned void but DistrictBanner expected
   an unsubscribe → listener leak + TS error. onEvent now returns
   `() => void` that deletes the callback (interface + engine.ts).
4. BUGFIX (user-facing!) — SettingsPanel audio sliders passed
   {master,music,sfx} keys into applySettings while the store uses
   masterVolume/musicVolume/sfxVolume: sliders never moved, never
   persisted, engine got stale values. Keys are now mapped
   (verified: Master slider 0.8 → 0.85 on ArrowRight, renders).
5. BUGFIX — DebugBar "Spawn + enter fresh sedan" passed a plain
   {x,y,z} to spawnVehicle (findFreeSpot calls .clone() → would crash
   on click). Now new THREE.Vector3(...). "Garage status" button now
   uses getGarageStatus (bays + bay-1 snapshot) instead of the
   prompt (which has no `stored`).
6. BUGFIX — RadioSystem DJ jingle passed `dest: this.delay`
   (DelayNode | null) into tone() twice; one site already used
   `?? undefined`, the second now does too.
7. FEATURE — GUN SHOP COUNTER (the mission-requirement gap fix):
   missions gate on weapons ("a smg (visit the gun shop area)") but
   the shop only refilled ammo — SMG/Shotgun/Rifle were unobtainable
   without debug cheats. Now:
   - WeaponSystem: WeaponShopEntry + WEAPON_PRICES (pistol $250 /
     smg $450 / shotgun $350 / rifle $800) + getShopEntries() with
     live owned flags and full stats (damage, burst, rpm, mag, range).
   - CityServices: E at the ammo pad OPENS THE SHOP SHEET instead of
     arming the $40 confirm (clinic + spray keep the round-9 confirm
     cards). Shop state machine: openShop/closeShop + 'gunShopPanel'
     engine event + walk-away leash (7.5 m) + wasted/busted close +
     onUiClosed hook. buyWeapon() validates shop-open/owned/cash
     BEFORE addMoney; buyAmmoTopup() is the old $40 refill as a row.
     wouldDoSomething(ammo) now also true when a firearm is unowned.
   - GunShopPanel.tsx (new): amber-themed overlay — header (Ammu-City,
     x/4 OWNED badge, wallet chip), reserve top-up row (RESERVES FULL
     chip when nothing to fill), 2×2 weapon cards with icon + tag
     (SIDEARM/AUTO·HOLD/SPREAD/LONG RANGE), four live stat bars
     (DMG/RATE/MAG/RANGE), OWNED chip or Buy button ("Need $X more"
     when broke), E/Esc/Leave close, 300 ms stock polling.
   - GameShell: renders GunShopPanel, wires 'gunShopPanel' events +
     modal key chain (E/Esc leave the counter; engine keys blocked).
   - state.ts: gunShopOpen + setter + resetToMenu cleanup.
   - engineViews: getGunShopStock/gunShopCanTopUp/gunShopBuyWeapon/
     gunShopBuyAmmoTopup duck-typed views.
   - HUD pill for ammo → "Browse stock · guns from $250 · top-up
     $40", never sr-only-blocked (browse ≠ buy).
   - BigMap: AMMO $40 tag → GUN SHOP + legend copy; MissionSystem
     requirement copy → "the gun shop counter sells them — amber ring
     on the map"; landing copy + "Everything wired" card updated.
8. FEATURE — spray exploit guard (round-8 carry-over): canPurchaseNow
   rejects the spray while an actively pursuing cruiser is within
   16 m ("Too hot — a cruiser is right on you. Lose them first") via
   pursuit.getPursuit() distance check (wanted > 0 only).
9. CONFIRM WINDOW 6 s → 8 s (HUD countdown ring scale updated to /8).
10. STYLING:
    - HUD money chip: direction-aware tint (emerald on gain, rose on
      loss) + floating "+$X / −$X" delta that drifts up and fades
      (1.5 s, AnimatePresence; verified +$75 renders).
    - Landing StatChips: spring hover lift + emerald border tint.
    - GunShopPanel cards compacted (p-3.5, tighter gaps) so all four
      fit a 1280×800 viewport without scrolling (VLM re-verified).

## Verification results (all agent-browser ?debug=1)
- lint CLEAN; tsc --noEmit ZERO src/ errors (was 8, all fixed);
  dev.log 200-only across the whole round.
- GUN SHOP E2E: E at ammo pad opens sheet (Ammu-City renders); buy
  SMG $500→$50 + weaponsOwned=[fists,pistol,smg] + full mag/reserve;
  duplicate buy rejected ("You already own"); buy shotgun $550→$200;
  rifle rejected at $200 (needs $800) with money untouched; top-up
  drained pistol/smg reserves → 60/120/24 restored for $40;
  canTopUpAmmo=false → RESERVES FULL chip; E-close + Esc-close work
  (realistic dispatch on document.body — dispatching on window hits
  the target phase where stopPropagation can't block the engine's
  listener; a REAL key event is fine); walk-away leash closes
  (teleport > 7.5 m); save round-trip: weaponsOwned persists through
  POST /api/saves → GET slot 1.
- CLINIC regression: 8 s window (armed 8 → 5.9 after 2 s), confirm →
  hp 100, −$50, card cleared. Rejected when broke without charging.
- SPRAY regression: damaged car + wanted 2, no cruiser → arms +
  confirms (hp 40→100, wanted→0, −$100). Guard positive case: fake
  pursuing cruiser injected 8 m away → arming BLOCKED (nothing armed).
- GARAGE regression: unique ids on two simultaneous take-outs; store
  (damage + paint persist); debugGiveOwnership + expand + fill.
- SETTINGS: pause → Settings → Master slider 0.8 → 0.85 on
  ArrowRight (the fix — sliders were dead before).
- PHOTO MODE (round-6 carryover): enter (V path via togglePhotoMode)
  → capturePhoto (snapCount 1, no throw) → exit clean; the PNG
  file-save itself still needs one real-browser spot check.
- VLM: gunshop panel at 1280×800 — 4/4 cards fully visible, no
  overlaps, "sleek, high-contrast" verdict; debug bar accurately
  transcribed (all buttons incl. TP to gun shop / Garage status).
- QA screenshots: download/qa-round10/ (gunshop-open, money-delta,
  photomode, final-hud, hud-overlay).

## Unresolved issues / risks + next-phase priorities
- Full-WebGL viewport screenshots wedge the SwiftShader QA box even
  in performance mode (known rounds-6-10 limit): functional E2E
  asserts engine state directly; DOM overlays screenshot fine with
  the canvas hidden. One manual real-browser screenshot session
  recommended for the marketing page.
- Radio DJ audio + photo PNG file-save: mechanisms verified headless,
  audible/visual confirmation still needs a real browser (carry-over).
- Weapons balance: prices are first-pass (SMG $450 vs bank-heist $5k
  ladder); a play-tuning pass against mission payouts + armor pickups
  is the natural next step.
- Next-phase candidates: armor vest purchasable at the clinic ($75,
  fills the unused armor bar — HUD already renders it), buyable
  mission hints/waypoint pings, vehicle trade-in at the garage
  (sell stored cars for 50%), wanted-level decay tuning, chunk-LOD
  perf profiling, service price tuning vs side-hustle payouts,
  multiple garage slots per bay, day/night-driven gang activity.
- QA lessons (BINDING, updated): synthetic key events MUST dispatch
  on document.body (window dispatch hits target phase where capture
  stopPropagation cannot block the engine listener); no file edits
  while a session is live; close sessions between test phases;
  perf mode + hidden canvas for DOM-overlay screenshots;
  `agent-browser set viewport W H` for layout verification.
