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
