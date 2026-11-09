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

db.defaults({ conversas: [], mensagens: [], presenca: [], contatos: [], lids: [], status: [], vigiados: [], status_silenciados: [], chamadas: [], config: {} }).write();

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
function atualizarUltimaMensagem(jid, texto, timestamp, meta) {
  const c = db.get('conversas').find({ jid }).value();
  if (!c || (c.ultima_mensagem_ts || 0) > timestamp) return;
  const mudar = { ultima_mensagem_ts: timestamp };
  if (texto !== null && texto !== undefined) mudar.ultima_mensagem_texto = texto;
  if (meta) {
    if (meta.id !== undefined) mudar.ultima_id = meta.id;
    mudar.ultima_de_mim = meta.deMim ? 1 : 0;
    mudar.ultima_status = meta.deMim ? (meta.status || 2) : 0; // só mensagem minha tem vezinho
  }
  db.get('conversas').find({ jid }).assign(mudar).write();
}
// Atualiza o status de entrega/leitura de uma mensagem minha (2=enviada, 3=entregue, 4/5=lida)
function atualizarStatusMensagem(id, status) {
  const m = db.get('mensagens').find({ id }).value();
  if (m && (m.status || 0) < status) db.get('mensagens').find({ id }).assign({ status }).write();
  const c = db.get('conversas').find({ ultima_id: id }).value();
  if (c && (c.ultima_status || 0) < status) db.get('conversas').find({ jid: c.jid }).assign({ ultima_status: status }).write();
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

// Muitos pares @lid -> número de uma vez (grupos): grava UMA vez só e só mexe em
// conversas/mensagens/status de quem realmente aparece lá.
function unificarLidsEmLote(pares) {
  const conhecidos = new Set(db.get('lids').map('lid').value());
  const novos = pares.filter(([lid]) => !conhecidos.has(lid));
  if (!novos.length) return 0;
  const usados = new Set();
  db.get('conversas').value().forEach((c) => usados.add(c.jid));
  db.get('status').value().forEach((x) => usados.add(x.autor_jid));
  db.get('mensagens').value().forEach((m) => { usados.add(m.conversa_jid); usados.add(m.remetente_jid); });
  const lista = db.get('lids').value();
  for (const [lid, pn] of novos) lista.push({ lid, pn });
  db.write();
  for (const [lid, pn] of novos) if (usados.has(lid)) unificarLid(lid, pn);
  return novos.length;
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

function contarContatosAgenda() {
  return db.get('contatos').filter((c) => !!c.nome_agenda).size().value();
}

function nomeDe(jid) {
  return nomeDoContato(jid) || formatarNumero(jid);
}

// ---- Contatos com aviso de online ----
function listarVigiados() {
  return db.get('vigiados').map('jid').value();
}
function estaVigiado(jid) {
  return !!db.get('vigiados').find({ jid }).value();
}
function definirVigiado(jid, ligar) {
  if (ligar && !estaVigiado(jid)) db.get('vigiados').push({ jid }).write();
  if (!ligar) db.get('vigiados').remove({ jid }).write();
}

// ---- Contatos pra iniciar conversa ----
// Junta os contatos salvos pelo número e os que vieram só com o código interno (@lid),
// sem repetir a mesma pessoa.
function listarContatos() {
  const lids = {};
  db.get('lids').value().forEach((x) => { lids[x.lid] = x.pn; });
  const porJid = {};
  for (const c of db.get('contatos').value()) {
    if (!c.jid || c.jid.endsWith('@g.us')) continue;
    const nome = c.nome_agenda || c.nome_perfil || c.nome;
    if (!nome) continue;
    let jid = c.jid;
    if (jid.endsWith('@lid') && lids[jid]) jid = lids[jid];
    if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
    const atual = porJid[jid];
    const agenda = !!c.nome_agenda;
    if (!atual || (agenda && !atual.agenda)) {
      porJid[jid] = { jid, nome, agenda, numero: jid.endsWith('@lid') ? 'contato do WhatsApp' : formatarNumero(jid) };
    }
  }
  // quem você já conversou, mesmo sem nome salvo, também entra (aparece pelo número)
  for (const cv of db.get('conversas').value()) {
    const jid = cv.jid || '';
    if (!jid.endsWith('@s.whatsapp.net') || porJid[jid]) continue;
    porJid[jid] = { jid, nome: cv.nome || formatarNumero(jid), agenda: false, semNome: !cv.nome, numero: formatarNumero(jid) };
  }
  return Object.values(porJid).sort((a, b) => (b.agenda - a.agenda) || ((a.semNome ? 1 : 0) - (b.semNome ? 1 : 0)) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

function lidsSemNumero() {
  const mapeados = new Set(db.get('lids').map('lid').value());
  return db.get('contatos').filter((c) => c.jid && c.jid.endsWith('@lid') && !mapeados.has(c.jid)).map('jid').value();
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

function obterStatus(id) {
  return db.get('status').find({ id: String(id) }).value() || null;
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
  const silenciados = new Set(db.get('status_silenciados').value());
  return Object.entries(porAutor)
    .map(([jid, itens]) => ({
      autor_jid: jid,
      nome: jid === 'eu' ? 'Meu status' : nomeDoContato(jid) || formatarNumero(jid),
      meu: jid === 'eu',
      silenciado: silenciados.has(jid),
      itens,
      ultimo_ts: itens[itens.length - 1].timestamp,
    }))
    .sort((a, b) => (b.meu - a.meu) || (b.ultimo_ts - a.ultimo_ts));
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
      midia_thumb: msg.midiaThumb || null,
      raw: msg.raw || null,
      duracao: msg.duracao || null,
      nome_arquivo: msg.nomeArquivo || null,
      unica: msg.unica ? 1 : 0,
      status: msg.status != null ? msg.status : (msg.deMim ? 2 : 0),
      citada_id: msg.citadaId || null,
      citada_texto: msg.citadaTexto || null,
      citada_autor: msg.citadaAutor || null,
      dados: msg.dados || null,
    })
    .write();
}
// Reação (emoji) numa mensagem: guarda uma por pessoa; emoji vazio = tirou a reação
function definirReacao(id, quem, emoji) {
  const m = db.get('mensagens').find({ id }).value();
  if (!m) return false;
  const reacoes = Object.assign({}, m.reacoes || {});
  if (emoji) reacoes[quem] = emoji; else delete reacoes[quem];
  db.get('mensagens').find({ id }).assign({ reacoes }).write();
  return true;
}

function obterMensagem(id) {
  return db.get('mensagens').find({ id }).value();
}

function definirMidia(id, midiaPath, mimetype) {
  db.get('mensagens').find({ id }).assign({ midia_path: midiaPath, midia_mimetype: mimetype, raw: null }).write();
}

function midiasDaConversa(jid, limite = 30) {
  return db.get('mensagens')
    .filter((m) => m.conversa_jid === jid && (m.tipo === 'imagem' || m.tipo === 'video') && (m.midia_path || m.midia_thumb))
    .orderBy(['timestamp'], ['desc']).take(limite)
    .map((m) => ({ id: m.id, tipo: m.tipo, midia_path: m.midia_path, midia_thumb: m.midia_thumb }))
    .value();
}

function marcarComoApagada(id) {
  db.get('mensagens')
    .find({ id })
    .assign({ apagada_pelo_remetente: 1, apagada_em: Date.now() })
    .write();
}

function listarMensagens(conversaJid, limite = 300) {
  return db
    .get('mensagens')
    .filter({ conversa_jid: conversaJid })
    .orderBy(['timestamp'], ['asc'])
    .takeRight(limite)
    .map((m) => { const { raw, ...resto } = m; return { ...resto, pode_baixar: !!raw }; })
    .value();
}

// ---- Presença ----
function atualizarPresenca(jid, status, vistoEm) {
  const existente = db.get('presenca').find({ jid }).value();
  const dados = { status, atualizado_em: Date.now() };
  if (vistoEm) dados.visto_em = vistoEm;
  if (existente) {
    db.get('presenca').find({ jid }).assign(dados).write();
  } else {
    db.get('presenca').push({ jid, ...dados }).write();
  }
}

// ---- Conversa: dados, silenciar, recentes ----
function obterConversa(jid) {
  return db.get('conversas').find({ jid }).value();
}
function definirSilenciada(jid, ligar) {
  if (!obterConversa(jid)) upsertConversa({ jid, nome: null, ehGrupo: jid.endsWith('@g.us') });
  db.get('conversas').find({ jid }).assign({ silenciada: !!ligar }).write();
}
function conversasRecentes(n) {
  return db.get('conversas').filter((c) => !c.eh_grupo && c.ultima_mensagem_ts > 0)
    .orderBy(['ultima_mensagem_ts'], ['desc']).take(n).map('jid').value();
}
function nomesDe(jid) {
  const c = db.get('contatos').find({ jid }).value() || {};
  return { agenda: c.nome_agenda || null, perfil: c.nome_perfil || c.nome || null, grupo: c.nome_grupo || null };
}

// ---- Status silenciados ----
function statusSilenciado(jid) {
  return db.get('status_silenciados').includes(jid).value();
}
function definirStatusSilenciado(jid, ligar) {
  if (ligar && !statusSilenciado(jid)) db.get('status_silenciados').push(jid).write();
  if (!ligar) db.get('status_silenciados').pull(jid).write();
}

// ---- Configurações do Zap ----
function obterConfig() {
  return db.get('config').value() || {};
}
function definirConfig(mudancas) {
  db.set('config', { ...obterConfig(), ...mudancas }).write();
  return obterConfig();
}

function obterPresenca(jid) {
  return db.get('presenca').find({ jid }).value();
}

// ---- Chamadas (só o registro: a voz/vídeo acontece no WhatsApp oficial) ----
function registrarChamada(c) {
  const lista = db.get('chamadas');
  const ex = lista.find({ id: c.id }).value();
  if (ex) { lista.find({ id: c.id }).assign(c).write(); return lista.find({ id: c.id }).value(); }
  lista.push({ vista: false, ...c }).write();
  // guarda as 300 mais novas
  const todas = lista.sortBy('ts').value();
  if (todas.length > 300) db.set('chamadas', todas.slice(-300)).write();
  return c;
}
function listarChamadas() {
  return db.get('chamadas').sortBy('ts').reverse().take(300).value().map((c) => ({ ...c, nome: nomeDe(c.de) }));
}
function obterChamada(id) { return db.get('chamadas').find({ id: String(id) }).value() || null; }
function marcarChamadasVistas() { db.get('chamadas').filter({ vista: false }).each((c) => { if (c.status !== 'tocando') c.vista = true; }).value(); db.write(); }
function contarChamadasNovas() { return db.get('chamadas').filter((c) => !c.vista && (c.status === 'perdida' || c.status === 'tocando')).size().value(); }

module.exports = {
  MIDIA_DIR,
  registrarChamada,
  listarChamadas,
  obterChamada,
  marcarChamadasVistas,
  contarChamadasNovas,
  upsertConversa,
  atualizarUltimaMensagem,
  atualizarStatusMensagem,
  definirReacao,
  listarConversas,
  marcarLidas,
  definirNomeContato,
  unificarLidsEmLote,
  limparNomeIgual,
  listarLids,
  unificarLid,
  ultimaMensagem,
  apagarConversa,
  listarContatos,
  obterMensagem,
  definirMidia,
  midiasDaConversa,
  obterConversa,
  definirSilenciada,
  conversasRecentes,
  nomesDe,
  formatarNumero,
  statusSilenciado,
  definirStatusSilenciado,
  obterConfig,
  definirConfig,
  lidsSemNumero,
  contarContatosAgenda,
  nomeDe,
  listarVigiados,
  estaVigiado,
  definirVigiado,
  salvarStatus,
  obterStatus,
  listarStatus,
  salvarMensagem,
  marcarComoApagada,
  listarMensagens,
  atualizarPresenca,
  obterPresenca,
};
