# game-dev-open-world-web

**A playable, browser-native rebuild of [game-dev-open-world](https://github.com/utksh1/game-dev-open-world) — the open-world GTA-like engine whose documentation promised 100% but whose C++ build delivered ~25%.**

This repo addresses every documented gap: the fixed-timestep engine, the 3D renderer, physics, vehicles, A* AI, traffic, the 14-mission campaign, weapons, saves, HUD, minimap and audio are all **actually implemented and playable in the browser** — and the game loads and parses the original repository's **32 real asset files** (levels, missions, campaign, vehicles, NPCs).

## Play it

```bash
bun install
bun run db:push     # create the SQLite schema (save slots)
bun run dev         # http://localhost:3000
```

Open `http://localhost:3000`, scroll to **Play**, click **Play the Rebuild**.

## What was wrong with the original build

| # | Docs claimed | Reality (C++ build) | Delivered here |
|---|---|---|---|
| 1 | Input class, math library | `Input.h`/`Window.h` never existed; hand-poked matrices | Full `InputManager` (keyboard, mouse-look, pointer lock) + Three.js math layer |
| 2 | "Metal 3.0 renderer, PBR" | OpenGL 3.3, Blinn-Phong, dead `.metal` files, UB cast in `endFrame` | WebGL2/Three.js, `MeshStandardMaterial` PBR, sun + point + spot lights, frustum culling |
| 3 | Character + vehicle physics | `dt` passed as speed → player moved ~2cm/s; vehicle class never instantiated | Correct fixed-timestep integration; `VehicleController` driven by `.vehicle` stats |
| 4 | OBJ/PNG loader, materials | `loadPNG()` returned solid white; fake 98-line BMP-only stb | Server `ContentLoader` parses **all 32 asset files**; procedural PBR materials |
| 5 | World streaming + 4-level LOD | chunks generated but never rendered; LOD never instantiated | Streaming chunks actually added/removed around the player; 4-tier LOD |
| 6 | A* pathfinding, NPC states, traffic | `findPath` never called; DRIVING/FLEEING unimplemented; zero traffic | A* drives pedestrians & police every frame; all NPC states; traffic from spawn points |
| 7 | Missions, weapons, saves | print-only loader; uninitialized-pointer mission update; save system never called | 15 objective types, enemy waves, campaign progression; 5 weapons with timed reload; Prisma-backed 3-slot saves |
| 8 | HUD, minimap, menus | `HUD::render()`, `Minimap::render()`, `Menu::render()` were **empty functions** | Full HUD (health/armor/ammo/money/wanted/speed), canvas minimap with blips + waypoints, main/pause menus, settings |
| 9 | 3D positional audio | `init() { return true; }` — zero backend | Web Audio: positional gunshots, RPM-tracked engine, footsteps, ambient bed, radio |
| 10 | "Zero warnings, verified" | duplicate `stbi_*` symbols = link failure; glm missing from CMake | Strict TypeScript, lint-clean, QA-verified in-browser |

Full audit: `src/data/gapAnalysis.ts` (rendered live on the landing page).

## Controls

| Keys | Action |
|---|---|
| `W A S D` | Move / steer |
| `Shift` | Sprint |
| `Space` | Jump / handbrake |
| Mouse | Look (click canvas to lock) |
| `F` | Enter / exit vehicle |
| `C` | FPS / TPS camera |
| LMB | Fire |
| `1-5` / scroll | Weapon wheel |
| `E` | Interact (missions, clinic, gun shop, Pay'n'Spray, garage) |
| `V` | Photo mode |
| `M` / `T` | Big map / fast travel |
| `Esc` / `P` | Pause |

## Architecture

```
src/game/types.ts        # shared contract: HudState, IGameEngine facade, EngineEvent
src/game/core/           # fixed-timestep loop, Time, InputManager
src/game/physics/        # AABB vs buildings, raycast
src/game/renderer/       # Three.js scene, lights, skybox, FPS/TPS camera
src/game/world/          # WorldStreamer + LOD from LevelData
src/game/vehicles/       # VehicleController (.vehicle stats), VehicleManager
src/game/ai/             # A* pathfinder, NPCManager, TrafficSystem
src/game/gameplay/       # MissionSystem, WeaponSystem, Inventory, SaveSystem
src/game/audio/          # WebAudio synthesis (engine, guns, footsteps, ambient)
src/lib/content/loader.ts# server parser for the original repo's asset formats
src/app/api/             # /api/content/all, /api/saves (Prisma + SQLite)
src/components/game/     # HUD, Minimap, menus, GunShop, briefing screens
```

- **Engine contract**: the UI never touches Three.js — only `HudState` (pushed at ~10 Hz) + engine commands through the `IGameEngine` facade.
- **Saves**: 3 slots via Prisma/SQLite + localStorage autosave, round-trip verified.
- **Assets**: `content/` is a verbatim copy of the original repo's asset tree — parsed at runtime, not faked.

## Verification

Every feature was QA-verified headlessly (agent-browser, `?debug=1`): mission chain, weapon purchases, clinic/spray/garage services, save round-trips, settings, photo mode. See `docs/DEVELOPMENT_LOG.md` for the full round-by-round record.

## License

MIT — same as the original repository.
