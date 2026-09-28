# ink2miao

Incremental, one-way migration of an [Inkdrop](https://www.inkdrop.app/) account into a
[MiaoYan](https://github.com/tw93/MiaoYan) library (plain Markdown folders, iCloud-synced).

- Reads everything through Inkdrop's local HTTP server (`/_changes`), including completed,
  dropped and trashed notes that `GET /notes` silently omits.
- Rewrites only URLs: `inkdrop://note/…` → `[[Title]]` or `[text](miaoyan://goto/…)`,
  `inkdrop://file:…` → `/i/<name>`. Code blocks, Mermaid and math are never touched.
- Keeps Inkdrop metadata (id, notebook, tags, status, pin, dates) under one `inkdrop:` key in
  YAML front matter, preserving any existing front matter byte-for-byte.
- Sets file birth/modification times and MiaoYan's pin flag (`com.tw93.miaoyan.pin`).
- Writes to a staging directory first; `verify` checks links, attachments (md5) and naming.

## Requirements

- macOS, [Bun](https://bun.sh) 1.4.2 (see `.bun-version`)
- Inkdrop with **Preferences → Local Server** enabled

## Usage

```fish
bun install
bun run build                 # → dist/ink2miao

./dist/ink2miao doctor        # checks Inkdrop, permissions, dates/pins, folder limits
./dist/ink2miao sync --dry-run
./dist/ink2miao sync          # fetch + render into the staging directory
./dist/ink2miao verify        # exit 5 on any integrity error
./dist/ink2miao report        # unresolved links, renamed titles, failures (--format json)
```

Global flags: `--json` (NDJSON on stdout), `-q`, `-v`, `--no-color`, `--config <file>`,
`--profile <name>`.

| Exit code | Meaning |
|---|---|
| 0 | ok |
| 1 | internal error / partial failure |
| 2 | usage or configuration error |
| 3 | Inkdrop unreachable or credentials rejected |
| 5 | verify found errors |
| 130 | interrupted |

## Configuration

Precedence: flags > environment > `$XDG_CONFIG_HOME/ink2miao/config.toml` > defaults.

| TOML key | Env | Default |
|---|---|---|
| `profile` | `INK2MIAO_PROFILE` | `default` |
| `staging` | `INK2MIAO_STAGING` | `$XDG_DATA_HOME/ink2miao/<profile>/staging` |
| `target` | `INK2MIAO_TARGET` | `~/Library/Mobile Documents/iCloud~com~tw93~miaoyan/Documents` |
| `link_mode` | `INK2MIAO_LINK_MODE` | `auto` (`wikilink`, `goto`) |
| `include_trash` | `INK2MIAO_INCLUDE_TRASH` | `true` |
| `deleted_folder` | `INK2MIAO_DELETED_FOLDER` | `_Inkdrop Deleted` |
| `trash_replacement` | `INK2MIAO_TRASH_REPLACEMENT` | `Bin` |
| `concurrency` | `INK2MIAO_CONCURRENCY` | `4` |
| `inkdrop_config` | `INK2MIAO_INKDROP_CONFIG` | `~/Library/Application Support/inkdrop/config.json` |

Credentials come from Inkdrop's own `config.json`, or from `INKDROP_LOCAL_SERVER_URL`,
`INKDROP_LOCAL_USERNAME` and `INKDROP_LOCAL_PASSWORD` (same variables as
`@inkdropapp/mcp-server`). They are never copied or printed.

MiaoYan hides folders whose path contains "Trash", so neither the deleted-notes folder nor
renamed notebooks may contain that word.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).
