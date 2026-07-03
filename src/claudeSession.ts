import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Converte um caminho de trabalho no nome do diretório de projeto do Claude.
 * O Claude troca todo caractere não-alfanumérico por "-".
 * Ex.: "/Users/raphael/code/rename-tabs" -> "-Users-raphael-code-rename-tabs".
 */
export function projectDirForCwd(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

/**
 * Lê o último `ai-title` (título gerado pelo Claude) de um arquivo de sessão
 * `.jsonl`. O título evolui ao longo da conversa, então pegamos o mais recente.
 */
export function readAiTitle(sessionFile: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return undefined;
  }
  let title: string | undefined;
  for (const line of content.split('\n')) {
    // Filtro barato antes de tentar o JSON.parse em cada linha.
    if (!line.includes('"ai-title"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'ai-title' && typeof parsed.aiTitle === 'string') {
        title = parsed.aiTitle;
      }
    } catch {
      // linha incompleta/inválida (pode estar sendo escrita) — ignora
    }
  }
  return title;
}

export interface ClaudeSessionTrackerOptions {
  /** Diretório onde o `claude` foi iniciado. */
  cwd: string;
  /** Chamado quando um título novo é detectado. */
  onTitle: (title: string) => void;
  /** Intervalo de verificação em ms (padrão 1500). */
  pollMs?: number;
}

/**
 * Observa o diretório de projeto do Claude correspondente a um cwd e avisa
 * quando o título da sessão ativa muda.
 *
 * Ligação terminal → sessão: quando o `claude` inicia num terminal, o arquivo
 * `.jsonl` daquela sessão passa a ser escrito. Escolhemos preferencialmente um
 * arquivo *criado* após o início (sessão nova); se não houver, caímos no de
 * modificação mais recente (sessão retomada com --continue/--resume).
 */
export class ClaudeSessionTracker {
  private readonly projectDir: string;
  private readonly startTime: number;
  private readonly pollMs: number;
  private boundFile: string | undefined;
  private lastMtime = 0;
  private lastTitle: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(private readonly opts: ClaudeSessionTrackerOptions) {
    this.projectDir = projectDirForCwd(opts.cwd);
    this.startTime = Date.now();
    this.pollMs = opts.pollMs ?? 1500;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.pollMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private scan(): void {
    if (this.disposed) {
      return;
    }
    const file = this.boundFile ?? this.pickSessionFile();
    if (!file) {
      return;
    }
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      // arquivo sumiu; permite reescolher na próxima varredura
      this.boundFile = undefined;
      return;
    }
    if (file === this.boundFile && mtime === this.lastMtime) {
      return; // nada mudou
    }
    this.boundFile = file;
    this.lastMtime = mtime;

    const title = readAiTitle(file);
    if (title && title !== this.lastTitle) {
      this.lastTitle = title;
      this.opts.onTitle(title);
    }
  }

  /** Escolhe o arquivo de sessão deste terminal. */
  private pickSessionFile(): string | undefined {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.projectDir);
    } catch {
      return undefined; // diretório ainda não existe
    }

    const grace = 2000; // tolerância pra clock/arredondamento
    let newestCreated: { file: string; at: number } | undefined;
    let newestModified: { file: string; at: number } | undefined;

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) {
        continue;
      }
      const full = path.join(this.projectDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < this.startTime - grace) {
        continue; // sessão antiga, não é a deste terminal
      }
      if (!newestModified || stat.mtimeMs > newestModified.at) {
        newestModified = { file: full, at: stat.mtimeMs };
      }
      if (stat.birthtimeMs >= this.startTime - grace) {
        if (!newestCreated || stat.birthtimeMs > newestCreated.at) {
          newestCreated = { file: full, at: stat.birthtimeMs };
        }
      }
    }

    // Sessão nova (arquivo recém-criado) tem prioridade; senão, a mais recente.
    return (newestCreated ?? newestModified)?.file;
  }
}
