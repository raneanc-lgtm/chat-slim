// Empacota o motor (server.js + motor.js + db.js + Baileys...) num único
// arquivo main.js compatível com o Node 18 do Android, e copia a interface.
// Saída: android/app/src/main/assets/nodejs-project/
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const raiz = path.join(__dirname, '..');
const saida = path.join(raiz, 'android/app/src/main/assets/nodejs-project');

// Modo celular: o código de pareamento só aceita tipo "navegador". Então o pedido do código
// se apresenta como Chrome, e o registro do aparelho continua dizendo que é celular Android.
{
  const arqSock = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'socket.js');
  let f = fs.readFileSync(arqSock, 'utf8');
  const a1 = 'content: getCompanionPlatformId(browser)';
  const a2 = 'content: `${browser[1]} (${browser[0]})`';
  if (f.includes(a1) && f.includes(a2)) {
    f = f.split(a1).join("content: getCompanionPlatformId(/android/i.test(browser[1]) ? ['Mac OS', 'Chrome'] : browser)");
    f = f.split(a2).join("content: /android/i.test(browser[1]) ? 'Chrome (Mac OS)' : `${browser[1]} (${browser[0]})`");
    fs.writeFileSync(arqSock, f);
    console.log('✔ pareamento por código no modo celular ajustado');
  }
}
// Pareamento por QR travando (bugs abertos no Baileys: issues #2737 / PRs #2749 e #2765):
// 1) antes de parear não existe creds.me, e a confirmação (ack) dos avisos quebrava com TypeError;
// 2) o WhatsApp manda <notification type="companion_reg_refresh"> pedindo pra trocar a chave
//    (adv secret) do QR; o Baileys ignorava, e o celular escaneava um QR com chave já aposentada.
{
  const lib = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket');
  const arqRecv = path.join(lib, 'messages-recv.js');
  let r = fs.readFileSync(arqRecv, 'utf8');
  const ackVelho = 'const stanza = buildAckStanza(node, errorCode, authState.creds.me.id);';
  if (r.includes(ackVelho)) {
    r = r.split(ackVelho).join("if (node.tag === 'message' && !authState.creds.me?.id) throw new Error('ack de mensagem antes do pareamento'); const stanza = buildAckStanza(node, errorCode, authState.creds.me?.id);");
    fs.writeFileSync(arqRecv, r);
    console.log('✔ ack antes do pareamento corrigido');
  } else console.log('ℹ ack antes do pareamento: trecho não encontrado (talvez já corrigido)');

  const arqSock = path.join(lib, 'socket.js');
  let k = fs.readFileSync(arqSock, 'utf8');
  const qrVelho = 'const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser);';
  const fimHandler = '        genPairQR();\n    });\n';
  if (k.includes(qrVelho) && k.split(fimHandler).length === 2) {
    k = k.split(qrVelho).join('qrRefAtual = ref; const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser);');
    k = k.split('    let qrTimer;\n').join('    let qrTimer;\n    let qrRefAtual = null;\n');
    k = k.split(fimHandler).join(fimHandler + `    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
        if (!getBinaryNodeChild(node, 'companion_reg_refresh') && !getBinaryNodeChild(node, 'pair-device-rotate-qr')) return;
        if (creds.me) return;
        creds.advSecretKey = randomBytes(32).toString('base64');
        ev.emit('creds.update', { advSecretKey: creds.advSecretKey });
        logger.info('companion_reg_refresh: chave do QR trocada');
        if (qrRefAtual && ws.isOpen) {
            const qr = buildPairingQRData(qrRefAtual, Buffer.from(creds.noiseKey.public).toString('base64'), Buffer.from(creds.signedIdentityKey.public).toString('base64'), creds.advSecretKey, browser);
            ev.emit('connection.update', { qr });
        }
    });
`);
    if (!k.includes('let qrRefAtual = null;')) throw new Error('correção do QR: let qrTimer não encontrado');
    fs.writeFileSync(arqSock, k);
    console.log('✔ companion_reg_refresh tratado (QR troca a chave quando o WhatsApp pede)');
  } else console.log('ℹ companion_reg_refresh: trecho não encontrado');
}
// Modo celular: registra o aparelho como ANDROID_PHONE (browser[1] = 'ANDROID_PHONE'), mas o login
// continua se identificando como WhatsApp Web — login "Android" com versão do Web leva 401.
{
  const arqVal = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Utils', 'validate-connection.js');
  let v = fs.readFileSync(arqVal, 'utf8');
  const cond = "config.browser[1].toLocaleLowerCase().includes('android')";
  const n = v.split(cond).length - 1;
  if (n === 2) {
    v = v.split(cond).join("config.browser[1].toLocaleLowerCase() === 'android'");
    fs.writeFileSync(arqVal, v);
    console.log('✔ modo celular: login como Web, registro como Android');
  } else console.log('ℹ modo celular: trecho do login não encontrado (' + n + ')');
}
// Correção pontual no Baileys: ele testa `typeof Jimp === 'object'`, mas no jimp 1.x
// Jimp é uma classe (function). Sem isso não gera miniatura de imagem/vídeo no Android
// (lá não existe o "sharp", que é binário nativo de PC).
const arqMidia = path.join(raiz, 'node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js');
let fonte = fs.readFileSync(arqMidia, 'utf8');
const errado = "typeof lib.jimp?.Jimp === 'object'";
if (fonte.includes(errado)) {
  fonte = fonte.split(errado).join("(typeof lib.jimp?.Jimp === 'object' || typeof lib.jimp?.Jimp === 'function')");
  fs.writeFileSync(arqMidia, fonte);
  console.log('✔ correção do jimp aplicada no Baileys');
} else {
  console.log('ℹ correção do jimp não necessária nesta versão do Baileys');
}

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(saida, { recursive: true });

