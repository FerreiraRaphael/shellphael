import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Terminais que o usuário renomeou na mão. A renomeação automática nunca
 * sobrescreve esses — a escolha manual sempre vence.
 */
const manuallyRenamed = new WeakSet<vscode.Terminal>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('rename-tabs.renameTerminal', renameActiveTerminalCommand),
  );

  // A renomeação automática depende de shell integration, disponível a partir
  // do VS Code/Cursor 1.93. Se não existir, só o comando manual funciona.
  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(handleShellExecution),
    );
  }
}

export function deactivate(): void {
  // nada a limpar
}

async function renameActiveTerminalCommand(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showWarningMessage('Rename Tabs: nenhum terminal ativo para renomear.');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Novo nome para o terminal ativo',
    value: terminal.name,
    placeHolder: 'ex.: claude · rename-tabs',
  });
  if (name === undefined) {
    return; // cancelado
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }

  await applyName(trimmed);
  manuallyRenamed.add(terminal);
}

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

  const watched = config.get<string[]>('autoRename.watchedCommands', ['claude']);
  if (!watched.includes(command)) {
    return;
  }

  // Só renomeia o terminal que está ativo. O comando de renomear atua sobre o
  // terminal ativo, e evitar mexer em terminais em segundo plano previne roubo
  // de foco. Na prática, quando você roda `claude`, esse terminal está focado.
  if (vscode.window.activeTerminal !== terminal) {
    return;
  }

  const template = config.get<string>('autoRename.template', '${command} · ${folder}');
  await applyName(renderTemplate(template, command, terminal));
}

async function applyName(name: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
}

/**
 * Extrai o comando principal de uma linha de comando, sem caminho nem extensão.
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
  return 'terminal';
}

function terminalCwdName(terminal: vscode.Terminal): string | undefined {
  const cwdUri = terminal.shellIntegration?.cwd;
  return cwdUri ? path.basename(cwdUri.fsPath) : undefined;
}
