# Chat Slim — Projeto Android (Slim Creative)

Cliente próprio de WhatsApp. Motor Node.js (Baileys + Express) embarcado
dentro do APK via nodejs-mobile; interface web (HTML/CSS/JS) rodando numa
WebView que aponta para `http://localhost:3000` (o próprio motor, local
no celular, sem depender de internet externa além da conexão com o
WhatsApp).

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

- `android/` — projeto Android (Capacitor + nodejs-mobile)
  - `app/src/main/assets/nodejs-project/` — o motor Node.js embarcado
    (cópia de `server.js`, `motor.js`, `db.js`, `public/`)
  - `app/src/main/java/.../MainActivity.java` — inicia o Node embarcado
    e aponta a WebView pra ele
  - `app/src/main/AndroidManifest.xml` — permissões (internet,
    microfone, câmera, mídia)
  - ícone do app já gerado em todos os tamanhos (`mipmap-*`)
- `.github/workflows/build-apk.yml` — build automático

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
