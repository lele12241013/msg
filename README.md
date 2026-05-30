# Popup remoto para Windows

Aplicativo local para Windows que sobe um servidor em segundo plano e abre um painel web para enviar mensagens. Cada mensagem recebida aparece como um pop-up sobre a tela.

## Como usar

1. Instale as dependencias com `npm install`.
2. Para desenvolvimento, execute `npm start`.
3. Para gerar o executavel, execute `npm run build`.
4. Para instalar no notebook e iniciar com o Windows, execute `install-app.cmd`.
5. O instalador copia o executavel para `%LOCALAPPDATA%\PopupRemoto` e cria o atalho de inicializacao automatica na pasta Startup do Windows.
6. Depois de instalado, o painel abre em `http://127.0.0.1:3471`.
7. No painel, ajuste cor de fundo, cor da faixa lateral, cor da letra, tamanho, transparencia e tamanho da fonte do popup.
8. Salve o estilo para reutilizar automaticamente nos proximos popups.
9. Envie um texto pelo formulario ou com uma requisicao HTTP para `POST /api/popup`.

## Uso remoto com GitHub

1. Suba este projeto para um repositorio no GitHub.
2. Mantenha o arquivo `relay/popup-command.json` no repositorio.
3. Ative o GitHub Pages para a pasta `docs/`.
4. Acesse a pagina online `docs/index.html` publicada no Pages.
5. Na pagina online, preencha dono, repositorio, branch, caminho e token GitHub (PAT com permissao de conteudo) e envie a mensagem.
6. No notebook com o app instalado, abra o painel local e em "Modo remoto GitHub":
  - ligue "Busca remota";
  - cole a URL raw exibida na pagina online;
  - configure o mesmo `device key` usado no site;
  - salve.
7. O notebook passa a consultar esse JSON periodicamente e mostrar popup de qualquer lugar.

## Instalacao automatica no Windows

- O instalador cria um atalho com `--silent` na pasta Startup do usuario atual.
- Isso faz o aplicativo iniciar em segundo plano sempre que voce entrar no Windows.
- Um atalho na area de trabalho tambem e criado para abrir o aplicativo manualmente.

## Exemplo de requisicao

```bash
curl -X POST http://127.0.0.1:3471/api/popup \
  -H "Content-Type: application/json" \
  -d '{"message":"Ola do site","durationMs":5000,"settings":{"backgroundColor":"#f4e8ff","accentColor":"#ff6b6b","textColor":"#1f1135","width":520,"height":220,"fontSize":24,"opacity":78}}'
```

## Configuracao do popup

- O painel salva as preferencias visualmente no proprio notebook.
- A API `POST /api/settings` salva o estilo padrao usado pelos proximos popups.
- A API `POST /api/popup` tambem aceita um objeto `settings` para sobrescrever o estilo em uma mensagem especifica.
- A API `POST /api/remote-config` salva o modo remoto (URL raw, device key e intervalo).

## Observacao

Por padrao, o servidor escuta apenas em `127.0.0.1`. Isso deixa o MVP seguro para uso local. Se quiser controlar de outro site ou outro dispositivo, o proximo passo e adicionar autenticacao e expor uma rota publica com tunel ou backend proprio.