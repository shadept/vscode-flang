import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import * as vscode from "vscode";
import type {
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let tempDir: string | undefined;
const outputChannel = vscode.window.createOutputChannel("FLang LSP");

// ---------------------------------------------------------------------------
// Status bar - fed by the server's flang/serverStatus notification
// ---------------------------------------------------------------------------

interface ServerStatusProject {
  name: string;
  dir: string;
  errors: number;
}

interface ServerStatus {
  version: string;
  folders: string[];
  projects: ServerStatusProject[];
}

let statusBar: vscode.StatusBarItem | undefined;
let lastStatus: ServerStatus | undefined;
// Resolved from the binary at launch ("auto" never survives detection).
let activeFlavor: ResolvedFlavor = "reference";

function updateStatusBar() {
  if (!statusBar) return;

  if (!lastStatus) {
    statusBar.text = "$(zap) FLang";
    statusBar.tooltip = `FLang language server (${activeFlavor})`;
    return;
  }

  const errors = lastStatus.projects.reduce((n, p) => n + p.errors, 0);
  const icon = errors > 0 ? "$(error)" : "$(check)";
  statusBar.text = `${icon} FLang ${lastStatus.version}`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**FLang** ${lastStatus.version} (${activeFlavor})\n\n`);
  if (lastStatus.folders.length > 0) {
    md.appendMarkdown(`Workspace: ${lastStatus.folders.join(", ")}\n\n`);
  }
  if (lastStatus.projects.length > 0) {
    md.appendMarkdown("| Project | Errors |\n|---|---:|\n");
    for (const p of lastStatus.projects) {
      md.appendMarkdown(`| ${p.name} | ${p.errors} |\n`);
    }
  } else {
    md.appendMarkdown("No projects analyzed yet - open a `.f` file.");
  }
  statusBar.tooltip = md;
}

function hookServerStatus(c: LanguageClient) {
  c.onNotification("flang/serverStatus", (status: ServerStatus) => {
    lastStatus = status;
    updateStatusBar();
  });
}

// Status-bar click: compiler version and the workspace's open projects. Picking a project opens
// its flang.toml.
async function showServerStatus() {
  interface StatusPick extends vscode.QuickPickItem {
    projectDir?: string;
  }
  const items: StatusPick[] = [
    {
      label: `$(zap) Compiler ${lastStatus?.version ?? "unknown"}`,
      description: `${activeFlavor} server`,
      detail: lastStatus?.folders.length
        ? `Workspace: ${lastStatus.folders.join(", ")}`
        : undefined,
    },
  ];
  for (const p of lastStatus?.projects ?? []) {
    items.push({
      label: `$(package) ${p.name}`,
      description: p.errors > 0 ? `$(error) ${p.errors} error(s)` : "$(check) no errors",
      detail: p.dir,
      projectDir: p.dir,
    });
  }
  if (lastStatus && lastStatus.projects.length === 0) {
    items.push({
      label: "$(info) No projects analyzed yet",
      detail: "Open a .f file under a flang.toml to analyze its project.",
    });
  }
  if (!lastStatus) {
    items.push({
      label: "$(info) No status received from the server",
      detail:
        activeFlavor === "reference"
          ? "The reference server does not report status; it arrives with the self-hosted server."
          : "The server has not sent flang/serverStatus yet - check the FLang LSP output channel.",
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "FLang language server",
  });
  if (picked?.projectDir) {
    const manifest = vscode.Uri.file(path.join(picked.projectDir, "flang.toml"));
    await vscode.window.showTextDocument(manifest);
  }
}

function log(msg: string) {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

type Mode = "auto" | "manual";
type ServerFlavor = "auto" | "reference" | "self-hosted";
type ResolvedFlavor = Exclude<ServerFlavor, "auto">;

function getConfig() {
  const config = vscode.workspace.getConfiguration("flang");
  return {
    mode: config.get<Mode>("mode", "auto"),
    serverFlavor: config.get<ServerFlavor>("serverFlavor", "auto"),
    serverPath: config.get<string>("serverPath", ""),
    stdlibPath: config.get<string>("stdlibPath", ""),
    autoUpdate: config.get<boolean>("autoUpdate", true),
  };
}

// Which server the binary is: ask it. Both compilers name themselves in --version
// ("reference compiler, C#" vs "self-hosted compiler, FLang"). An explicit flang.serverFlavor
// overrides; a failed probe falls back to reference (the historical default).
async function detectFlavor(command: string): Promise<ResolvedFlavor> {
  const configured = getConfig().serverFlavor;
  if (configured !== "auto") {
    return configured;
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)(command, ["--version"], {
      timeout: 10_000,
    });
    const banner = `${out.stdout}\n${out.stderr}`;
    log(`--version probe: ${out.stdout.trim()}`);
    if (/self-hosted/i.test(banner)) {
      return "self-hosted";
    }
  } catch (e: unknown) {
    log(`--version probe failed (${e}); assuming reference server`);
  }
  return "reference";
}

// ---------------------------------------------------------------------------
// Version tracking (persisted in globalStorage)
// ---------------------------------------------------------------------------

interface InstalledVersion {
  version: string;
  installedAt: string;
}

function getVersionFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "version.json");
}

function readInstalledVersion(
  context: vscode.ExtensionContext
): InstalledVersion | undefined {
  const versionFile = getVersionFilePath(context);
  if (!fs.existsSync(versionFile)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(versionFile, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeInstalledVersion(
  context: vscode.ExtensionContext,
  version: string
) {
  const versionFile = getVersionFilePath(context);
  const data: InstalledVersion = {
    version,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(versionFile, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// GitHub release helpers
// ---------------------------------------------------------------------------

const GITHUB_API_LATEST =
  "https://api.github.com/repos/shadept/flang/releases/latest";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

function httpsGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const get = (reqUrl: string, redirectCount: number) => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }
      https
        .get(reqUrl, { headers: { "User-Agent": "vscode-flang" } }, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            get(res.headers.location, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} from ${reqUrl}`));
            res.resume();
            return;
          }
          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on("error", reject);
    };
    get(url, 0);
  });
}

