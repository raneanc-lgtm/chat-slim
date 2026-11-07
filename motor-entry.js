// Ponto de entrada do motor dentro do APK.
const fs = require('fs');
const path = require('path');
const util = require('util');

// ---- Configuração vinda do app Android pela linha de comando ----
// (mais confiável que variável de ambiente: chega igual em qualquer aparelho)
//   node main.js --chatslim-config '{"NODEJS_MOBILE_APP_STORAGE":"...","CHATSLIM_PORTA":"3010",...}'
(function lerConfigDaLinhaDeComando() {
  const i = process.argv.indexOf('--chatslim-config');
  if (i < 0 || !process.argv[i + 1]) return;
  try {
    const cfg = JSON.parse(process.argv[i + 1]);
    for (const [k, v] of Object.entries(cfg)) process.env[k] = String(v);
  } catch (_) {}
})();

// ---- Pasta temporária ----
// O Baileys grava arquivos temporários ao enviar mídia (foto, vídeo, áudio). No Android
// o /tmp do sistema não pode ser usado pelo app, então forçamos a pasta de cache do app.
(function corrigirPastaTemporaria() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const base = process.env.TMPDIR || (process.env.NODEJS_MOBILE_APP_STORAGE && path.join(process.env.NODEJS_MOBILE_APP_STORAGE, 'tmp'));
  if (!base) return;
  try { fs.mkdirSync(base, { recursive: true }); } catch (_) {}
  process.env.TMPDIR = base;
  os.tmpdir = () => base;
})();

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

console.log(`Motor iniciando — Node ${process.version} ${process.platform}/${process.arch} icu=${process.versions.icu || 'nenhum'} porta=${process.env.CHATSLIM_PORTA || 3000} tmp=${require('os').tmpdir()}`);
try {
  new RegExp('\\p{L}', 'u');
  console.log('Regex Unicode (\\p{...}): OK');
} catch (e) {
  console.log('Regex Unicode (\\p{...}) indisponível: ' + e.message);
}

// ---- O Node do Android vem sem ICU (dados Unicode/idiomas) ----
// Sem ICU o TextDecoder nativo não aceita a opção `fatal` nem encodings além
// do básico, e o Baileys (via whatsapp-rust-bridge) precisa disso. Este
// substituto cobre utf-8 (com fatal/ignoreBOM/stream), utf-16le e latin1.
(function corrigirTextDecoder() {
  let precisa = !!process.env.CHATSLIM_FORCAR_TEXTDECODER;
  try {
    new globalThis.TextDecoder('utf-8', { fatal: true });
  } catch (_) {
    precisa = true;
  }
  if (!precisa) return;

  const { StringDecoder } = require('string_decoder');
  const MAPA = {
    'utf-8': 'utf8', utf8: 'utf8', 'unicode-1-1-utf-8': 'utf8',
    'utf-16le': 'utf16le', 'utf-16': 'utf16le', utf16le: 'utf16le',
    latin1: 'latin1', 'iso-8859-1': 'latin1', 'iso8859-1': 'latin1', 'windows-1252': 'latin1',
    ascii: 'latin1', 'us-ascii': 'latin1',
  };
  const NOMES = { utf8: 'utf-8', utf16le: 'utf-16le', latin1: 'windows-1252' };

  class TextDecoder {
    constructor(rotulo = 'utf-8', opcoes = {}) {
      const enc = MAPA[String(rotulo).trim().toLowerCase()];
      if (!enc) {
        const e = new RangeError(`The "${rotulo}" encoding is not supported`);
        e.code = 'ERR_ENCODING_NOT_SUPPORTED';
        throw e;
      }
      this._enc = enc;
      this._sd = null;
      this._inicio = true;
      Object.defineProperty(this, 'encoding', { value: NOMES[enc], enumerable: true });
      Object.defineProperty(this, 'fatal', { value: !!(opcoes && opcoes.fatal), enumerable: true });
      Object.defineProperty(this, 'ignoreBOM', { value: !!(opcoes && opcoes.ignoreBOM), enumerable: true });
    }

    decode(entrada, opcoes = {}) {
      let buf;
      if (entrada === undefined || entrada === null) buf = Buffer.alloc(0);
      else if (ArrayBuffer.isView(entrada)) buf = Buffer.from(entrada.buffer, entrada.byteOffset, entrada.byteLength);
      else if (entrada instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && entrada instanceof SharedArrayBuffer)) buf = Buffer.from(entrada);
      else throw new TypeError('The "input" argument must be an instance of ArrayBuffer or ArrayBufferView');

      const emFluxo = !!(opcoes && opcoes.stream);
      const semEstadoAnterior = !this._sd;
      if (!this._sd) this._sd = new StringDecoder(this._enc);
      let texto = emFluxo ? this._sd.write(buf) : this._sd.end(buf);

      if (this.fatal && this._enc === 'utf8' && !emFluxo && semEstadoAnterior && texto.includes('\uFFFD')) {
        if (!Buffer.from(texto, 'utf8').equals(buf)) {
          this._sd = null;
          this._inicio = true;
          const e = new TypeError('The encoded data was not valid for encoding utf-8');
          e.code = 'ERR_ENCODING_INVALID_ENCODED_DATA';
          throw e;
        }
      }

      if (this._inicio && texto.length) {
        if (!this.ignoreBOM && this._enc !== 'latin1' && texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
        this._inicio = false;
      }
      if (!emFluxo) {
        this._sd = null;
        this._inicio = true;
      }
      return texto;
    }
  }

  globalThis.TextDecoder = TextDecoder;
  try {
    require('util').TextDecoder = TextDecoder;
  } catch (_) {}
  console.log('TextDecoder substituto ativado (Node sem ICU)');
})();

// O Node embarcado no Android (nodejs-mobile) é a versão 18, que não expõe
// globalThis.crypto por padrão — o Baileys precisa dele.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

try {
  // app.js = servidor + Baileys empacotados (gerado pelo scripts/build-motor.js).
  // Fica num arquivo separado pra que até erro de sintaxe dele caia aqui e vá pro log.
  require('./app.js');
} catch (err) {
  console.error('Falha ao carregar o servidor:', err && err.stack ? err.stack : err);
}
