# Chat Slim — Projeto Android (Slim Creative)

Cliente próprio de WhatsApp. Motor Node.js (Baileys + Express) embarcado
dentro do APK via nodejs-mobile (Node 18 para Android, ponte JNI própria em
`android/app/src/main/cpp`), e a interface web rodando numa WebView nativa
que aponta para `http://127.0.0.1:3000` (servidor local, só acessível pelo
próprio celular). Um serviço em primeiro plano mantém a conexão viva com o
app minimizado.

## Por que o APK não foi gerado direto por mim

Gerar o `.apk` final exige o Android SDK (ferramentas `aapt`, `d8`,
`zipalign`, etc. — tudo baixado de `dl.google.com`). O workspace cloud
onde este projeto foi montado bloqueia esse domínio por política de
rede (só libera npm, PyPI, GitHub). Por isso a compilação final roda
fora daqui: no seu GitHub, via GitHub Actions (configurado em
`.github/workflows/build-apk.yml`), que baixa o SDK automaticamente
num ambiente sem essa restrição.

## Como gerar o APK

1. Suba esta pasta inteira pra um repositório no GitHub (pode ser na
   conta `slimcreative` que você já tem).
2. No GitHub, vá em **Actions** → o workflow "Build Chat Slim APK" roda
   sozinho a cada push na branch principal (ou clique em "Run workflow"
   pra rodar manualmente).
3. Quando terminar (leva alguns minutos), baixe o artefato
   **chat-slim-apk** gerado — dentro dele está o `app-debug.apk`.
4. Transfira esse `.apk` pro celular e instale (pode precisar permitir
   "instalar de fontes desconhecidas" nas configurações do Android,
   já que não veio da Play Store).

## Estrutura

- `server.js`, `motor.js`, `db.js`, `audio-ogg.js`, `public/` — o motor e a interface
- `motor-entry.js` + `scripts/build-motor.js` — empacotam o motor num único
  `main.js` compatível com o Node 18 do Android (gerado no build, não versionado)
- `android/` — app Android nativo (WebView + serviço + ponte JNI pro Node)
- `.github/workflows/build-apk.yml` — build automático (baixa o nodejs-mobile,
  empacota o motor e compila o APK)

## O que já funciona (validado via Termux antes de empacotar)

- Conexão via QR code
- Lista de conversas, histórico de mensagens
- Envio e recebimento de texto
- Envio e recebimento de foto, vídeo, documento
- Gravação e envio de áudio (mensagem de voz)
- Envio e recebimento de sticker
- Emoji (seletor embutido)
- Mensagens apagadas pelo remetente continuam visíveis (marcadas)
- Indicador de presença (online/offline)

## O que ainda não existe (por decisão, não por limitação resolvível)

- Chamada de voz/vídeo — usa protocolo totalmente separado da Meta
  (WebRTC proprietário) que nenhuma biblioteca aberta replica de forma
  estável. Mantenha o WhatsApp oficial instalado em paralelo para isso.

## Próximos passos possíveis

- Configurações de layout (cor do balão, fonte, etc.) direto no app
- Regras de notificação customizadas (contato, palavra-chave, horário)
- Assinatura de release (hoje gera `.apk` de debug, que já instala e
  funciona normalmente; uma versão "release" assinada viria depois,
  se você quiser publicar ou distribuir de forma mais formal)