function httpsDownload(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const download = (reqUrl: string, redirectCount: number) => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }
      https
        .get(reqUrl, { headers: { "User-Agent": "vscode-flang" } }, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            download(res.headers.location, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} downloading ${reqUrl}`));
            res.resume();
            return;
          }
          const fileStream = fs.createWriteStream(destPath);
          pipeline(res, fileStream).then(resolve).catch(reject);
        })
        .on("error", reject);
    };
    download(url, 0);
  });
}

function getPlatformAssetSuffix(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return undefined;
}

// ---------------------------------------------------------------------------
// Compiler download / update (auto mode)
// ---------------------------------------------------------------------------

function getCompilerDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "compiler");
}

function getCompilerBinaryPath(context: vscode.ExtensionContext): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(getCompilerDir(context), `flang${ext}`);
}

function getCompilerStdlibPath(context: vscode.ExtensionContext): string {
  return path.join(getCompilerDir(context), "stdlib");
}

function isCompilerInstalled(context: vscode.ExtensionContext): boolean {
  return fs.existsSync(getCompilerBinaryPath(context));
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  return httpsGetJson<GitHubRelease>(GITHUB_API_LATEST);
}

async function downloadAndInstallCompiler(
  context: vscode.ExtensionContext,
  release: GitHubRelease,
  token?: vscode.CancellationToken
): Promise<void> {
  const suffix = getPlatformAssetSuffix();
  if (!suffix) {
    throw new Error(
      `Unsupported platform: ${process.platform}-${process.arch}. ` +
        `Use manual mode and provide a compiler binary via flang.serverPath.`
    );
  }

  const asset = release.assets.find((a) => a.name.includes(suffix));
  if (!asset) {
    throw new Error(
      `No release asset found for ${suffix} in release ${release.tag_name}. ` +
        `Available assets: ${release.assets.map((a) => a.name).join(", ")}`
    );
  }

  const globalDir = context.globalStorageUri.fsPath;
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }

  const zipPath = path.join(globalDir, asset.name);

  log(`Downloading ${asset.name} from ${asset.browser_download_url}`);
  await httpsDownload(asset.browser_download_url, zipPath);

  if (token?.isCancellationRequested) {
    fs.rmSync(zipPath, { force: true });
    return;
  }

  log(`Extracting ${zipPath} to ${getCompilerDir(context)}`);

  const compilerDir = getCompilerDir(context);
  if (fs.existsSync(compilerDir)) {
    fs.rmSync(compilerDir, { recursive: true, force: true });
  }
  fs.mkdirSync(compilerDir, { recursive: true });

  // Use Node.js built-in to extract zip
  const { execFileSync } = await import("node:child_process");
  if (process.platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${compilerDir}' -Force`,
    ]);
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", compilerDir]);
  }

  // Some zips have a nested directory. If compiler dir only has one subfolder,
  // move its contents up.
  const entries = fs.readdirSync(compilerDir);
  if (
    entries.length === 1 &&
    fs.statSync(path.join(compilerDir, entries[0])).isDirectory()
  ) {
    const nestedDir = path.join(compilerDir, entries[0]);
    for (const entry of fs.readdirSync(nestedDir)) {
      fs.renameSync(
        path.join(nestedDir, entry),
        path.join(compilerDir, entry)
      );
    }
    fs.rmSync(nestedDir, { recursive: true, force: true });
  }

  // Make binary executable on non-Windows
  const binaryPath = getCompilerBinaryPath(context);
  if (process.platform !== "win32" && fs.existsSync(binaryPath)) {
    fs.chmodSync(binaryPath, 0o755);
  }

  fs.rmSync(zipPath, { force: true });
  writeInstalledVersion(context, release.tag_name);
  log(`Installed compiler ${release.tag_name}`);
}

