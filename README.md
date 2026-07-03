# Shellphael 🐢

Extensão pra Cursor / VS Code que deixa as abas de terminal com nomes úteis, pra
você achar elas rápido no Ctrl+P (quando os terminais estão na área de editor).

## O problema

Terminais aparecem todos como `zsh`. Quando você joga eles pra área de editor
pra navegar por Ctrl+P, fica impossível distinguir um do outro.

## O que a extensão faz

- **Título da sessão do Claude**: quando você roda `claude`, a extensão lê o
  título gerado pela sessão (o `ai-title` que o Claude grava em `~/.claude`) e
  usa como nome da aba — atualizando **ao vivo** conforme a conversa evolui.
  Enquanto o título não existe, usa um nome provisório (`claude · nome-da-pasta`).
- **Renomeação automática de processos**: quando você roda um runner observado
  (`npm`, `pnpm`, `yarn`, `node`, `uv`, `python`, etc.), a aba recebe um nome
  montado por "peças", pra você distinguir vários processos parecidos:
  - `${command}` — o binário (`npm`, `node`, `uv`).
  - `${label}` — o token que dá sentido ao comando: `npm run dev` → `dev`,
    `uv run pytest` → `pytest`, `node server.js` → `server.js`.
  - `${package}` — nome do projeto lido do `package.json`/`pyproject.toml` mais
    próximo do cwd (ótimo em monorepo: `@acme/api`).
  - `${cwd}` / `${folder}` — pasta atual do terminal / pasta do workspace.
  - `${port}` — a porta, **quando ela aparece explícita** na linha de comando
    (`--port 3000`, `-p 3001`, `PORT=3000 …`).

  O molde padrão é `${command} ${label} · ${package} · ${port}`, e segmentos
  vazios somem. Exemplos: `npm dev · frontend`, `uv pytest · backend`,
  `node server.js · api · 8080`.
- **Fechar editores mantendo os terminais**: o comando **Shellphael: Fechar
  editores (manter terminais)** fecha todas as abas de arquivos/editores mas
  ignora os terminais que estão na área de editor. Ele assume o atalho
  `Cmd+K Cmd+W` (`Ctrl+K Ctrl+W` no Windows/Linux), no lugar do "Fechar todos os
  editores" nativo — que fecharia os terminais junto.

### Como funciona a ligação terminal → sessão

O Claude guarda cada sessão em `~/.claude/projects/<pasta-encodada>/<id>.jsonl`.
A extensão descobre a pasta pelo cwd do terminal e liga o terminal ao arquivo de
sessão que passa a ser escrito logo após o `claude` iniciar. Por limitação da
API, o novo nome é aplicado quando o terminal está **ativo/focado** — o que
casa com o fluxo de conversar com o Claude na aba focada.

## Configuração

| Chave | Padrão | O que faz |
| --- | --- | --- |
| `shellphael.autoRename.enabled` | `true` | Liga/desliga a renomeação automática. |
| `shellphael.autoRename.watchedCommands` | `["claude", "npm", "pnpm", "yarn", "node", "uv", "python", …]` | Comandos (runners) que disparam o auto-nome. |
| `shellphael.autoRename.template` | `${command} ${label} · ${package} · ${port}` | Molde do nome. Peças: `${command}`, `${label}`, `${package}`, `${cwd}`, `${folder}`, `${port}`. Segmentos vazios somem. |
| `shellphael.claudeTitle.enabled` | `true` | Usa o título da sessão do Claude como nome da aba. |
| `shellphael.claudeTitle.maxLength` | `40` | Corta títulos longos (0 = não corta). |

## Requisitos

- Cursor / VS Code `>= 1.93` (a renomeação automática usa a API de shell
  integration).

## Desenvolvimento

```sh
npm install
npm run compile      # compila TypeScript pra out/
npm run package      # gera o .vsix
```

Pra testar, abra a pasta no Cursor e rode **Run Extension** (F5), ou instale o
`.vsix` gerado.
