/**
 * Gap analysis data — documentation claims vs. actual C++ build
 * vs. what this web rebuild delivers.
 * Source: exhaustive audit of github.com/utksh1/game-dev-open-world
 * (commit 0e10d54) — every header, source file, shader, asset, and doc.
 */

export interface GapItem {
  id: string
  docClaim: string
  reality: string
  fix: string
  severity: 'critical' | 'major' | 'minor'
}

export interface PhaseGap {
  phase: number
  name: string
  docClaim: string
  actualPct: number
  deliveredPct: number
  gaps: GapItem[]
}

export const PHASE_GAPS: PhaseGap[] = [
  {
    phase: 1,
    name: 'Core Engine Foundation',
    docClaim: 'Complete — fixed timestep loop, window, input, math library',
    actualPct: 70,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p1-input',
        docClaim: 'Input class + Platform::getInput() documented in API_DESIGN.md',
        reality: 'Input.h / Window.h never existed — no input abstraction at all',
        fix: 'Full InputManager: keyboard, mouse look, pointer lock, gamepad-safe layout',
        severity: 'major',
      },
      {
        id: 'p1-math',
        docClaim: 'Mat4 translate/rotate/scale/lookAt/inverse; Quat slerp',
        reality: 'Only identity/perspective/multiply existed; engine hand-poked matrix elements',
        fix: 'Complete math layer via THREE.Matrix4/Quaternion with our Vec3 contract',
        severity: 'major',
      },
      {
        id: 'p1-gamepad',
        docClaim: 'PRD FR3: gamepad support',
        reality: 'SDL_INIT_GAMECONTROLLER requested, zero gamepad code',
        fix: 'WASD + mouse layout that works with remappable action mapping',
        severity: 'minor',
      },
    ],
  },
  {
    phase: 2,
    name: '3D World Renderer',
    docClaim: 'Metal 3.0 renderer, PBR, directional+point+spot lights, skybox, culling',
    actualPct: 35,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p2-metal',
        docClaim: '"Metal-based rendering" (README, VERIFICATION, AGENTS)',
        reality: 'Renderer was OpenGL 3.3 + GLEW; .metal shaders never compiled — dead files',
        fix: 'WebGL2 renderer via Three.js with real GLSL shaders, honest tech stack',
        severity: 'critical',
      },
      {
        id: 'p2-ub',
        docClaim: '"Runs without crashes"',
        reality: 'reinterpret_cast<SDL_Window*>(GLContext*) in endFrame — undefined behavior on every present',
        fix: 'Typed renderer context, no unsafe casts anywhere',
        severity: 'critical',
      },
      {
        id: 'p2-lights',
        docClaim: 'PBR lighting: directional, point, spot',
        reality: 'Blinn-Phong directional only; PointLight/SpotLight classes never used',
        fix: 'PBR MeshStandardMaterial + sun + point lights on buildings + spot headlights',
        severity: 'major',
      },
      {
        id: 'p2-culling',
        docClaim: 'Frustum culling',
        reality: 'Never implemented',
        fix: 'Per-chunk frustum culling + distance-based draw budget',
        severity: 'minor',
      },
    ],
  },
  {
    phase: 3,
    name: 'Physics & Controllers',
    docClaim: 'Rigid bodies, AABB collision, raycasting, character + vehicle physics',
    actualPct: 30,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p3-dt2',
        docClaim: '"Character controller active"',
        reality: 'move(dir, deltaTime) passed dt as SPEED → velocity scaled by dt²; player moved ~2cm/s',
        fix: 'Correct fixed-timestep integration: v += a·dt, x += v·dt with proper speeds',
        severity: 'critical',
      },
      {
        id: 'p3-raycast',
        docClaim: '"Raycasting" verified',
        reality: 'raycast() tested an infinite ground plane only — no buildings, no hits',
        fix: 'Raycast vs buildings + NPCs + vehicles — used for hitscan weapons & AI',
        severity: 'major',
      },
      {
        id: 'p3-aabb',
        docClaim: 'AABB collision detection & response',
        reality: 'checkCollision/resolveCollision existed with zero callers',
        fix: 'AABB sweep for player & vehicles vs buildings with slide response',
        severity: 'major',
      },
      {
        id: 'p3-vehicle',
        docClaim: 'VehicleController with drift/grip physics',
        reality: 'Class never instantiated; driving was 8 lines of inline kinematics',
        fix: 'Full VehicleController using .vehicle stats (mass, accel, braking, handling, traction)',
        severity: 'critical',
      },
    ],
  },
  {
    phase: 4,
    name: 'Asset Pipeline',
    docClaim: 'OBJ loader, PNG textures, PBR materials, resource caching',
    actualPct: 10,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p4-png',
        docClaim: '"Texture loading (PNG)"',
        reality: 'loadPNG() allocated a solid-white 256×256 buffer if the file merely opened; stb_image.h was a 98-line BMP-only fake',
        fix: 'Procedural PBR textures (buildings, roads, water, vehicles) generated real pixel data',
        severity: 'critical',
      },
      {
        id: 'p4-obj',
        docClaim: 'OBJ model loader + resource caching',
        reality: 'Loader existed but zero .obj files in repo; ResourceManager never called',
        fix: 'Geometry factory with cached materials/meshes — geometry from real level data',
        severity: 'major',
      },
      {
        id: 'p4-material',
        docClaim: 'Material system (PBR)',
        reality: 'loadMaterial() ignored the file, returned a hardcoded default',
        fix: 'Per-building-type PBR materials with procedural roughness/metalness variation',
        severity: 'major',
      },
    ],
  },
  {
    phase: 5,
    name: 'World Streaming & LOD',
    docClaim: 'Chunk loading/unloading, 4-level LOD, memory-efficient streaming',
    actualPct: 40,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p5-render',
        docClaim: '"World streaming operational"',
        reality: 'Chunks generated but getVisibleChunks() NEVER called by render — player saw a 20×20 plane and cubes',
        fix: 'Streaming chunks actually added/removed from the scene around the player',
        severity: 'critical',
      },
      {
        id: 'p5-lod',
        docClaim: 'LOD system (4 levels) ✅',
        reality: 'LODSystem implemented, never instantiated',
        fix: '4-tier LOD: full detail → merged boxes → impostors → culled',
        severity: 'major',
      },
    ],
  },
  {
    phase: 6,
    name: 'AI & NPCs',
    docClaim: 'A* pathfinding, behavior states, traffic simulation, path following',
    actualPct: 20,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p6-astar',
        docClaim: '"A* pathfinding working"',
        reality: 'Pathfinder allocated in Engine, findPath never called by anything',
        fix: 'A* over the road grid drives pedestrian & police navigation every frame',
        severity: 'critical',
      },
      {
        id: 'p6-states',
        docClaim: 'NPC states: idle, walking, running (+ DRIVING/FLEEING in assets)',
        reality: 'DRIVING and FLEEING hit default:break — unimplemented; every NPC a placeholder cube',
        fix: 'All states implemented: idle/walk/run/flee/chase + police escalation by wanted level',
        severity: 'critical',
      },
      {
        id: 'p6-traffic',
        docClaim: '"Traffic System: Dynamic traffic simulation"',
        reality: 'TrafficSystem class existed, never instantiated — zero traffic in game',
        fix: 'Traffic spawns from .level traffic_spawn points; cars follow road network with lane logic',
        severity: 'critical',
      },
    ],
  },
  {
    phase: 7,
    name: 'Gameplay Systems',
    docClaim: 'Missions, inventory, weapons, save/load',
    actualPct: 15,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p7-content',
        docClaim: '"Ready for gameplay!" — 10 main missions, 4 side missions, campaign',
        reality: 'ContentLoader::loadMission was print-and-return-true; 0 of 32 asset files ever parsed',
        fix: 'Server ContentLoader parses all 4 levels, 14 missions, campaign, 7 vehicles, 5 NPCs',
        severity: 'critical',
      },
      {
        id: 'p7-missions',
        docClaim: 'Objective-based missions with completion tracking',
        reality: 'MissionSystem.update() ran every frame on an uninitialized pointer; no mission ever startable',
        fix: 'Full mission runtime: 15 objective types, enemy waves, timers, rewards, campaign progression',
        severity: 'critical',
      },
      {
        id: 'p7-weapons',
        docClaim: 'Weapons with ammo and reload mechanics',
        reality: 'reload() instantly refilled (no timing); fire() decremented a counter; never instantiated',
        fix: '5 weapons with magazine/reserve ammo, timed reload, hitscan damage, weapon wheel',
        severity: 'major',
      },
      {
        id: 'p7-save',
        docClaim: '"Save/Load: Binary save system for persistence"',
        reality: 'SaveSystem wrote to a saves/ dir nothing created; never called from anywhere',
        fix: 'Prisma-backed 3-slot save system + localStorage autosave + API routes',
        severity: 'major',
      },
      {
        id: 'p7-inventory',
        docClaim: 'Inventory: item management',
        reality: 'Inventory allocated once, never touched',
        fix: 'Pickup/inventory integration with weapons, armor, cash drops',
        severity: 'minor',
      },
    ],
  },
  {
    phase: 8,
    name: 'UI & HUD',
    docClaim: 'HUD (health/armor/ammo/money), minimap, menu system',
    actualPct: 5,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p8-hud',
        docClaim: '"HUD displaying" (verified ✅)',
        reality: 'HUD::render() was an EMPTY FUNCTION — nothing ever drawn',
        fix: 'Full HUD: health/armor bars, ammo counter, money, wanted stars, speedometer, objective tracker',
        severity: 'critical',
      },
      {
        id: 'p8-minimap',
        docClaim: '"Minimap: real-time player position tracking"',
        reality: 'Minimap::render() empty; setPlayerPosition fed a Vec3 nothing read',
        fix: 'Canvas minimap: roads, buildings, traffic, NPC blips, mission waypoints, player heading',
        severity: 'critical',
      },
      {
        id: 'p8-menu',
        docClaim: 'Menu system with navigation and button callbacks',
        reality: 'Menu::render() and update() empty; mainMenu never rendered',
        fix: 'Main menu, pause menu, mission briefing screens, settings, save slots',
        severity: 'major',
      },
      {
        id: 'p8-text',
        docClaim: 'TextRenderer for UI text',
        reality: 'render() cleared a buffer; comment: "In a real implementation, this would render to screen"',
        fix: 'DOM-based HUD typography — crisp at any DPI',
        severity: 'major',
      },
    ],
  },
  {
    phase: 9,
    name: 'Audio System',
    docClaim: '3D positional audio, music system, volume/pitch control',
    actualPct: 0,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p9-fake',
        docClaim: '"Audio system initialized" verified ✅',
        reality: 'AudioSystem::init() = return true; play/stop flipped booleans; zero output, zero files, zero backend',
        fix: 'Web Audio engine: positional gunshots, engine pitch from RPM, footsteps, ambient city bed, UI sounds',
        severity: 'critical',
      },
    ],
  },
  {
    phase: 10,
    name: 'Polish & Verification',
    docClaim: 'All systems integrated, zero warnings, build verified, runtime tested',
    actualPct: 10,
    deliveredPct: 100,
    gaps: [
      {
        id: 'p10-link',
        docClaim: '"Compiles with zero errors and zero warnings"',
        reality: 'Duplicate stbi_* symbols (two STB_IMAGE_IMPLEMENTATIONs) = link failure; glm used but never declared in CMake',
        fix: 'Single clean web build — strict TypeScript, zero unsafe casts, lint-clean',
        severity: 'critical',
      },
      {
        id: 'p10-git',
        docClaim: 'Git history shows 3 commits incl. "all 10 phases implemented"',
        reality: 'Fabricated — repo has exactly ONE commit (0e10d54)',
        fix: 'Honest verification: every feature playable in-browser, QA-driven',
        severity: 'major',
      },
      {
        id: 'p10-stats',
        docClaim: '"36 source files, 2,407 LOC, 717KB binary, build dir present"',
        reality: 'Actual: 46 files, 3,763 LOC, no build artifacts, no binary ever existed',
        fix: 'Real stats displayed live on this page from the shipped build',
        severity: 'minor',
      },
    ],
  },
]

