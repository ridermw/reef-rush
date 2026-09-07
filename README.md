# Reef Rush

An original underwater time trial for the browser. Guide Sunfin through
checkpoints, collect pearls, and race for medals. This is a playable proof of
concept, not a finished commercial game.

**Demo URL:** <https://ridermw.github.io/reef-rush/>

## Play

Choose **Dive in**, then load Sunlit Shoals. Clear the checkpoints in order and
collect every pearl to qualify for a medal. Earning a medal opens the next course:

1. **Sunlit Shoals:** a bright reef sprint.
2. **Kelpworks:** kelp lanes, currents and tighter corners.
3. **Blacksmoker Run:** a volcanic trench with moving hazards.

Choose **Race again** after finishing. To restart during a run, pause, choose
**Return to title**, and load the course again; saved records are preserved.
Settings include mouse steering, sound, render quality and reduced effects.
Diagnostics shows rendering and resource information.

## Phone controls

Drag the lower left **Steer** pad to turn and pitch. The fish swims forward
automatically. Hold **Faster**, **Slower** or **Brake** to adjust speed; tap
**Dash** for a burst. Steering and an action can use separate fingers.
The pause button remains available during play. Both portrait and landscape
layouts account for the phone's usable screen area.

## Desktop controls

The fish swims forward automatically. On desktop, click or focus the game canvas
before using the keyboard.

| Input                                   | Action                           |
| --------------------------------------- | -------------------------------- |
| `W`                                     | Speed up                         |
| `S`                                     | Slow toward a stop, not reverse  |
| `A` / `D` or `ArrowLeft` / `ArrowRight` | Steer left / right               |
| `ArrowUp` / `ArrowDown`                 | Pitch up / down                  |
| `Space`                                 | Dash using the available reserve |
| `Shift`                                 | Brake                            |
| `Escape`                                | Pause or resume outside a dialog |
| Mouse movement                          | Steer when enabled in Settings   |

Inside a dialog, `Escape` closes the dialog without resuming the race. There is
no `R` restart shortcut or boost pickup mechanic.

## Local progress

Course records and unlocks are saved in this browser's local storage. Settings
are stored separately. There is no account, cloud synchronization or online
leaderboard; clearing browser data removes local records.

The **Saved progress** dialog can back up invalid stored data before a guarded
replacement. It does not import backups or reset valid records, and data from
an unsupported version is protected from replacement. Storage failures are
reported, but persistence through blocked storage or a forced process exit
is not guaranteed.

## Run locally

Install the Node.js version in `.nvmrc` (currently `24.20.0`). Use that version
for every npm command and preserve the public registry configuration and lockfile.

```powershell
node --version
npm ci
npm run dev
```

Open the address printed by Vite, normally
<http://localhost:5173/reef-rush/>. Blender is not needed to run, build or test
the game; it is only required for explicit asset authoring.

| Command                                              | Purpose                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `npm run build`                                      | Build normal production output under the `/reef-rush/` base |
| `npm run preview`                                    | Serve the production build locally                          |
| `npm run typecheck`                                  | Check TypeScript                                            |
| `npm run lint`                                       | Run ESLint                                                  |
| `npm run test -- tests\unit\InputController.test.ts` | Run a focused existing test file                            |
| `npm run test:browser -- --project=production`       | Run the three normal production browser scenarios           |
| `npm run test:browser -- --project=mobile`           | Run phone viewport and touch scenarios                      |
| `npm run test:browser`                               | Run the broader browser suite                               |
| `npm run assets:validate`                            | Validate original assets and licensing contracts            |
| `npm run validate`                                   | Run the complete local validation sequence                  |

Install the browsers used by Playwright before the first browser run:

```powershell
npm exec -- playwright install chromium webkit
```

`npm run build:test` enables acceptance hooks for testing. Do not publish that
output as the demo.

## POC scope

WebGL 2 is required. The demo supports desktop keyboard input and phone touch
controls. Browser coverage targets Chromium and an iPhone sized WebKit context.
Mobile emulation is not physical iPhone certification; other browsers, visual
quality and gameplay feel are not comprehensively qualified.

The production scenarios cover original asset loading, drawing, native controls,
pause, settings and cleanup. Later course scenarios seed progress to select the
course; they do not prove earned medal progression. Extended automated medal
coverage and experimental controller research remain separate from POC delivery.

The application uses React, TypeScript, Three.js and Rapier. Original asset
sources and reproduction instructions are in [`ASSET-LICENSE.md`](ASSET-LICENSE.md).
The current engineering checkpoint is in the
[project handoff](docs/handoffs/2026-09-04-reef-rush.md).

## Licenses

Code is [MIT licensed](LICENSE). Original artwork and other original game assets
are [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), with attribution
and source details in [`ASSET-LICENSE.md`](ASSET-LICENSE.md). Dependencies retain
their own licenses.
