# Cruise Racer Implementation Plan

**Goal:** Build the 3D browser cruise ship racing game described in
`docs/superpowers/specs/2026-11-11-cruise-racer-design.md`.

**Architecture:** Pure TypeScript simulation (`src/sim`) with unit tests, read
each frame by a Three.js renderer (`src/render`) and DOM UI (`src/ui`). Fixed
60 Hz simulation step.

**Tech stack:** Three.js, TypeScript, Vite, Vitest.

This plan is a task list with interfaces. It does not duplicate the code.

## Conventions

- World units are metres. Y is up. The sea is the XZ plane.
- Heading `h`: forward is `(sin h, cos h)` in (x, z); starboard is
  `(-cos h, sin h)`. A turn to starboard decreases `h`.
- Displayed knots = world speed / (0.5144 x 6).

## Tasks

- [ ] 1. Scaffold: `package.json`, `tsconfig.json`, `index.html`, Vite, Vitest.
- [ ] 2. `src/sim/ships.ts`: `ShipClass`, `SHIP_CLASSES`, `toKnots`.
- [ ] 3. `src/sim/physics.ts`: `ShipState`, `Helm`, `stepShip`. Tests: reaches
      top speed, turning loses speed, class ordering, no steering at rest.
- [ ] 4. `src/sim/track.ts`: `Track` (spline sampling, `nearest`, `pointAt`,
      walls) and `TRACKS`. Tests: closed, evenly sampled, obstacles clear of
      the course.
- [ ] 5. `src/sim/collision.ts`: ship-obstacle and ship-ship resolution. Tests.
- [ ] 6. `src/sim/ai.ts`: `AiDriver.helm`. Test: completes a lap on every
      track with every class.
- [ ] 7. `src/sim/race.ts`: `Race` (grid, countdown, progress, laps,
      positions, finish). Tests: lap counting, ordering, no course cutting.
- [ ] 8. `src/render/`: ocean shader, sky and lighting, ship models, islands,
      buoys, gates, wakes, cameras.
- [ ] 9. `src/input.ts` and `src/ui/`: menus, HUD, minimap, results, pause.
- [ ] 10. `src/main.ts`: state machine and loop.
- [ ] 11. Verify: tests, type check, production build, play in a browser.