async function ensureCompiler(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const installed = isCompilerInstalled(context);

  if (!installed) {
    // Must download
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "FLang: Downloading compiler...",
        cancellable: true,
      },
      async (progress, token) => {
        try {
          progress.report({ message: "Fetching latest release info..." });
          const release = await fetchLatestRelease();
          progress.report({
            message: `Downloading ${release.tag_name}...`,
          });
          await downloadAndInstallCompiler(context, release, token);
          if (token.isCancellationRequested) {
            return false;
          }
          vscode.window.showInformationMessage(
            `FLang compiler ${release.tag_name} installed.`
          );
          return true;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`Failed to download compiler: ${msg}`);
          vscode.window.showErrorMessage(
            `FLang: Failed to download compiler: ${msg}`
          );
          return false;
        }
      }
    );
  }

  // Already installed -- check for updates in the background
  checkForUpdatesBackground(context);

  return true;
}

function checkForUpdatesBackground(context: vscode.ExtensionContext) {
  fetchLatestRelease()
    .then(async (release) => {
      const current = readInstalledVersion(context);
      if (current && current.version === release.tag_name) {
        log(`Compiler is up to date: ${current.version}`);
        return;
      }

      const action = await vscode.window.showInformationMessage(
        `FLang: A new compiler version is available (${release.tag_name}). Update now?`,
        "Update",
        "Later"
      );

      if (action === "Update") {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `FLang: Updating compiler to ${release.tag_name}...`,
            cancellable: true,
          },
          async (progress, token) => {
            try {
              await downloadAndInstallCompiler(context, release, token);
              if (!token.isCancellationRequested) {
                vscode.window.showInformationMessage(
                  `FLang compiler updated to ${release.tag_name}. Restart the language server to use the new version.`
                );
              }
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              log(`Failed to update compiler: ${msg}`);
              vscode.window.showErrorMessage(
                `FLang: Failed to update compiler: ${msg}`
              );
            }
          }
        );
      }
    })
    .catch((e) => {
      log(`Failed to check for updates: ${e}`);
    });
}

