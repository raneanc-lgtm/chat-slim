// ============================================================
// Chat Slim — Camada de armazenamento (arquivo JSON local via lowdb)
// ============================================================
// Guarda TUDO que passa pelo cliente assim que chega — antes de
// qualquer evento de exclusão ser processado. Isso é o que permite
// manter histórico mesmo quando o remetente apaga a mensagem.
//
// Usa lowdb (puro JavaScript, sem compilação nativa) em vez de
// better-sqlite3, porque o Termux/Android não tem as ferramentas
// de build (node-gyp/NDK) prontas para compilar módulos nativos.
// ============================================================

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

// Dentro do APK (nodejs-mobile), __dirname fica em área somente-leitura
// (assets empacotados). O nodejs-mobile expõe um diretório gravável via
// a variável NODEJS_MOBILE_APP_STORAGE; fora do APK (Termux/dev), cai
// no comportamento normal usando __dirname.
const BASE_DIR = process.env.NODEJS_MOBILE_APP_STORAGE || __dirname;
const DATA_DIR = path.join(BASE_DIR, 'dados');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MIDIA_DIR = path.join(DATA_DIR, 'midia');
if (!fs.existsSync(MIDIA_DIR)) fs.mkdirSync(MIDIA_DIR, { recursive: true });

const adapter = new FileSync(path.join(DATA_DIR, 'chatslim.json'));
const db = low(adapter);

db.defaults({ conversas: [], mensagens: [], presenca: [], contatos: [], lids: [], status: [] }).write();

// Limpeza de dados antigos: versões anteriores guardavam status e canais como se fossem conversa
(function limparLixo() {
  const lixo = (jid) => !jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
  const ruins = db.get('conversas').filter((c) => lixo(c.jid)).map('jid').value();
  if (ruins.length) {
    db.get('conversas').remove((c) => lixo(c.jid)).write();
    db.get('mensagens').remove((m) => lixo(m.conversa_jid)).write();
  }
})();

// ---- Conversas ----
function upsertConversa({ jid, nome, ehGrupo, naoLida }) {
  const existente = db.get('conversas').find({ jid }).value();
  if (existente) {
    const mudar = {};
    if (nome) mudar.nome = nome;
    if (naoLida) mudar.nao_lidas = (existente.nao_lidas || 0) + 1;
    if (Object.keys(mudar).length) db.get('conversas').find({ jid }).assign(mudar).write();
  } else {
    db.get('conversas')
      .push({
        jid,
        nome: nome || null,
        eh_grupo: ehGrupo ? 1 : 0,
        ultima_mensagem_texto: null,
        ultima_mensagem_ts: 0,
        nao_lidas: naoLida ? 1 : 0,
      })
      .write();
  }
}

// só avança: mensagem antiga do histórico não sobrescreve a última de verdade
function atualizarUltimaMensagem(jid, texto, timestamp) {
  const c = db.get('conversas').find({ jid }).value();
  if (!c || (c.ultima_mensagem_ts || 0) > timestamp) return;
  const mudar = { ultima_mensagem_ts: timestamp };
  if (texto !== null && texto !== undefined) mudar.ultima_mensagem_texto = texto;
  db.get('conversas').find({ jid }).assign(mudar).write();
}

function marcarLidas(jid) {
  db.get('conversas').find({ jid }).assign({ nao_lidas: 0 }).write();
}

// Nomes: "agenda" (o que VOCÊ salvou) > "grupo" (nome do grupo) > "perfil" (o que a pessoa pôs)
function definirNomeContato(jid, nome, fonte = 'perfil') {
  if (!jid || !nome) return;
  const campo = fonte === 'agenda' ? 'nome_agenda' : fonte === 'grupo' ? 'nome_grupo' : 'nome_perfil';
  const existente = db.get('contatos').find({ jid }).value();
  if (existente) {
    if (existente[campo] !== nome) db.get('contatos').find({ jid }).assign({ [campo]: nome }).write();
  } else {
    db.get('contatos').push({ jid, [campo]: nome }).write();
  }
}

function nomeDoContato(jid) {
  const c = db.get('contatos').find({ jid }).value();
  if (c) {
    // "nome" = formato antigo (versão anterior), tratado como perfil
    const n = c.nome_agenda || c.nome_grupo || c.nome_perfil || c.nome;
    if (n) return n;
  }
  // nome guardado no código interno (@lid) dessa mesma pessoa
  for (const x of db.get('lids').filter({ pn: jid }).value()) {
    const l = db.get('contatos').find({ jid: x.lid }).value();
    if (l) {
      const n = l.nome_agenda || l.nome_grupo || l.nome_perfil || l.nome;
      if (n) return n;
    }
  }
  return null;
}

function formatarNumero(jid) {
  const id = String(jid || '').split('@')[0];
  if (/^55\d{10,11}$/.test(id)) return `+55 ${id.slice(2, 4)} ${id.slice(4, -4)}-${id.slice(-4)}`;
  return /^\d+$/.test(id) ? '+' + id : id;
}

function nomeExibicao(c) {
  return nomeDoContato(c.jid) || c.nome || formatarNumero(c.jid);
}

// conversas onde o nome ficou com o SEU nome (bug de versão anterior)
function limparNomeIgual(meuNome) {
  db.get('conversas').filter((c) => !c.eh_grupo && c.nome === meuNome).value()
    .forEach((c) => db.get('conversas').find({ jid: c.jid }).assign({ nome: null }).write());
}

// ---- Código interno (@lid) x número: junta tudo no número ----
function listarLids() {
  return db.get('lids').value();
}

