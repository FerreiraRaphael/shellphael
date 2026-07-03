import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeSessionTracker } from './claudeSession';

/** Comando cujo título de sessão sabemos ler (grava `ai-title` em ~/.claude). */
const CLAUDE_COMMAND = 'claude';

/** Comandos observados por padrão (runners comuns além do Claude). */
const DEFAULT_WATCHED = [
  'claude', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno',
  'uv', 'uvx', 'poetry', 'pdm', 'rye', 'pipenv', 'python', 'python3',
];

/** Molde padrão do nome. Segmentos vazios (ex.: sem package/porta) somem. */
const DEFAULT_TEMPLATE = '${command} ${label} · ${package} · ${port}';

/** Nome do package por diretório (cacheado; muda raramente numa sessão). */
const packageNameCache = new Map<string, string | undefined>();

/** Nome que queremos em cada terminal (aplicado quando ele fica ativo). */
const desiredNames = new Map<vscode.Terminal, string>();

/** Último nome já aplicado, pra evitar renomear à toa. */
const appliedNames = new Map<vscode.Terminal, string>();

/** Rastreadores de sessão do Claude por terminal. */
const trackers = new Map<vscode.Terminal, ClaudeSessionTracker>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'shellphael.closeEditorsKeepTerminals',
      closeEditorsKeepTerminals,
    ),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal) {
        void flush(terminal);
      }
    }),
    vscode.window.onDidCloseTerminal(cleanupTerminal),
  );

  // Renomeação automática depende de shell integration (VS Code/Cursor >= 1.93).
  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(handleShellExecution),
    );
  }
}

export function deactivate(): void {
  for (const tracker of trackers.values()) {
    tracker.dispose();
  }
  trackers.clear();
}

// ---------------------------------------------------------------------------
// Fechar editores mantendo os terminais
// ---------------------------------------------------------------------------

/**
 * Fecha todas as abas de editor (arquivos, diffs, previews, etc.) mas preserva
 * os terminais — que na área de editor aparecem como abas e seriam fechados
 * pelo "Fechar todos os editores" nativo.
 */
async function closeEditorsKeepTerminals(): Promise<void> {
  const tabsToClose = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => !(tab.input instanceof vscode.TabInputTerminal));

  if (tabsToClose.length > 0) {
    await vscode.window.tabGroups.close(tabsToClose);
  }
}

// ---------------------------------------------------------------------------
// Renomeação automática
// ---------------------------------------------------------------------------

async function handleShellExecution(
  event: vscode.TerminalShellExecutionStartEvent,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('shellphael');
  if (!config.get<boolean>('autoRename.enabled', true)) {
    return;
  }

  const terminal = event.terminal;
  const parsed = parseCommandLine(event.execution.commandLine.value);
  if (!parsed.command) {
    return;
  }

  const watched = config.get<string[]>('autoRename.watchedCommands', DEFAULT_WATCHED);
  if (!watched.includes(parsed.command)) {
    return;
  }

  // Nome provisório imediato (o título do Claude leva alguns segundos).
  const template = config.get<string>('autoRename.template', DEFAULT_TEMPLATE);
  setDesiredAuto(terminal, renderTemplate(template, parsed, terminal));

  // Se for o Claude, começa a acompanhar o título da sessão.
  if (parsed.command === CLAUDE_COMMAND && config.get<boolean>('claudeTitle.enabled', true)) {
    startClaudeTracking(terminal);
  }
}

function startClaudeTracking(terminal: vscode.Terminal): void {
  const cwd = terminalCwd(terminal);
  if (!cwd) {
    return; // sem cwd não dá pra achar o diretório da sessão
  }

  // Recomeça do zero (ex.: --resume abre outra sessão no mesmo terminal).
  trackers.get(terminal)?.dispose();

  const tracker = new ClaudeSessionTracker({
    cwd,
    onTitle: (title) => {
      const maxLength = vscode.workspace
        .getConfiguration('shellphael')
        .get<number>('claudeTitle.maxLength', 40);
      setDesiredAuto(terminal, formatTitle(title, maxLength));
    },
  });
  trackers.set(terminal, tracker);
}

// ---------------------------------------------------------------------------
// Aplicação do nome (só quando o terminal está ativo)
// ---------------------------------------------------------------------------

function setDesiredAuto(terminal: vscode.Terminal, name: string): void {
  if (desiredNames.get(terminal) === name) {
    return;
  }
  desiredNames.set(terminal, name);
  void flush(terminal);
}

/**
 * Aplica o nome desejado no terminal — mas só se ele for o ativo, porque o
 * comando de renomear atua sobre o terminal ativo. Se não for, fica pendente e
 * é aplicado quando o terminal ganhar foco (onDidChangeActiveTerminal).
 */
async function flush(terminal: vscode.Terminal): Promise<void> {
  if (terminal !== vscode.window.activeTerminal) {
    return;
  }
  const want = desiredNames.get(terminal);
  if (!want || appliedNames.get(terminal) === want) {
    return;
  }
  appliedNames.set(terminal, want);
  await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: want });
}