// ---------------------------------------------------------------------------
// Manual mode: copy-to-temp to avoid file locking
// ---------------------------------------------------------------------------

function copyToTemp(serverPath: string): string {
  const resolvedPath = path.resolve(serverPath);

  if (!fs.existsSync(resolvedPath)) {
    log(`Server binary not found at: ${resolvedPath}, using command as-is`);
    return serverPath;
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flang-lsp-"));
  const ext = process.platform === "win32" ? ".exe" : "";
  const tempBinary = path.join(tempDir, `flang${ext}`);

  log(`Copying ${resolvedPath} -> ${tempBinary}`);
  fs.copyFileSync(resolvedPath, tempBinary);

  if (process.platform !== "win32") {
    fs.chmodSync(tempBinary, 0o755);
  }

  return tempBinary;
}

function cleanupTemp() {
  if (tempDir && fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      log(`Cleaned up temp dir: ${tempDir}`);
    } catch {
      // Best effort
    }
    tempDir = undefined;
  }
}

// ---------------------------------------------------------------------------
// Environment / PATH helpers
// ---------------------------------------------------------------------------

function setupTerminalEnvironment(context: vscode.ExtensionContext) {
  const compilerDir = getCompilerDir(context);
  if (!fs.existsSync(compilerDir)) return;

  const env = context.environmentVariableCollection;
  env.prepend("PATH", compilerDir + path.delimiter);
  log(`Added ${compilerDir} to VS Code terminal PATH`);
}

