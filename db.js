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

db.defaults({ conversas: [], mensagens: [], presenca: [], contatos: [] }).write();

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

// nome salvo na agenda / nome do grupo
function definirNomeContato(jid, nome) {
  const existente = db.get('contatos').find({ jid }).value();
  if (existente) {
    if (existente.nome !== nome) db.get('contatos').find({ jid }).assign({ nome }).write();
  } else {
    db.get('contatos').push({ jid, nome }).write();
  }
}

function nomeExibicao(c) {
  const contato = db.get('contatos').find({ jid: c.jid }).value();
  if (contato && contato.nome) return contato.nome;
  if (c.nome) return c.nome;
  const id = String(c.jid || '').split('@')[0];
  if (/^55\d{10,11}$/.test(id)) return `+55 ${id.slice(2, 4)} ${id.slice(4, -4)}-${id.slice(-4)}`;
  return /^\d+$/.test(id) ? '+' + id : id;
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
  salvarMensagem,
  marcarComoApagada,
  listarMensagens,
  atualizarPresenca,
  obterPresenca,
};
