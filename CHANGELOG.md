# Changelog

All notable changes to the FLang VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.6] - 2026-09-01

### Fixed

- Expressions in a variant construction highlight as expressions: `Some(move v)` no longer renders as one flat type token, so `move`, calls and property access inside a payload keep their own scopes
- A generic type keeps its closing paren and `[]?` suffix in the type span where a type is expected (`: Slice(u8)`, `as Slice(u8)`, return types), while the same shape in expression position is parsed as a call

## [0.3.5] - 2026-09-01

### Added

- Syntax highlighting for interpolated strings (`$"..."`, `$(cap, &alloc)"..."`, `$sb"..."`): holes highlight as code, `{{`/`}}` as escapes, format specs verbatim
- Syntax highlighting for the `move` keyword and the `owned` struct-field modifier
- `npm test` runs TextMate grammar assertions against the real tokenizer

### Fixed

- An interpolation hole containing a quote (a nested string, or a char literal such as `'"'`) no longer ends the string early and paints the rest of the file as string
- A generic type argument list no longer swallows following string literals, which previously left everything after `Err(CtError { code = "..." })` highlighted as string
- `\uXXXX` recognized as a string escape
- `..=`, `<<`, `>>` and `>>>` highlight as single operators instead of being split

## [0.3.2] - 2026-08-28

### Changed

- `flang.serverFlavor` defaults to `auto`: the flavor is detected from the binary's `--version` banner, so only `flang.serverPath` needs changing to switch servers
- Status bar item moved to the right side, next to the notification bell
- Status bar click now lists the workspace's open projects with error counts; picking one opens its `flang.toml`

## [0.3.0] - 2026-08-28

### Added

- `flang.serverFlavor` setting to switch between the reference server (`flang --lsp --stdlib-path <p>`) and the self-hosted server (`flang lsp -s <p>`)
- Status bar item showing compiler version and per-project error counts, fed by the self-hosted server's `flang/serverStatus` notification
- `FLang: Show Language Server Status` command (also on status bar click): version, workspace folders, open projects
- File watcher now covers `flang.toml`, so manifest edits rebuild the affected project server-side

## [0.1.0] - 2026-02-19

### Added

- Syntax highlighting for FLang (`.f` files) via TextMate grammar
  - Keywords, control flow, types, operators, literals, struct/enum definitions, imports, directives, test blocks
- Language Server Protocol (LSP) client connecting to the FLang compiler's built-in LSP server
  - Hover, Go to Definition, Go to Type Definition, Document Symbols, Inlay Hints, Signature Help, Diagnostics
- **Auto mode** (default): automatically downloads and manages the FLang compiler from GitHub releases
  - Background update checks with user prompt
  - Platform support for Windows x64 and Linux x64
- **Manual mode**: use a local compiler build or PATH-based lookup
  - Binary copy-to-temp to prevent file locking during compiler rebuilds
- Commands:
  - `FLang: Restart Language Server` -- restart the LSP without reloading VS Code
  - `FLang: Check for Compiler Updates` -- manually check for new compiler releases
  - `FLang: Show Compiler Version` -- display installed version or configured path
- Configuration settings: `flang.mode`, `flang.serverPath`, `flang.stdlibPath`, `flang.autoUpdate`
- Language configuration: bracket matching, auto-closing pairs, comment toggling
- esbuild-based bundling for fast builds and small extension size