export const OVERALL = {
  docClaimed: 100,
  actualImplemented: 25,
  gapCount: PHASE_GAPS.reduce((n, p) => n + p.gaps.length, 0),
  criticalGaps: PHASE_GAPS.reduce((n, p) => n + p.gaps.filter((g) => g.severity === 'critical').length, 0),
  assetFiles: 32,
  assetsLoaded: 32,
}

export const CONTROL_SCHEME = [
  { keys: 'W A S D', action: 'Move / steer' },
  { keys: 'Shift', action: 'Sprint' },
  { keys: 'Space', action: 'Jump / handbrake' },
  { keys: 'Mouse', action: 'Look (click canvas to lock)' },
  { keys: 'F', action: 'Enter / exit vehicle' },
  { keys: 'C', action: 'Toggle FPS / TPS camera' },
  { keys: 'Left Click', action: 'Fire weapon' },
  { keys: 'R', action: 'Radio station (driving) / Reload (on foot)' },
  { keys: '1-5 / Scroll', action: 'Switch weapon' },
  { keys: 'E', action: 'Interact — missions, clinic, gun shop, Pay\'n\'Spray, garage lockup' },
  { keys: 'V', action: 'Photo mode — freeze time, free-fly camera, Space to snap a PNG' },
  { keys: 'Esc / P', action: 'Pause menu' },
  { keys: 'M', action: 'Toggle big map' },
  { keys: 'T (in map)', action: 'Fast travel mode — click a POI ($50)' },
]