// O Node do Android não tem os dados Unicode completos: regex com \p{ID_Start}
// (usada pelo path-to-regexp do Express 5) quebra o carregamento do arquivo inteiro.
// Troca por faixas equivalentes que não dependem disso.
const semUnicodeProps = {
  name: 'sem-unicode-props',
  setup(build) {
    build.onLoad({ filter: /path-to-regexp[\\/]dist[\\/]index\.js$/ }, (args) => {
      let codigo = fs.readFileSync(args.path, 'utf8');
      const antes = codigo;
      codigo = codigo
        .split('\\p{ID_Start}').join('A-Za-z\\u00aa-\\uffff')
        .split('\\p{ID_Continue}').join('0-9A-Za-z_\\u00aa-\\uffff');
      if (codigo !== antes) console.log('✔ regex Unicode do path-to-regexp substituída');
      return { contents: codigo, loader: 'js' };
    });
  },
};

const comum = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', logLevel: 'warning' };

async function empacotar() {
  await esbuild.build({
    ...comum,
    entryPoints: [path.join(raiz, 'server.js')],
    outfile: path.join(saida, 'app.js'),
    minify: true, // arquivo menor = o Node lê mais rápido ao abrir o app
    keepNames: true,
    external: ['sharp'], // binário nativo de PC, não roda no Android (Baileys trata a ausência)
    plugins: [semUnicodeProps],
  });
  await esbuild.build({
    ...comum,
    entryPoints: [path.join(raiz, 'motor-entry.js')],
    outfile: path.join(saida, 'main.js'),
    external: ['./app.js'],
  });
  fs.cpSync(path.join(raiz, 'public'), path.join(saida, 'public'), { recursive: true });

  // versao.json: número da versão + SHA-256 de cada arquivo (usado na atualização automática)
  const versao = Number(process.env.MOTOR_VERSAO || 0);
  const arquivos = {};
  const listar = (dir, pref = '') => {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n), rel = pref + n;
      if (fs.statSync(p).isDirectory()) listar(p, rel + '/');
      else if (n !== 'versao.json') arquivos[rel] = require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  listar(saida);
  fs.writeFileSync(path.join(saida, 'versao.json'), JSON.stringify({ versao, arquivos }, null, 1));
  console.log(`✔ versao.json: motor versão ${versao} (${Object.keys(arquivos).length} arquivos)`);

  const app = fs.readFileSync(path.join(saida, 'app.js'), 'utf8');
  const restantes = (app.match(/\/[^\n/]*\\[pP]\{[^}]+\}[^\n/]*\/[a-z]*u[a-z]*/g) || []);
  if (restantes.length) {
    console.log('⚠ ainda há regex literal com \\p{...}:', restantes.slice(0, 5));
  }
  const tam = (fs.statSync(path.join(saida, 'app.js')).size / 1024 / 1024).toFixed(1);
  console.log(`✔ motor empacotado: main.js + app.js (${tam} MB) + public/`);
}

empacotar().catch((e) => {
  console.error(e);
  process.exit(1);
});
