# Rename Tabs

Extensão pra Cursor / VS Code que deixa as abas de terminal com nomes úteis, pra
você achar elas rápido no Ctrl+P (quando os terminais estão na área de editor).

## O problema

Terminais aparecem todos como `zsh`. Quando você joga eles pra área de editor
pra navegar por Ctrl+P, fica impossível distinguir um do outro.

## O que a extensão faz

- **Renomeação automática**: quando você roda um comando observado (por padrão,
  `claude`), a aba do terminal é renomeada pra algo como `claude · nome-da-pasta`.
- **Renomeação manual**: o comando **Rename Tabs: Renomear terminal ativo**
  (atalho `Cmd+Alt+R`) abre um input pra você digitar qualquer nome. A escolha
  manual sempre vence — o automático não sobrescreve depois.

## Configuração

| Chave | Padrão | O que faz |
| --- | --- | --- |
| `renameTabs.autoRename.enabled` | `true` | Liga/desliga a renomeação automática. |
| `renameTabs.autoRename.watchedCommands` | `["claude"]` | Comandos que disparam o auto-nome. |
| `renameTabs.autoRename.template` | `${command} · ${folder}` | Modelo do nome. Variáveis: `${command}`, `${folder}`, `${cwd}`. |

## Requisitos

- Cursor / VS Code `>= 1.93` (a renomeação automática usa a API de shell
  integration). O comando manual funciona sem isso.

## Desenvolvimento

```sh
npm install
npm run compile      # compila TypeScript pra out/
npm run package      # gera o .vsix
```

Pra testar, abra a pasta no Cursor e rode **Run Extension** (F5), ou instale o
`.vsix` gerado.
