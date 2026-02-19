# FLang for Visual Studio Code

Syntax highlighting and language server support for [FLang](https://github.com/shadept/flangv2).

## Features

- **Syntax Highlighting** -- full TextMate grammar for all FLang constructs
- **Language Server** -- hover, go to definition, diagnostics, inlay hints, signature help, and more

## Getting Started

Install the extension and open a `.f` file. By default, the compiler is downloaded automatically.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `flang.mode` | `"auto"` \| `"manual"` | `"auto"` | `auto` downloads the compiler from GitHub releases. `manual` uses a user-provided binary. |
| `flang.serverPath` | `string` | `""` | Path to the `flang` executable (manual mode). If empty, looks for `flang` on PATH. |
| `flang.stdlibPath` | `string` | `""` | Path to the standard library directory. If empty, auto-detects next to the binary. |
| `flang.autoUpdate` | `boolean` | `true` | Check for compiler updates on startup (auto mode). |

## Commands

| Command | Description |
|---|---|
| `FLang: Restart Language Server` | Restart the LSP server. |
| `FLang: Check for Compiler Updates` | Check for a newer compiler release (auto mode). |
| `FLang: Show Compiler Version` | Show the current compiler version or path. |

## License

MIT
