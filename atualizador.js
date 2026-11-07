// ============================================================
// Chat Slim — Atualização automática do motor (sem precisar de APK novo)
// ============================================================
// A cada 30 min confere no GitHub (branch "motor") se tem versão nova.
// Baixa os arquivos, confere o SHA-256 de cada um e troca a pasta
// motor-ota; depois reinicia o motor (o Android sobe ele de novo na hora)
// e o app passa a usar a versão nova. Se a nova não abrir 3 vezes
// seguidas, o app volta sozinho pra versão que veio no APK.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const URL_BASE = 'https://raw.githubusercontent.com/raneanc-lgtm/chat-slim/motor/';
const BASE = process.env.NODEJS_MOBILE_APP_STORAGE;
const PASTA_ATUAL = path.dirname(process.argv[1] || __filename);

function versaoAtual() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PASTA_ATUAL, 'versao.json'), 'utf8')).versao || 0;
  } catch (_) {
    return 0;
  }
}

const nomeSeguro = (n) => /^[a-zA-Z0-9_./-]+$/.test(n) && !n.split('/').includes('..') && !n.startsWith('/');

async function baixar(url) {
  const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

let ocupado = false;
let reiniciarAntes = null; // função que diz se dá pra reiniciar agora (ex.: não está enviando nada)

async function checar() {
  if (ocupado || !BASE) return;
  ocupado = true;
  try {
    const remoto = JSON.parse((await baixar(URL_BASE + 'versao.json')).toString('utf8'));
    const atual = versaoAtual();
    if (!(Number(remoto.versao) > atual)) return;
    console.log(`Atualização do motor disponível: ${atual} → ${remoto.versao}`);

    const novo = path.join(BASE, 'motor-ota-novo');
    fs.rmSync(novo, { recursive: true, force: true });
    for (const [arq, hash] of Object.entries(remoto.arquivos || {})) {
      if (!nomeSeguro(arq)) throw new Error('nome de arquivo inválido: ' + arq);
      const dados = await baixar(URL_BASE + arq);
      const h = crypto.createHash('sha256').update(dados).digest('hex');
      if (h !== hash) throw new Error('arquivo corrompido: ' + arq);
      fs.mkdirSync(path.dirname(path.join(novo, arq)), { recursive: true });
      fs.writeFileSync(path.join(novo, arq), dados);
    }
    if (!fs.existsSync(path.join(novo, 'main.js')) || !fs.existsSync(path.join(novo, 'app.js'))) throw new Error('pacote incompleto');
    fs.writeFileSync(path.join(novo, 'versao.json'), JSON.stringify(remoto));

    const ota = path.join(BASE, 'motor-ota');
    const velho = path.join(BASE, 'motor-ota-velho');
    fs.rmSync(velho, { recursive: true, force: true });
    if (fs.existsSync(ota)) fs.renameSync(ota, velho);
    fs.renameSync(novo, ota);
    fs.rmSync(velho, { recursive: true, force: true });
    fs.rmSync(path.join(BASE, 'ota-tentativas'), { force: true });
    console.log(`Motor ${remoto.versao} baixado. Reiniciando pra aplicar...`);
    reiniciarQuandoLivre();
  } catch (err) {
    console.error('Atualização do motor falhou:', err.message);
  } finally {
    ocupado = false;
  }
}

function reiniciarQuandoLivre(tentativa = 0) {
  if (reiniciarAntes && !reiniciarAntes() && tentativa < 20) {
    setTimeout(() => reiniciarQuandoLivre(tentativa + 1), 3000);
    return;
  }
  setTimeout(() => process.exit(0), 1500); // o Android sobe o motor de novo, já com a versão nova
}

// Chamado quando o servidor subiu sem erro: esta versão abre direitinho.
function marcarInicioOk(podeReiniciar) {
  reiniciarAntes = podeReiniciar || null;
  if (!BASE) return;
  fs.rmSync(path.join(BASE, 'ota-tentativas'), { force: true });
  console.log(`Motor versão ${versaoAtual()} (${PASTA_ATUAL.endsWith('motor-ota') ? 'atualização online' : 'a do APK'})`);
  setTimeout(checar, 60 * 1000);
  setInterval(checar, 30 * 60 * 1000);
}

module.exports = { marcarInicioOk, checar, versaoAtual };
