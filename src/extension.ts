import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeSessionTracker } from './claudeSession';

/** Comando cujo título de sessão sabemos ler (grava `ai-title` em ~/.claude). */
const CLAUDE_COMMAND = 'claude';

/** Terminais renomeados na mão. A renomeação automática nunca os sobrescreve. */
const manuallyRenamed = new WeakSet<vscode.Terminal>();

/** Nome que queremos em cada terminal (aplicado quando ele fica ativo). */
const desiredNames = new Map<vscode.Terminal, string>();

/** Último nome já aplicado, pra evitar renomear à toa. */
const appliedNames = new Map<vscode.Terminal, string>();

/** Rastreadores de sessão do Claude por terminal. */
const trackers = new Map<vscode.Terminal, ClaudeSessionTracker>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('rename-tabs.renameTerminal', renameActiveTerminalCommand),
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
// Comando manual
// ---------------------------------------------------------------------------

async function renameActiveTerminalCommand(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showWarningMessage('Rename Tabs: nenhum terminal ativo para renomear.');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Novo nome para o terminal ativo',
    value: terminal.name,
    placeHolder: 'ex.: PROJ-123 · login',
  });
  if (name === undefined) {
    return; // cancelado
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }

  manuallyRenamed.add(terminal);
  desiredNames.set(terminal, trimmed);
  appliedNames.delete(terminal); // força a reaplicação
  await flush(terminal);
}

// ---------------------------------------------------------------------------
// Renomeação automática
// ---------------------------------------------------------------------------

async function handleShellExecution(
  event: vscode.TerminalShellExecutionStartEvent,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('renameTabs');
  if (!config.get<boolean>('autoRename.enabled', true)) {
    return;
  }

  const terminal = event.terminal;
  if (manuallyRenamed.has(terminal)) {
    return;
  }

  const command = firstCommandToken(event.execution.commandLine.value);
  if (!command) {
    return;
  }

  const watched = config.get<string[]>('autoRename.watchedCommands', [CLAUDE_COMMAND]);
  if (!watched.includes(command)) {
    return;
  }

  // Nome provisório imediato (o título do Claude leva alguns segundos).
  const template = config.get<string>('autoRename.template', '${command} · ${folder}');
  setDesiredAuto(terminal, renderTemplate(template, command, terminal));

  // Se for o Claude, começa a acompanhar o título da sessão.
  if (command === CLAUDE_COMMAND && config.get<boolean>('claudeTitle.enabled', true)) {
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
        .getConfiguration('renameTabs')
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
  if (manuallyRenamed.has(terminal)) {
    return;
  }
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

/**
 * Comando principal de uma linha de comando, sem caminho nem extensão.
 * Ex.: "/usr/local/bin/claude --resume" -> "claude".
 */
function firstCommandToken(commandLine: string): string | undefined {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return undefined;
  }
  const first = trimmed.split(/\s+/)[0];
  return path.basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function renderTemplate(template: string, command: string, terminal: vscode.Terminal): string {
  const folder = workspaceFolderName(terminal);
  const cwd = terminalCwdName(terminal) ?? folder;
  return template
    .replace(/\$\{command\}/g, command)
    .replace(/\$\{folder\}/g, folder)
    .replace(/\$\{cwd\}/g, cwd);
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
