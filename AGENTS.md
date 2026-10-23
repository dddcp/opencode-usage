# opencode-usage — agent notes

OpenCode v2 TUI sidebar plugin: shows remaining quota of the active coding-plan
provider (GLM, Kimi, DeepSeek, MiniMax). **npm package name is
`opencode-coding-quota`** (repo name `opencode-usage` was taken on npm).

## Layout

- `src/tui.tsx` — plugin entry (`Plugin.define`, sidebar slot, panel component). OpenCode loads this **source file directly** via a symlink created by `scripts/install.mjs` (`npm run setup`); hot-reloads on edit, no build needed.
- `src/types.ts` — `UsageData` / `UsageRow` data contract between adapters and panel; adapters only produce a `UsageData`.
- `src/providers/<provider>.ts` — one adapter per provider. Each exports:
  - a pure `parse*()` function (unit-testable, takes the JSON payload),
  - a `query*Usage(apiKey, baseURL, title)` function (fetch + error mapping → `AuthError` for bad key, `Error` otherwise).
  - Header comments document the live payload shape with the date it was verified — keep this updated when endpoints change.
- `src/providers/resolve.ts` — classifies the active provider (baseURL host first, provider-id heuristic fallback), resolves the API key (`settings.apiKey` → `~/.local/share/opencode/auth.json` → env vars), routes to the adapter.
- `test/run.mjs` — plain-node unit tests on mock payloads (no framework); `--live` also reads `~/.config/opencode/opencode.json` and calls real APIs.
- `test/verify-resolve.mjs` — end-to-end `resolveUsage()` against the local opencode config (real network calls).

## Commands

```bash
npm run typecheck        # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm test                 # unit tests on mock payloads
npm run build            # tsdown → dist/tui.js (for the npm package only)
node test/verify-resolve.mjs   # live e2e — uses real keys from local opencode config
```

## Conventions

- antfu-style TypeScript: single quotes, no semicolons, 2-space indent, comma-first arrays.
- Relative imports use explicit `.ts` extensions (`./providers/glm.ts`) — tests run the TS sources directly via node type-stripping; tsconfig has `allowImportingTsExtensions`.
- Parse functions tolerate multiple historical response shapes (see Kimi's three shapes); prefer the field that carries absolute numbers, fall back to ratio-only.
- The panel renders `percent != null` rows as bars, `text != null` rows as plain values; `warn: true` colors a row as danger.

## Gotchas

- `dist/` is in `.gitignore` but `dist/tui.js` **is git-tracked** (force-added once). After changing `src/`, run `npm run build` and `git add -f dist/tui.js`.
- tsdown must never bundle `@opencode/*`, `@opentui/*`, `solid-js` (peer deps, `neverBundle` in `tsdown.config.ts`) — duplicate Solid instances break reactivity.
- `tui.tsx` runs in both the TUI (has `context.ui`) and the server process (no `context.ui`) — setup must return early when `context.ui` is absent.
- Provider adapters hit business APIs that can return errors with HTTP 200 (GLM `code`/`success`, MiniMax `base_resp.status_code`) — check body fields, not just `resp.ok`.
- Windows CJK: panel width math uses `visualWidth()` (CJK = 2 columns), not `String.length`.

## Release

1. `npm version patch|minor|major` (updates package.json + lockfile), commit `chore: release vX.Y.Z`.
2. Create a **lightweight** tag `vX.Y.Z` and push it — `.github/workflows/publish.yml` publishes to npm via trusted publishing (OIDC) **only on `v*` tag push or manual dispatch**; plain main pushes run no CI.
3. Project `.npmrc` pins `registry.npmjs.org` so publish never hits a mirror; local `npm view` can show stale cache — verify against the registry HTTP API if it matters.
