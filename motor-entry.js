// Ponto de entrada do motor dentro do APK.
const fs = require('fs');
const path = require('path');
const util = require('util');

// ---- Log em arquivo (o app mostra esse log na tela se o motor não subir) ----
const BASE = process.env.NODEJS_MOBILE_APP_STORAGE || __dirname;
const ARQ_LOG = path.join(BASE, 'motor.log');
try {
  if (fs.existsSync(ARQ_LOG) && fs.statSync(ARQ_LOG).size > 256 * 1024) {
    fs.renameSync(ARQ_LOG, ARQ_LOG + '.antigo');
  }
} catch (_) {}
function gravar(nivel, args) {
  try {
    const linha = `[${new Date().toISOString()}] ${nivel} ${util.format(...args)}\n`;
    fs.appendFileSync(ARQ_LOG, linha);
  } catch (_) {}
}
for (const [metodo, nivel] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'AVISO'], ['error', 'ERRO']]) {
  const original = console[metodo].bind(console);
  console[metodo] = (...args) => {
    gravar(nivel, args);
    original(...args);
  };
}

// ---- Nunca deixar um erro solto derrubar o motor (no Android isso fecha o app) ----
process.on('uncaughtException', (err) => console.error('Erro não tratado:', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (err) => console.error('Promessa rejeitada sem tratamento:', err && err.stack ? err.stack : err));

console.log(`Motor iniciando — Node ${process.version} ${process.platform}/${process.arch}`);

// O Node embarcado no Android (nodejs-mobile) é a versão 18, que não expõe
// globalThis.crypto por padrão — o Baileys precisa dele.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

try {
  require('./server');
} catch (err) {
  console.error('Falha ao carregar o servidor:', err && err.stack ? err.stack : err);
}
