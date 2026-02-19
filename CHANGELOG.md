# Changelog

All notable changes to the FLang VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