async function addToSystemPath(
  context: vscode.ExtensionContext
): Promise<void> {
  const compilerDir = getCompilerDir(context);
  if (!fs.existsSync(getCompilerBinaryPath(context))) {
    vscode.window.showErrorMessage(
      "FLang: Compiler is not installed yet. Please wait for the download to complete."
    );
    return;
  }

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  if (process.platform === "win32") {
    try {
      // Read current user PATH
      const { stdout: currentPath } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[Environment]::GetEnvironmentVariable("Path", "User")`,
      ]);

      const paths = currentPath.trim().split(";").filter(Boolean);
      if (paths.some((p) => p.toLowerCase() === compilerDir.toLowerCase())) {
        vscode.window.showInformationMessage(
          "FLang: Compiler directory is already on your PATH."
        );
        return;
      }

      // Append compiler dir to user PATH
      const newPath = [...paths, compilerDir].join(";");
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[Environment]::SetEnvironmentVariable("Path", "${newPath}", "User")`,
      ]);

      vscode.window.showInformationMessage(
        `FLang: Added compiler to user PATH. Restart any open terminals to pick up the change.\n${compilerDir}`
      );
      log(`Added ${compilerDir} to user PATH (Windows)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Failed to modify PATH: ${msg}`);
      vscode.window.showErrorMessage(`FLang: Failed to modify PATH: ${msg}`);
    }
  } else {
    // Linux / macOS: symlink into /usr/local/bin
    const linkPath = "/usr/local/bin/flang";
    const binaryPath = getCompilerBinaryPath(context);

    try {
      if (fs.existsSync(linkPath)) {
        const target = fs.readlinkSync(linkPath);
        if (target === binaryPath) {
          vscode.window.showInformationMessage(
            "FLang: Compiler symlink already exists at /usr/local/bin/flang."
          );
          return;
        }
      }

      // May require sudo – try without first
      await execFileAsync("ln", ["-sf", binaryPath, linkPath]);
      vscode.window.showInformationMessage(
        "FLang: Created symlink at /usr/local/bin/flang."
      );
      log(`Created symlink ${linkPath} -> ${binaryPath}`);
    } catch {
      // Likely a permission error – inform user
      vscode.window.showWarningMessage(
        `FLang: Could not create symlink. Run: sudo ln -sf "${binaryPath}" ${linkPath}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// LSP client
// ---------------------------------------------------------------------------

function resolveServerPath(context: vscode.ExtensionContext): {
  command: string;
  stdlibPath: string;
} {
  const cfg = getConfig();

  if (cfg.mode === "auto") {
    const command = getCompilerBinaryPath(context);
    const stdlibPath = path.resolve(
      cfg.stdlibPath || getCompilerStdlibPath(context)
    );
    return { command, stdlibPath };
  }

  // Manual mode. The stdlib must be passed explicitly and absolute: the server
  // runs from a temp copy of the binary, so its own "stdlib next to the exe"
  // default points at the temp dir. Fall back to the stdlib next to the
  // ORIGINAL binary when the setting is empty.
  const serverPath = cfg.serverPath || "flang";
  const command = copyToTemp(serverPath);
  let stdlibPath = cfg.stdlibPath ? path.resolve(cfg.stdlibPath) : "";
  if (!stdlibPath && cfg.serverPath) {
    const candidate = path.join(path.dirname(path.resolve(cfg.serverPath)), "stdlib");
    if (fs.existsSync(candidate)) {
      stdlibPath = candidate;
    }
  }
  return { command, stdlibPath };
}

async function createClient(
  context: vscode.ExtensionContext
): Promise<LanguageClient> {
  cleanupTemp();

  const { command, stdlibPath } = resolveServerPath(context);
  const flavor = await detectFlavor(command);
  activeFlavor = flavor;
  updateStatusBar();
  log(`Using server binary: ${command} (${flavor})`);

  // The reference compiler (flang-ref) speaks `--lsp --stdlib-path <p>`; the
  // self-hosted compiler speaks `lsp -s <p>` and defaults the stdlib to the
  // directory next to its own binary.
  const args = flavor === "self-hosted" ? ["lsp"] : ["--lsp"];
  if (stdlibPath) {
    args.push(flavor === "self-hosted" ? "-s" : "--stdlib-path", stdlibPath);
  }

  const serverOptions: ServerOptions = {
    run: {
      command,
      args,
      transport: TransportKind.stdio,
    },
    debug: {
      command,
      args,
      transport: TransportKind.stdio,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "flang" }],
    synchronize: {
      // flang.toml edits change a project's module set; the server rebuilds it.
      fileEvents: vscode.workspace.createFileSystemWatcher("**/{*.f,flang.toml}"),
    },
    outputChannel,
  };

  return new LanguageClient(
    "flangLanguageServer",
    "FLang Language Server",
    serverOptions,
    clientOptions
  );
}

// ---------------------------------------------------------------------------
// First-time setup prompt
// ---------------------------------------------------------------------------

function isModeExplicitlySet(): boolean {
  const config = vscode.workspace.getConfiguration("flang");
  const inspection = config.inspect<Mode>("mode");
  if (!inspection) return false;
  return (
    inspection.globalValue !== undefined ||
    inspection.workspaceValue !== undefined ||
    inspection.workspaceFolderValue !== undefined
  );
}

async function promptForMode(): Promise<Mode | undefined> {
  const choice = await vscode.window.showInformationMessage(
    "FLang: Would you like to automatically download the compiler?",
    "Yes (auto)",
    "No (manual)"
  );

  if (choice === "Yes (auto)") {
    await vscode.workspace
      .getConfiguration("flang")
      .update("mode", "auto", vscode.ConfigurationTarget.Global);
    return "auto";
  }

  if (choice === "No (manual)") {
    await vscode.workspace
      .getConfiguration("flang")
      .update("mode", "manual", vscode.ConfigurationTarget.Global);
    return "manual";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext) {
  let mode: Mode;

  if (!isModeExplicitlySet()) {
    const chosen = await promptForMode();
    if (!chosen) {
      log("No compiler mode selected. Language server will not start.");
      return;
    }
    mode = chosen;
  } else {
    mode = getConfig().mode;
  }

  if (mode === "auto") {
    const ok = await ensureCompiler(context);
    if (!ok) {
      log(
        "Compiler not available. Language server will not start. " +
          "Install manually or check your network connection."
      );
      return;
    }
    setupTerminalEnvironment(context);
  }

  // Right-aligned with negative priority: sits at the far right of the status
  // bar, next to the notification bell, like other language extensions.
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    -1
  );
  statusBar.command = "flang.showServerStatus";
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  client = await createClient(context);
  hookServerStatus(client);
  log("Starting FLang LSP client...");
  await client.start();

  // -- Commands -----------------------------------------------------------

  const restartCmd = vscode.commands.registerCommand(
    "flang.restartServer",
    async () => {
      log("Restarting FLang LSP server...");
      if (client) {
        await client.stop();
      }
      if (getConfig().mode === "auto") {
        await ensureCompiler(context);
      }
      lastStatus = undefined;
      updateStatusBar();
      client = await createClient(context);
      hookServerStatus(client);
      await client.start();
      log("FLang LSP server restarted.");
    }
  );

  const statusCmd = vscode.commands.registerCommand(
    "flang.showServerStatus",
    showServerStatus
  );

  const updateCmd = vscode.commands.registerCommand(
    "flang.updateCompiler",
    async () => {
      const currentCfg = getConfig();
      if (currentCfg.mode !== "auto") {
        vscode.window.showWarningMessage(
          "FLang: Compiler updates are only available in auto mode. " +
            "Change flang.mode to 'auto' to use this feature."
        );
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "FLang: Checking for updates...",
          cancellable: true,
        },
        async (progress, token) => {
          try {
            const release = await fetchLatestRelease();
            const current = readInstalledVersion(context);

            if (current && current.version === release.tag_name) {
              vscode.window.showInformationMessage(
                `FLang: Compiler is already up to date (${current.version}).`
              );
              return;
            }

            progress.report({
              message: `Downloading ${release.tag_name}...`,
            });
            await downloadAndInstallCompiler(context, release, token);

            if (!token.isCancellationRequested) {
              const action = await vscode.window.showInformationMessage(
                `FLang compiler updated to ${release.tag_name}. Restart language server?`,
                "Restart",
                "Later"
              );
              if (action === "Restart") {
                await vscode.commands.executeCommand("flang.restartServer");
              }
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(
              `FLang: Update failed: ${msg}`
            );
          }
        }
      );
    }
  );

  const versionCmd = vscode.commands.registerCommand(
    "flang.showCompilerVersion",
    () => {
      const currentCfg = getConfig();
      if (currentCfg.mode === "auto") {
        const installed = readInstalledVersion(context);
        if (installed) {
          vscode.window.showInformationMessage(
            `FLang compiler version: ${installed.version} (installed ${installed.installedAt})`
          );
        } else {
          vscode.window.showInformationMessage(
            "FLang: No compiler version installed yet."
          );
        }
      } else {
        const serverPath = currentCfg.serverPath || "flang (from PATH)";
        vscode.window.showInformationMessage(
          `FLang: Manual mode, using: ${serverPath}`
        );
      }
    }
  );

  const addToPathCmd = vscode.commands.registerCommand(
    "flang.addToPath",
    async () => {
      const currentCfg = getConfig();
      if (currentCfg.mode !== "auto") {
        vscode.window.showWarningMessage(
          "FLang: This command is only available in auto mode."
        );
        return;
      }
      await addToSystemPath(context);
    }
  );

  context.subscriptions.push(
    restartCmd,
    statusCmd,
    updateCmd,
    versionCmd,
    addToPathCmd
  );
  context.subscriptions.push({ dispose: cleanupTemp });

  // Template-expansion output lives only in the server's memory. Go-to-definition
  // into generated code yields a `flang-generated://<origin>.generated.f` URI;
  // this provider fetches its text so VS Code opens it as a read-only document.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("flang-generated", {
      provideTextDocumentContent: async (uri) => {
        if (!client) return "";
        const result = await client.sendRequest<{ content: string | null }>(
          "flang/generatedContent",
          { uri: uri.toString() }
        );
        return result.content ?? "// (generated content not available — reopen the origin file)";
      },
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
