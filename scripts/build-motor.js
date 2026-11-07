// Empacota o motor (server.js + motor.js + db.js + Baileys...) num único
// arquivo main.js compatível com o Node 18 do Android, e copia a interface.
// Saída: android/app/src/main/assets/nodejs-project/
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const raiz = path.join(__dirname, '..');
const saida = path.join(raiz, 'android/app/src/main/assets/nodejs-project');

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

esbuild.buildSync({
  entryPoints: [path.join(raiz, 'motor-entry.js')],
  outfile: path.join(saida, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['sharp'], // binário nativo de PC, não roda no Android (Baileys trata a ausência)
  logLevel: 'warning',
});
fs.cpSync(path.join(raiz, 'public'), path.join(saida, 'public'), { recursive: true });

const tam = (fs.statSync(path.join(saida, 'main.js')).size / 1024 / 1024).toFixed(1);
console.log(`✔ motor empacotado: main.js (${tam} MB) + public/`);
