# Contributing

## Toolchain

- Versions are pinned exactly (no `^`/`~`), stable releases only; `bun.lock` is committed.
- Bun has no LTS channel: we pin the latest stable (`.bun-version`, `packageManager`) and only
  move to a new minor after `bun run ci` passes. Node LTS (`.nvmrc`) is for tooling only.
- Upgrade dependencies in a dedicated `build(deps): …` commit.

```fish
bun install --frozen-lockfile   # also installs the lefthook git hooks
bun run ci                      # check → typecheck → test:cov → build
```

| Script | What it does |
|---|---|
| `fmt` / `lint` / `check` / `check:fix` | Biome format, lint, both (read-only), both (write) |
| `typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| `test` / `test:cov` | `bun test`; coverage fails below 98% lines/functions **per file** |
| `build` | single binary at `dist/ink2miao` |

`UPDATE_GOLDEN=1 bun test test/unit/golden.test.ts` regenerates transform golden files; review
the diff before committing.

## Rules

- No `any` (Biome `noExplicitAny` is an error); validate external data with zod.
- Pure core (`naming/`, `transform/`, `plan/`, `verify/`), side effects behind injected `Deps`.
- Coverage exclusions are not allowed for `src/`; make code testable instead.

## Commit convention

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint on
`commit-msg`:

```
<type>(<scope>): <subject>
```

- **type**: `feat` `fix` `perf` `refactor` `test` `docs` `build` `ci` `chore` `revert`
- **scope** (required): `cli` `config` `source` `domain` `naming` `transform` `plan` `apply`
  `promote` `state` `verify` `report` `platform` `deps` `release`
- subject: lower case, imperative, no trailing period, header ≤ 72 chars; body lines ≤ 100
- breaking changes: `feat(cli)!: …` or a `BREAKING CHANGE:` footer
- **no `Co-authored-by` trailers** (rejected in any letter case)

| ✅ Accepted | ❌ Rejected |
|---|---|
| `feat(transform): rewrite inkdrop file links` | `update stuff` (no type/scope) |
| `fix(naming): keep nfc titles stable` | `feat: add doctor` (missing scope) |
| `build(deps): upgrade zod to 4.6.5` | `Fix(cli): Add Doctor.` (case, period) |
| | any message with `Co-authored-by: …` |

Hooks (`lefthook.yml`): `pre-commit` runs Biome on staged files and `tsc`; `commit-msg` runs
commitlint; `pre-push` runs `test:cov`.
