# Cruise Racer: Design

Date: 2026-11-11

## Goal

A 3D browser racing game in which the player races Royal Caribbean cruise ship
classes around buoy-marked ocean circuits against AI rivals. The feel is
"Forza, but ships": sim-cade handling with real ship behaviour (momentum, wide
turning circles, sideways slide) at speeds scaled up so races are fast.

## Platform and stack

- Three.js, TypeScript, Vite. Run with `npm run dev`.
- Vitest for unit tests of the simulation code.
- No physics engine. Ship dynamics are custom code on the 2D water plane.
- No external art assets. Ships, terrain and buoys are built in code.

## Architecture

Simulation code is pure TypeScript with no Three.js imports, so it can be unit
tested. Rendering reads simulation state each frame.

| Module | Purpose |
|---|---|
| `src/sim/ships.ts` | Ship class data: name, dimensions, stats |
| `src/sim/physics.ts` | Ship state and the per-step dynamics update |
| `src/sim/track.ts` | Track definitions: closed spline centreline, width, islands, checkpoints |
| `src/sim/race.ts` | Race state: countdown, checkpoints, laps, positions, finish |
| `src/sim/ai.ts` | AI helm: follows the centreline with look-ahead and corner braking |
| `src/sim/collision.ts` | Ship-to-ship, ship-to-island and off-course handling |
| `src/render/ocean.ts` | Wave-shader ocean surface |
| `src/render/shipModel.ts` | Procedural ship meshes per class |
| `src/render/world.ts` | Sky, lighting, islands, buoys, wakes |
| `src/render/camera.ts` | Chase camera and bridge view |
| `src/ui/` | Menus (ship select, track select), HUD, minimap, results |
| `src/input.ts` | Keyboard and gamepad input mapped to throttle and rudder |
| `src/main.ts` | Game state machine and the main loop |

The simulation runs on a fixed 60 Hz step, decoupled from the render rate.

## Ships

Five classes. Stats are relative to each other, loosely based on the real
ships' size and proportions, and tuned for play.

| Class | Length | Character |
|---|---|---|
| Icon | 365 m | Fastest in a straight line, slowest to turn |
| Oasis | 362 m | Heavy, stable, strong top speed |
| Quantum | 348 m | Balanced all-rounder |
| Freedom | 339 m | Quick to accelerate, mid top speed |
| Radiance | 293 m | Smallest, most agile, lowest top speed |

Each class has: top speed, acceleration, turn rate, lateral grip and mass.
Models are procedural and match each class's silhouette (hull shape, deck
tiers, funnel arrangement, signature features). They are not official models.

## Handling model

State per ship: position (x, z), heading, forward speed, lateral speed, yaw
rate, throttle, rudder.

- Throttle ramps towards the commanded value; thrust acts along the heading.
- Drag grows with the square of speed, giving each class a top speed.
- Rudder authority scales with speed: no steering when stopped, reduced
  steering at very high speed.
- Yaw rate has inertia, so turns build up and carry on after the helm centres.
- Turning converts forward speed into lateral slide, which lateral grip bleeds
  off. Hard turns therefore cost speed.
- Reverse thrust is available at reduced power.
- Speeds are scaled roughly 5 to 6 times real life; the HUD shows knots.

## Tracks

Three circuits, each a closed spline with a width, islands and buoys:

1. Island Loop: wide, flowing Caribbean circuit. The beginner track.
2. Harbour Sprint: tight port course with breakwaters and sharp turns.
3. Fjord Run: long channel between steep walls with fast sweeping bends.

Leaving the marked course slows the ship. Islands and walls are solid.

## Racing

- Six ships per race: the player and five AI rivals in a staggered grid.
- Three laps, with a 3-2-1 countdown.
- Checkpoints along the centreline must be passed in order, which prevents
  course cutting and gives race positions.
- AI steers towards a look-ahead point on the centreline, slows for corners
  and has a per-rival pace factor so the field spreads out.
- Collisions push ships apart and cost speed.

## Screens

Title, ship select (with stat bars and a rotating model), track select, race
HUD (speed, position, lap, lap time, best lap, minimap), results.

## Controls

- W / Up: ahead. S / Down: astern. A, D / Left, Right: rudder.
- C: toggle chase and bridge camera. R: reset to last checkpoint. Esc: pause.
- Gamepad: right trigger ahead, left trigger astern, left stick rudder.

## Testing

- Unit tests for physics (top speed, turning behaviour, class ordering), race
  logic (checkpoint order, lap counting, positions) and AI (completes a lap).
- Manual play in a browser for feel, visuals and frame rate.

## Out of scope

Sound, multiplayer, weather, career mode, upgrades, mobile touch controls.
