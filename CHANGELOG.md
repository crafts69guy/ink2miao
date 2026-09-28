# Changelog

All notable changes are listed here, grouped by milestone. Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## 0.1.0 — 2026-09-28

### M4 — browsing and offline source (`b06be04`)

- `pick` (fzf with live preview, clack prompt fallback), `show` (glow, chafa), `diff`
  (delta or unified patch; next sync / library / original Inkdrop body).
- `completion fish` generated from the command tree; hidden `titles` helper.
- `sync --renormalize`; TTY progress bar.
- `source = "backup"`: read Inkdrop's JSON backup offline; docs missing from a full listing
  are tombstoned so switching sources stays correct.

### M3 — promote (`fff40fc`)

- `promote` mirrors staging into the MiaoYan library with per-target state: real renames,
  retired notes moved to the deleted folder, user notes untouched.
- Edits/deletions made in MiaoYan are conflicts (exit 4) unless `--force` (with backup);
  refuses while MiaoYan runs (exit 6) unless `--wait`/`--force`; `--watch`.
- `verify --target` checks the live library, including dates and pins.

### M2 — incremental sync (`b9bfa74`)

- Pure planner (create, update, two-phase move, restore, adopt, retire, conflict) and an
  executor that commits state per action; notes linking to renamed notes are rewritten.
- Conflicts for files edited in staging, `--force` backups, `--rebuild`, `--deletions`,
  run lock, `status` (`--remote`, `--exit-code`).

### M1 — export (`e24429b`, `85c36f0`)

- `doctor`, `sync`, `verify`, `report`; `/_changes` mirror in SQLite; position-based link
  rewriting; front matter merge that keeps user YAML byte-identical; md5-checked
  attachments; birth/mod times and MiaoYan pins via `bun:ffi`.
- Toolchain: pinned stable versions, Biome, strict TypeScript, per-file ≥ 98% coverage gate,
  commitlint (no co-author trailers) and lefthook hooks.
