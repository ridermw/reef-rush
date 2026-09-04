# Reef Rush

Read `docs\handoffs\2026-09-04-reef-rush.md` for the current checkpoint,
remaining plan, and acceptance gates. Update that handoff at milestone boundaries
instead of duplicating it in new planning files.

## Environment and commands

- Use the Node version in `.nvmrc` before running npm. Preserve the public
  registry configuration and lockfile. Do not bypass the engine requirement.
- Use the host shell. On Windows, use PowerShell and Windows filesystem paths;
  do not assume Bash or the macOS `nvm.sh` setup is available.
- Restore dependencies with `npm ci` when required by the resume procedure.
- Start with the relevant existing Vitest files via `npm run test -- <paths>`.
  Use `npm run typecheck` and `npm run lint` for the affected code as appropriate.
  Run `npm run validate` when the handoff or release gate requires it.
- Browser coverage uses `npm run test:browser`; a script entry does not prove
  that the required browser scenarios or browser installation already exist.

## Improvement loop

- Follow the handoff task order. Resolve the four Task 5 blocking findings before
  starting Task 6. Write and observe failing regressions before production fixes.
- Record a baseline, one hypothesis, an acceptance metric, the result, and a keep
  or discard decision in the handoff. Never inflate a score to pass a gate.
- Keep React shell state independent from the game frame loop.
- Use one independent Rubber Duck gate for ordinary changes before committing
  or pushing. Increase review depth only when risk or disagreement warrants it.
- Headless physics and browser evidence can establish behavior, not human
  judgments of graphics quality or gameplay feel. Label unobserved outcomes.
- Keep machine configuration, credentials, and local archives out of this
  public repository. Put only portable project decisions in the handoff.