function unificarLid(lid, pn) {
  if (!db.get('lids').find({ lid }).value()) db.get('lids').push({ lid, pn }).write();
  // mensagens
  db.get('mensagens').filter({ conversa_jid: lid }).value()
    .forEach((m) => db.get('mensagens').find({ id: m.id }).assign({ conversa_jid: pn }).write());
  db.get('mensagens').filter({ remetente_jid: lid }).value()
    .forEach((m) => db.get('mensagens').find({ id: m.id }).assign({ remetente_jid: pn }).write());
  // conversa
  const cl = db.get('conversas').find({ jid: lid }).value();
  if (cl) {
    const cp = db.get('conversas').find({ jid: pn }).value();
    if (cp) {
      const novaMaisRecente = (cl.ultima_mensagem_ts || 0) > (cp.ultima_mensagem_ts || 0);
      db.get('conversas').find({ jid: pn }).assign({
        nome: cp.nome || cl.nome,
        nao_lidas: (cp.nao_lidas || 0) + (cl.nao_lidas || 0),
        ultima_mensagem_ts: Math.max(cl.ultima_mensagem_ts || 0, cp.ultima_mensagem_ts || 0),
        ultima_mensagem_texto: novaMaisRecente ? cl.ultima_mensagem_texto : cp.ultima_mensagem_texto,
      }).write();
      db.get('conversas').remove({ jid: lid }).write();
    } else {
      db.get('conversas').find({ jid: lid }).assign({ jid: pn }).write();
    }
  }
  // status
  db.get('status').filter({ autor_jid: lid }).value()
    .forEach((x) => db.get('status').find({ id: x.id }).assign({ autor_jid: pn }).write());
}

// ---- Apagar conversa ----
function ultimaMensagem(jid) {
  return db.get('mensagens').filter({ conversa_jid: jid }).orderBy(['timestamp'], ['desc']).head().value();
}

function apagarArquivoMidia(nome) {
  if (!nome) return;
  try { fs.unlinkSync(path.join(MIDIA_DIR, path.basename(nome))); } catch (_) {}
}

function apagarConversa(jid) {
  db.get('mensagens').filter({ conversa_jid: jid }).value().forEach((m) => apagarArquivoMidia(m.midia_path));
  db.get('mensagens').remove({ conversa_jid: jid }).write();
  db.get('conversas').remove({ jid }).write();
}

// ---- Status (24h) ----
function salvarStatus(st) {
  if (db.get('status').find({ id: st.id }).value()) return;
  db.get('status').push(st).write();
}

function listarStatus() {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  const velhos = db.get('status').filter((x) => x.timestamp < limite).value();
  if (velhos.length) {
    velhos.forEach((x) => apagarArquivoMidia(x.midia_path));
    db.get('status').remove((x) => x.timestamp < limite).write();
  }
  const porAutor = {};
  for (const x of db.get('status').orderBy(['timestamp'], ['asc']).value()) {
    (porAutor[x.autor_jid] = porAutor[x.autor_jid] || []).push(x);
  }
  return Object.entries(porAutor)
    .map(([jid, itens]) => ({
      autor_jid: jid,
      nome: nomeDoContato(jid) || formatarNumero(jid),
      itens,
      ultimo_ts: itens[itens.length - 1].timestamp,
    }))
    .sort((a, b) => b.ultimo_ts - a.ultimo_ts);
}

function listarConversas() {
  return db
    .get('conversas')
    .filter((c) => c.ultima_mensagem_ts > 0)
    .orderBy(['ultima_mensagem_ts'], ['desc'])
    .value()
    .map((c) => ({ ...c, nome_exibicao: nomeExibicao(c) }));
}

// ---- Mensagens ----
function salvarMensagem(msg) {
  const jaExiste = db.get('mensagens').find({ id: msg.id }).value();
  if (jaExiste) return;
  db.get('mensagens')
    .push({
      id: msg.id,
      conversa_jid: msg.conversaJid,
      remetente_jid: msg.remetenteJid,
      remetente_nome: msg.remetenteNome,
      de_mim: msg.deMim,
      tipo: msg.tipo,
      texto: msg.texto,
      midia_path: msg.midiaPath,
      midia_mimetype: msg.midiaMimetype,
      timestamp: msg.timestamp,
      apagada_pelo_remetente: 0,
      apagada_em: null,
    })
    .write();
}

function marcarComoApagada(id) {
  db.get('mensagens')
    .find({ id })
    .assign({ apagada_pelo_remetente: 1, apagada_em: Date.now() })
    .write();
}

function listarMensagens(conversaJid, limite = 200) {
  return db
    .get('mensagens')
    .filter({ conversa_jid: conversaJid })
    .orderBy(['timestamp'], ['asc'])
    .takeRight(limite)
    .value();
}

// ---- Presença ----
function atualizarPresenca(jid, status) {
  const existente = db.get('presenca').find({ jid }).value();
  if (existente) {
    db.get('presenca').find({ jid }).assign({ status, atualizado_em: Date.now() }).write();
  } else {
    db.get('presenca').push({ jid, status, atualizado_em: Date.now() }).write();
  }
}

function obterPresenca(jid) {
  return db.get('presenca').find({ jid }).value();
}

module.exports = {
  MIDIA_DIR,
  upsertConversa,
  atualizarUltimaMensagem,
  listarConversas,
  marcarLidas,
  definirNomeContato,
  limparNomeIgual,
  listarLids,
  unificarLid,
  ultimaMensagem,
  apagarConversa,
  salvarStatus,
  listarStatus,
  salvarMensagem,
  marcarComoApagada,
  listarMensagens,
  atualizarPresenca,
  obterPresenca,
};
