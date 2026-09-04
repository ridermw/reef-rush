# Reef Rush

Reef Rush is a polished underwater time-trial arcade game for the browser. The project aims for
fast restarts, readable racing lines, and replayable courses that reward precision more than grind.

## Target scope

The first public milestone targets three courses:

1. **Sunlit Shoals** for a bright opening sprint that rewards smooth reef lines.
2. **Kelpworks** for dense kelp lanes and drifting corners that raise the pace.
3. **Blacksmoker Run** for a volatile trench descent built for high-pressure finishes.

## Desktop controls

| Input                   | Action                          |
| ----------------------- | ------------------------------- |
| `W` / `S`               | Throttle forward / reverse      |
| `A` / `D`               | Steer left / right              |
| `ArrowUp` / `ArrowDown` | Pitch up / down                 |
| `Space`                 | Trigger boost pickups           |
| `Left Shift`            | Feather speed for tight corners |
| `R`                     | Restart the current run         |
| `Esc`                   | Pause                           |

## Architecture summary

- **Vite + React + TypeScript** provide the browser shell, authoring ergonomics, and typed UI code.
- **Three.js** is the planned rendering layer for the underwater world and effects.
- **Rapier** is reserved for deterministic movement and collision work as gameplay systems arrive.
- **Zod** will validate runtime-facing configuration and content contracts.
- **Vitest + Testing Library + Playwright** cover unit, interaction, and browser validation paths.

## Local commands

Use Node.js `24.20.0` for every npm command:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24.20.0
npm install
```

| Command                   | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`             | Start the local Vite dev server                                                |
| `npm run build`           | Create the production bundle at the GitHub Pages base path                     |
| `npm run build:test`      | Build with test hooks enabled                                                  |
| `npm run typecheck`       | Run the TypeScript project references                                          |
| `npm run lint`            | Run ESLint across the repository                                               |
| `npm run test`            | Run the Vitest suite                                                           |
| `npm run test:browser`    | Run Playwright browser tests                                                   |
| `npm run assets:validate` | Check required licensing files                                                 |
| `npm run validate`        | Run formatting, lint, typecheck, tests, asset validation, and production build |

## License split

- Source code is licensed under the MIT License in [`LICENSE`](LICENSE).
- First-party art, audio, UI, narrative, and marketing assets are licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) as described in
  [`ASSET-LICENSE.md`](ASSET-LICENSE.md).
- Third-party dependencies and any third-party assets remain under their own licenses and notices.

## Progress

| Progress                              |
| ------------------------------------- |
| Project foundation — complete.        |
| Application shell — complete.         |
| Input and fixed-step loop — complete. |
| Fish movement model — complete.       |
| Physics and chase camera — complete.  |
| Course framework: complete.           |
| First playable course — planned.      |

## Development handoff

The September 4, 2026 cross-device checkpoint is documented in
[`docs/handoffs/2026-09-04-reef-rush.md`](docs/handoffs/2026-09-04-reef-rush.md).