function cleanupTerminal(terminal: vscode.Terminal): void {
  trackers.get(terminal)?.dispose();
  trackers.delete(terminal);
  desiredNames.delete(terminal);
  appliedNames.delete(terminal);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedCommand {
  /** Binário principal, sem caminho nem extensão. Ex.: "claude", "node". */
  command: string | undefined;
  /** Token que dá sentido ao comando. Ex.: "dev", "pytest", "server.js". */
  label: string | undefined;
  /** Porta, quando explícita na linha de comando (best-effort). */
  port: string | undefined;
}

/** Runners cujo argumento significativo vem depois de um `run`/`exec`. */
const RUN_WRAPPERS = new Set(['uv', 'poetry', 'pdm', 'rye', 'pipenv']);
/** Runtimes que, quando aninhados (ex.: `uv run python foo.py`), pulamos. */
const RUNTIMES = new Set(['python', 'python3', 'node', 'deno', 'bun']);

/**
 * Quebra a linha de comando em (command, label, port). Ignora atribuições de
 * ambiente à frente (`PORT=3000 npm run dev` -> command "npm", label "dev").
 */
function parseCommandLine(commandLine: string): ParsedCommand {
  const raw = commandLine.trim().split(/\s+/).filter(Boolean);
  // Descarta VAR=valor iniciais (mas a porta ainda é lida da linha inteira).
  let i = 0;
  while (i < raw.length && /^\w+=/.test(raw[i])) {
    i++;
  }
  const tokens = raw.slice(i);
  if (tokens.length === 0) {
    return { command: undefined, label: undefined, port: undefined };
  }
  const command = normalizeBinary(tokens[0]);
  const label = deriveLabel(command, tokens.slice(1));
  return { command, label, port: derivePort(commandLine) };
}

function normalizeBinary(token: string): string {
  return path.basename(token).replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** Extrai o argumento que melhor identifica o que o comando faz. */
function deriveLabel(command: string, rest: string[]): string | undefined {
  // `python -m http.server` -> "http.server".
  if ((command === 'python' || command === 'python3')) {
    const m = rest.indexOf('-m');
    if (m >= 0 && rest[m + 1]) {
      return rest[m + 1];
    }
  }

  const args = rest.filter((t) => !t.startsWith('-'));

  // npm/pnpm/yarn/bun run <script> -> "<script>"; npm start -> "start".
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(command)) {
    const a = args[0] === 'run' ? args.slice(1) : args;
    return a[0];
  }

  // uv/poetry/... run <cmd>; pula runtime aninhado (uv run python foo -> foo).
  if (RUN_WRAPPERS.has(command)) {
    let a = args[0] === 'run' || args[0] === 'exec' ? args.slice(1) : args;
    if (a[0] && RUNTIMES.has(a[0]) && a[1]) {
      a = a.slice(1);
    }
    return a[0] ? path.basename(a[0]) : undefined;
  }

  // npx/uvx/bunx <tool> -> "<tool>"; node/deno/python <arquivo> -> basename.
  if (args[0]) {
    return path.basename(args[0]);
  }
  return undefined;
}

/** Porta explícita na linha: `--port 3000`, `--port=3000`, `-p 3000`, `PORT=3000`. */
function derivePort(commandLine: string): string | undefined {
  const m = commandLine.match(/(?:--port[ =]|(?:^|\s)PORT=|-p\s+)(\d{2,5})\b/);
  return m ? m[1] : undefined;
}

function renderTemplate(
  template: string,
  parsed: ParsedCommand,
  terminal: vscode.Terminal,
): string {
  const folder = workspaceFolderName(terminal);
  const cwdName = terminalCwdName(terminal) ?? folder;
  const cwd = terminalCwd(terminal);
  const pkg = cwd ? nearestPackageName(cwd) ?? '' : '';

  const rendered = template
    .replace(/\$\{command\}/g, parsed.command ?? '')
    .replace(/\$\{label\}/g, parsed.label ?? '')
    .replace(/\$\{package\}/g, pkg)
    .replace(/\$\{folder\}/g, folder)
    .replace(/\$\{cwd\}/g, cwdName)
    .replace(/\$\{port\}/g, parsed.port ?? '');

  // Cada segmento entre "·" é limpo; os vazios (ex.: sem package) somem.
  const clean = rendered
    .split('·')
    .map((seg) => seg.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  return clean || (parsed.command ?? '');
}

/**
 * Nome do projeto lendo o manifesto mais próximo (package.json / pyproject.toml),
 * subindo os diretórios a partir do cwd. Cacheado por diretório.
 */
function nearestPackageName(startDir: string): string | undefined {
  if (packageNameCache.has(startDir)) {
    return packageNameCache.get(startDir);
  }

  let dir = startDir;
  let found: string | undefined;
  for (let i = 0; i < 12; i++) {
    found = readPackageJsonName(dir) ?? readPyprojectName(dir);
    if (found) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  packageNameCache.set(startDir, found);
  return found;
}

function readPackageJsonName(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof parsed?.name === 'string' && parsed.name ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function readPyprojectName(dir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
    const m = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function formatTitle(title: string, maxLength: number): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (maxLength > 0 && clean.length > maxLength) {
    return clean.slice(0, maxLength - 1).trimEnd() + '…';
  }
  return clean;
}

function terminalCwd(terminal: vscode.Terminal): string | undefined {
  const cwdUri = terminal.shellIntegration?.cwd;
  if (cwdUri) {
    return cwdUri.fsPath;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function terminalCwdName(terminal: vscode.Terminal): string | undefined {
  const cwd = terminalCwd(terminal);
  return cwd ? path.basename(cwd) : undefined;
}

function workspaceFolderName(terminal: vscode.Terminal): string {
  const cwdUri = terminal.shellIntegration?.cwd;
  if (cwdUri) {
    const folder = vscode.workspace.getWorkspaceFolder(cwdUri);
    if (folder) {
      return folder.name;
    }
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].name;
  }
  return terminalCwdName(terminal) ?? 'terminal';
}
