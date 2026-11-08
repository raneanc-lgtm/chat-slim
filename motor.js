// ============================================================
// Chat Slim — Motor de conexão (Baileys)
// ============================================================
// Conecta via protocolo multi-device do WhatsApp (mesmo usado
// pelo WhatsApp Web oficial), captura mensagens, presença e
// eventos de exclusão, salvando tudo via db.js antes de qualquer
// coisa ser removida.
// ============================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent,
  jidNormalizedUser,
  BufferJSON,
  generateWAMessageFromContent,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');

// Mesma lógica do db.js: dentro do APK precisa de diretório gravável.
const BASE_DIR = process.env.NODEJS_MOBILE_APP_STORAGE || __dirname;
const AUTH_DIR = path.join(BASE_DIR, 'auth_info');

let socketAtual = null;
let ultimoQR = null;
let statusConexao = 'desconectado'; // desconectado | aguardando_qr | conectado
let envios = 0; // envios em andamento (a atualização espera zerar pra reiniciar)

// callbacks pra avisar o servidor web de eventos novos (SSE)
const ouvintes = new Set();
function emitir(evento) {
  for (const cb of ouvintes) cb(evento);
}
function onEvento(cb) {
  ouvintes.add(cb);
  return () => ouvintes.delete(cb);
}

function extrairTexto(mensagem) {
  return (
    mensagem.conversation ||
    mensagem.extendedTextMessage?.text ||
    mensagem.imageMessage?.caption ||
    mensagem.videoMessage?.caption ||
    ''
  );
}

function detectarTipo(mensagem) {
  if (mensagem.imageMessage) return 'imagem';
  if (mensagem.videoMessage) return 'video';
  if (mensagem.audioMessage) return 'audio';
  if (mensagem.documentMessage) return 'documento';
  if (mensagem.stickerMessage) return 'sticker';
  if (mensagem.conversation || mensagem.extendedTextMessage) return 'texto';
  return 'outro';
}

const CHAVE_DO_TIPO = {
  imagem: 'imageMessage',
  video: 'videoMessage',
  audio: 'audioMessage',
  sticker: 'stickerMessage',
  documento: 'documentMessage',
};

async function salvarMidiaSeHouver(m, conteudo, tipo) {
  if (!CHAVE_DO_TIPO[tipo]) return { path: null, mimetype: null };
  try {
    const buffer = await downloadMediaMessage(m, 'buffer', {});
    const info = conteudo[CHAVE_DO_TIPO[tipo]] || {};
    const mimetype = info.mimetype || 'application/octet-stream';
    const ext = mimetype.split('/')[1]?.split(';')[0] || 'bin';
    const nomeArquivo = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(db.MIDIA_DIR, nomeArquivo), buffer);
    return { path: nomeArquivo, mimetype };
  } catch (err) {
    console.error('Erro ao baixar mídia:', err.message);
    return { path: null, mimetype: null };
  }
}

// O WhatsApp novo identifica a mesma pessoa de dois jeitos: pelo número (@s.whatsapp.net)
// e por um código interno (@lid). Aqui tudo vira o número, pra não duplicar conversa
// nem perder o nome salvo na agenda.
const mapaLid = new Map(db.listarLids().map((x) => [x.lid, x.pn]));
function normalizar(jid) {
  try {
    return jid && !jid.endsWith('@g.us') ? jidNormalizedUser(jid) : jid;
  } catch (_) {
    return jid;
  }
}
function lembrarLid(lid, pn) {
  lid = normalizar(lid);
  pn = normalizar(pn);
  if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
  if (mapaLid.get(lid) === pn) return;
  mapaLid.set(lid, pn);
  db.unificarLid(lid, pn);
}
async function paraNumero(jid, alt) {
  jid = normalizar(jid);
  if (!jid || !jid.endsWith('@lid')) return jid;
  if (alt && normalizar(alt).endsWith('@s.whatsapp.net')) {
    lembrarLid(jid, alt);
    return normalizar(alt);
  }
  if (mapaLid.has(jid)) return mapaLid.get(jid);
  try {
    const pn = await socketAtual?.signalRepository?.lidMapping?.getPNForLID(jid);
    if (pn) {
      lembrarLid(jid, pn);
      return normalizar(pn);
    }
  } catch (_) {}
  return jid;
}

function ignorarConversa(jid) {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

// nome dos grupos (busca uma vez por grupo)
const gruposConsultados = new Set();
async function garantirNomeDoGrupo(jid) {
  if (!jid.endsWith('@g.us') || gruposConsultados.has(jid) || !socketAtual) return;
  gruposConsultados.add(jid);
  try {
    const meta = await socketAtual.groupMetadata(jid);
    if (meta && meta.subject) {
      db.definirNomeContato(jid, meta.subject);
      emitir({ tipo: 'conversas' });
    }
  } catch (_) {}
}

// Mensagem que é resposta de outra: guarda qual foi citada (pra mostrar o quadrinho em cima)
async function extrairCitacao(conteudo) {
  let ctx = null;
  for (const v of Object.values(conteudo || {})) { if (v && typeof v === 'object' && v.contextInfo) { ctx = v.contextInfo; break; } }
  if (!ctx || !ctx.stanzaId) return {};
  const q = ctx.quotedMessage ? (normalizeMessageContent(ctx.quotedMessage) || ctx.quotedMessage) : null;
  const tipoQ = q ? detectarTipo(q) : 'outro';
  const rotulo = { imagem: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', documento: '📄 Documento', sticker: 'Figurinha' }[tipoQ];
  const local = db.obterMensagem(ctx.stanzaId);
  let autor = local ? (local.de_mim ? 'eu' : local.remetente_jid) : null;
  if (!autor && ctx.participant) { try { autor = await paraNumero(ctx.participant); } catch (_) { autor = ctx.participant; } }
  return {
    citadaId: ctx.stanzaId,
    citadaTexto: ((q && extrairTexto(q)) || rotulo || (local && local.texto) || 'Mensagem').slice(0, 200),
    citadaAutor: autor,
  };
}

async function processarReacao(m, r) {
  if (!r || !r.key || !r.key.id) return;
  let quem;
  if (m.key.fromMe) quem = 'eu';
  else {
    const conv = await paraNumero(m.key.remoteJid, m.key.remoteJidAlt);
    quem = conv.endsWith('@g.us') ? await paraNumero(m.key.participant, m.key.participantAlt) : conv;
  }
  if (db.definirReacao(r.key.id, quem, r.text || '')) {
    const alvo = db.obterMensagem(r.key.id);
    emitir({ tipo: 'reacao', id: r.key.id, conversaJid: alvo ? alvo.conversa_jid : null });
  }
}

// Chave da mensagem no formato do WhatsApp (pra reagir/responder)
function chaveDaMensagem(jid, m) {
  const k = { remoteJid: jid, id: m.id, fromMe: !!m.de_mim };
  if (jid.endsWith('@g.us') && !m.de_mim && m.remetente_jid) k.participant = m.remetente_jid;
  return k;
}

async function reagir(msgId, emoji) {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado no momento');
  const m = db.obterMensagem(msgId);
  if (!m) throw new Error('Mensagem não encontrada');
  await socketAtual.sendMessage(m.conversa_jid, { react: { text: emoji || '', key: chaveDaMensagem(m.conversa_jid, m) } });
  db.definirReacao(msgId, 'eu', emoji || '');
  emitir({ tipo: 'reacao', id: msgId, conversaJid: m.conversa_jid });
}

// Encaminhar uma mensagem (texto ou mídia) pra outra conversa
async function encaminhar(msgId, destino) {
  const m = db.obterMensagem(msgId);
  if (!m) throw new Error('Mensagem não encontrada');
  if (m.tipo === 'texto') return enviarMensagem(destino, m.texto || '');
  let arq = m.midia_path ? path.join(db.MIDIA_DIR, m.midia_path) : null;
  if (!arq || !fs.existsSync(arq)) {
    await baixarMidiaAntiga(msgId);
    const de = db.obterMensagem(msgId);
    arq = de && de.midia_path ? path.join(db.MIDIA_DIR, de.midia_path) : null;
  }
  if (!arq || !fs.existsSync(arq)) throw new Error('A mídia dessa mensagem não está disponível');
  const de = db.obterMensagem(msgId);
  return enviarMidia(destino, { caminhoArquivo: arq, mimetype: de.midia_mimetype || 'application/octet-stream', tipoMensagem: de.tipo, nomeArquivo: de.nome_arquivo, legenda: de.texto || '' });
}

/**
 * Guarda uma mensagem do WhatsApp.
 *   tempoReal = true  → chegou agora (baixa a mídia, conta como não lida, avisa a tela)
 *   tempoReal = false → veio do histórico ao conectar (só registra, sem baixar mídia)
 */
// pega só o nome (perfil) de quem mandou a mensagem — usado no histórico antigo
async function colherNome(m) {
  try {
    if (!m || !m.key || m.key.fromMe || !m.pushName) return;
    const rj = m.key.remoteJid || '';
    if (rj === 'status@broadcast' || rj.endsWith('@newsletter') || rj.endsWith('@broadcast')) return;
    const quem = rj.endsWith('@g.us') ? await paraNumero(m.key.participant, m.key.participantAlt) : await paraNumero(rj, m.key.remoteJidAlt);
    if (quem && !quem.endsWith('@g.us')) db.definirNomeContato(quem, m.pushName, 'perfil');
  } catch (_) {}
}

async function processarMensagem(m, tempoReal) {
  if (!m || !m.key) return;
  // Visualização única: o WhatsApp não entrega o conteúdo pra aparelhos conectados
  // (igual o WhatsApp Web, que manda abrir no celular). Registramos o aviso dela.
  if (!m.message && m.key.isViewOnce) return processarVisualizacaoUnica(m, tempoReal);
  if (!m.message) return;
  if (m.key.remoteJid === 'status@broadcast' || m.broadcast) return processarStatus(m, tempoReal);
  if (ignorarConversa(m.key.remoteJid)) return;

  const conteudo = normalizeMessageContent(m.message) || m.message;
  if (conteudo.reactionMessage) return processarReacao(m, conteudo.reactionMessage);
  if (conteudo.protocolMessage || conteudo.pollUpdateMessage) return;
  const tipo = detectarTipo(conteudo);
  if (tipo === 'outro') return;

  const conversaJid = await paraNumero(m.key.remoteJid, m.key.remoteJidAlt);
  const ehGrupo = conversaJid.endsWith('@g.us');
  const deMim = Boolean(m.key.fromMe);
  const remetenteJid = ehGrupo ? await paraNumero(m.key.participant, m.key.participantAlt) : conversaJid;
  if (ehGrupo && !deMim && remetenteJid && m.pushName) db.definirNomeContato(remetenteJid, m.pushName, 'perfil');
  const texto = extrairTexto(conteudo);
  const timestamp = (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
  const citacao = await extrairCitacao(conteudo);

  const { path: midiaPath, mimetype } = tempoReal
    ? await salvarMidiaSeHouver(m, conteudo, tipo)
    : { path: null, mimetype: (conteudo[CHAVE_DO_TIPO[tipo]] || {}).mimetype || null };
  const extra = guardarExtrasDeMidia(m, conteudo, tipo, midiaPath);

  db.upsertConversa({
    jid: conversaJid,
    // pushName é o nome de quem MANDOU: só serve pra nomear a conversa se não fui eu
    nome: !ehGrupo && !deMim ? m.pushName : null,
    ehGrupo,
    naoLida: tempoReal && !deMim,
  });

  db.salvarMensagem({
    id: m.key.id,
    conversaJid,
    remetenteJid,
    remetenteNome: deMim ? null : m.pushName || null,
    deMim: deMim ? 1 : 0,
    tipo,
    texto,
    midiaPath,
    midiaMimetype: mimetype,
    timestamp,
    ...extra,
    ...citacao,
  });

  db.atualizarUltimaMensagem(conversaJid, texto || `[${tipo}]`, timestamp, { id: m.key.id, deMim, status: Number(m.status) || 0 });
  if (ehGrupo) garantirNomeDoGrupo(conversaJid);

  if (tempoReal) {
    emitir({
      tipo: 'mensagem_nova',
      conversaJid,
      remetenteNome: deMim ? null : m.pushName,
      deMim,
      texto,
      tipoMsg: tipo,
    });
    if (!deMim) notificarMensagem(conversaJid, ehGrupo, remetenteJid, m.pushName, tipo, texto);
  }
}

async function processarVisualizacaoUnica(m, tempoReal) {
  if (ignorarConversa(m.key.remoteJid)) return;
  const conversaJid = await paraNumero(m.key.remoteJid, m.key.remoteJidAlt);
  const ehGrupo = conversaJid.endsWith('@g.us');
  const deMim = Boolean(m.key.fromMe);
  const remetenteJid = ehGrupo ? await paraNumero(m.key.participant, m.key.participantAlt) : conversaJid;
  const timestamp = (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
  db.upsertConversa({ jid: conversaJid, nome: !ehGrupo && !deMim ? m.pushName : null, ehGrupo, naoLida: tempoReal && !deMim });
  db.salvarMensagem({ id: m.key.id, conversaJid, remetenteJid, remetenteNome: deMim ? null : m.pushName || null, deMim: deMim ? 1 : 0, tipo: 'unica', texto: '', midiaPath: null, midiaMimetype: null, timestamp });
  db.atualizarUltimaMensagem(conversaJid, '🔒 Visualização única', timestamp);
  if (tempoReal) {
    emitir({ tipo: 'mensagem_nova', conversaJid, remetenteNome: m.pushName, deMim, texto: '', tipoMsg: 'unica' });
    if (!deMim) notificarMensagem(conversaJid, ehGrupo, remetenteJid, m.pushName, 'unica', '');
  }
}

// Miniatura (capa de vídeo/foto) e os dados pra baixar a mídia depois, se ainda não baixou
function guardarExtrasDeMidia(m, conteudo, tipo, midiaPath) {
  const chave = CHAVE_DO_TIPO[tipo];
  if (!chave) return {};
  const info = conteudo[chave] || {};
  const extra = {};
  if (info.jpegThumbnail && (tipo === 'video' || tipo === 'imagem')) {
    try {
      const nome = 'thumb_' + String(m.key.id).replace(/[^A-Za-z0-9]/g, '') + '.jpg';
      fs.writeFileSync(path.join(db.MIDIA_DIR, nome), Buffer.from(info.jpegThumbnail));
      extra.midiaThumb = nome;
    } catch (_) {}
  }
  if (!midiaPath) {
    try {
      extra.raw = JSON.stringify({ key: m.key, message: m.message }, BufferJSON.replacer);
    } catch (_) {}
  }
  if (info.seconds) extra.duracao = info.seconds;
  if (info.fileName) extra.nomeArquivo = info.fileName;
  return extra;
}

// Baixa agora uma mídia que chegou antes (do histórico)
async function baixarMidiaAntiga(id) {
  const msg = db.obterMensagem(id);
  if (!msg) throw new Error('mensagem não encontrada');
  if (msg.midia_path) return msg.midia_path;
  if (!msg.raw) throw new Error('essa mídia não pode mais ser baixada');
  const m = JSON.parse(msg.raw, BufferJSON.reviver);
  const conteudo = normalizeMessageContent(m.message) || m.message;
  const r = await salvarMidiaSeHouver(m, conteudo, msg.tipo);
  if (!r.path) throw new Error('o WhatsApp não liberou essa mídia (pode ter expirado)');
  db.definirMidia(id, r.path, r.mimetype);
  return r.path;
}

// ---- Notificações (o app mostra no topo da tela) ----
const PREVIA = { imagem: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', documento: '📄 Documento', sticker: 'Figurinha', unica: '🔒 Visualização única' };
let foco = { visivel: false, jid: null, em: 0 }; // o que a pessoa está vendo agora no app
function appVisivel() {
  return foco.visivel && Date.now() - foco.em < 90 * 1000;
}
function notificarMensagem(conversaJid, ehGrupo, remetenteJid, pushName, tipo, texto) {
  const conv = db.obterConversa(conversaJid) || {};
  if (conv.silenciada) return;
  if (appVisivel()) return; // com o app aberto o próprio app avisa
  let previa = PREVIA[tipo] ? PREVIA[tipo] + (texto ? ': ' + texto : '') : texto || '';
  const nomeConv = db.nomeDe(conversaJid);
  if (ehGrupo) previa = (pushName || db.nomeDe(remetenteJid)) + ': ' + previa;
  emitir({ tipo: 'notificar', canal: 'mensagens', jid: conversaJid, titulo: nomeConv, texto: previa.slice(0, 300), naoLidas: conv.nao_lidas || 1 });
}

// Agenda (nome que VOCÊ salvou) vale mais que o nome que a pessoa pôs no perfil
function salvarContatosLista(lista) {
  let mudou = false;
  for (const c of lista || []) {
    if (!c || !c.id) continue;
    if (c.lid && c.phoneNumber) lembrarLid(c.lid, c.phoneNumber);
    else if (c.id.endsWith('@lid') && c.phoneNumber) lembrarLid(c.id, c.phoneNumber);
    else if (c.lid && c.id.endsWith('@s.whatsapp.net')) lembrarLid(c.lid, c.id);
    const alvo = normalizar(c.phoneNumber || mapaLid.get(normalizar(c.id)) || c.id);
    if (c.name) { db.definirNomeContato(alvo, c.name, 'agenda'); mudou = true; }
    const perfil = c.notify || c.verifiedName;
    if (perfil) { db.definirNomeContato(alvo, perfil, 'perfil'); mudou = true; }
  }
  return mudou;
}

// ---- Status (stories): ficam separados das conversas, valem 24h ----
const DIA = 24 * 60 * 60 * 1000;
async function processarStatus(m, tempoReal) {
  if (m.key.fromMe) return; // os seus próprios status ficam no WhatsApp oficial
  const conteudo = normalizeMessageContent(m.message) || m.message;
  if (!conteudo || conteudo.protocolMessage || conteudo.reactionMessage) return;
  const tipo = detectarTipo(conteudo);
  if (tipo === 'outro') return;
  const timestamp = (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
  if (Date.now() - timestamp > DIA) return;
  const autor = await paraNumero(m.key.participant, m.key.participantAlt);
  if (!autor) return;
  if (m.pushName) db.definirNomeContato(autor, m.pushName, 'perfil');

  let midia = { path: null, mimetype: null };
  const info = conteudo[CHAVE_DO_TIPO[tipo]] || {};
  const grande = Number(info.fileLength || 0) > 20 * 1024 * 1024;
  if (CHAVE_DO_TIPO[tipo] && !grande) midia = await salvarMidiaSeHouver(m, conteudo, tipo);

  const fundo = conteudo.extendedTextMessage?.backgroundArgb;
  db.salvarStatus({
    id: m.key.id,
    autor_jid: autor,
    participante: m.key.participant || null,
    tipo,
    texto: extrairTexto(conteudo),
    midia_path: midia.path,
    midia_mimetype: midia.mimetype,
    cor_fundo: fundo ? '#' + (fundo >>> 0).toString(16).padStart(8, '0').slice(2) : null,
    timestamp,
  });
  if (tempoReal) emitir({ tipo: 'status_novo', autor });
}

let historicoCompleto = false;
let geracao = 0, falhasDesktop = 0;
const FLAG_WEB = path.join(BASE_DIR, 'modo-web.flag');

// Começar do zero: sai da conta (se der), apaga só o login e sobe uma conexão nova
// que mostra o código/QR. Conversas, contatos e fotos ficam.
async function resetarConexao(sairDaConta) {
  const velho = socketAtual;
  geracao++;                         // a conexão velha para de mandar qualquer coisa
  if (velho) {
    if (sairDaConta) { try { await Promise.race([velho.logout(), new Promise((r) => setTimeout(r, 6000))]); } catch (_) {} }
    try { velho.end(undefined); } catch (_) {}
    try { velho.ev.removeAllListeners(); } catch (_) {}
  }
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  statusConexao = 'desconectado'; ultimoQR = null;
  emitir({ tipo: 'status', status: 'desconectado' });
  const g = geracao;
  setTimeout(() => { if (g === geracao) iniciar().catch((e) => console.error('iniciar:', e.message)); }, 1200);
  return { ok: true };
}

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // Histórico completo: o celular só manda TUDO (anos de conversas e contatos) na hora de
  // conectar, e só pra quem se apresenta como WhatsApp Desktop. Conexões antigas continuam
  // como estavam; quem conectar de novo pelo código já entra no modo completo.
  const minha = ++geracao;              // cada conexão tem um número; as velhas ficam surdas
  const ativo = () => minha === geracao;
  const flagDesktop = path.join(AUTH_DIR, 'historico-completo.flag');
  if (!state.creds.registered && !fs.existsSync(FLAG_WEB)) { try { fs.mkdirSync(AUTH_DIR, { recursive: true }); fs.writeFileSync(flagDesktop, '1'); } catch (_) {} }
  const desktop = fs.existsSync(flagDesktop);
  let teveQR = false;
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false, // não força seu próprio status online ao conectar
    ...(desktop ? { browser: Browsers.macOS('Desktop'), syncFullHistory: true } : {}),
  });
  historicoCompleto = desktop;

  socketAtual = sock;

  sock.ev.on('connection.update', (update) => {
    if (!ativo()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      teveQR = true; falhasDesktop = 0;
      ultimoQR = qr;
      statusConexao = 'aguardando_qr';
      emitir({ tipo: 'qr', qr });
    }

    if (connection === 'close') {
      const motivo = lastDisconnect?.error?.output?.statusCode;
      console.log('[conexão] fechou, motivo=' + motivo + (desktop ? ' (modo completo)' : ''));
      // modo completo recusado antes de mostrar o código/QR: volta pro modo normal (WhatsApp Web)
      if (desktop && !state.creds.registered && !teveQR && (motivo === 405 || motivo === 403) && ++falhasDesktop >= 2) {
        console.log('[conexão] modo completo recusado, voltando pro modo normal');
        try { fs.writeFileSync(FLAG_WEB, '1'); } catch (_) {}
        falhasDesktop = 0;
        return resetarConexao(false);
      }
      if (motivo === DisconnectReason.loggedOut) return resetarConexao(false);
      statusConexao = 'desconectado';
      emitir({ tipo: 'status', status: 'desconectado' });
      setTimeout(() => { if (ativo()) iniciar(); }, 2000);
    } else if (connection === 'open') {
      statusConexao = 'conectado';
      try {
        const eu = sock.user || {};
        if (eu.lid && eu.id) lembrarLid(eu.lid, eu.id);
        if (eu.name) db.limparNomeIgual(eu.name);
      } catch (_) {}
      // Agenda completa: o WhatsApp só manda na 1ª conexão (e às vezes não dá tempo).
      // Se ainda tem poucos contatos salvos, pede de novo.
      setTimeout(() => {
        if (socketAtual === sock && db.contarContatosAgenda() < 15) sincronizarContatos().catch(() => {});
      }, 15000);
      setTimeout(() => { if (socketAtual === sock) atualizarVigia(); }, 5000);
      ultimoQR = null;
      emitir({ tipo: 'status', status: 'conectado' });
    }
  });

  sock.ev.on('creds.update', (...a) => { if (ativo()) return saveCreds(...a); });

  // ---- Mensagens novas (e as que chegaram enquanto estava desligado) ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      try {
        await processarMensagem(m, type === 'notify');
      } catch (err) {
        console.error('Erro ao processar mensagem:', err.message);
      }
    }
    if (type !== 'notify') emitir({ tipo: 'conversas' });
  });

  // ---- Histórico que o WhatsApp manda ao conectar (conversas, contatos, mensagens recentes) ----
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    try {
      salvarContatosLista(contacts);
      for (const ch of chats || []) {
        if (ignorarConversa(ch.id)) continue;
        const jid = await paraNumero(ch.id, ch.pnJid);
        db.upsertConversa({ jid, nome: null, ehGrupo: jid.endsWith('@g.us') });
        if (ch.name) db.definirNomeContato(jid, ch.name, jid.endsWith('@g.us') ? 'grupo' : 'agenda');
        const ts = Number(ch.conversationTimestamp || 0) * 1000;
        if (ts) db.atualizarUltimaMensagem(jid, null, ts);
      }
      // mensagens antigas (mais de 60 dias) não entram no banco — só aproveitamos o nome de quem mandou
      const corte = Date.now() - 60 * 24 * 60 * 60 * 1000;
      for (const m of messages || []) {
        const ts = (Number(m.messageTimestamp) || 0) * 1000;
        if (ts && ts < corte) { await colherNome(m); continue; }
        await processarMensagem(m, false);
      }
      emitir({ tipo: 'conversas' });
    } catch (err) {
      console.error('Erro no histórico:', err.message);
    }
  });

  // ---- Nomes dos contatos ----
  const salvarContatos = (lista) => {
    if (salvarContatosLista(lista)) emitir({ tipo: 'conversas' });
  };
  sock.ev.on('contacts.upsert', salvarContatos);
  sock.ev.on('contacts.update', salvarContatos);
  sock.ev.on('groups.update', (lista) => {
    for (const g of lista || []) if (g.id && g.subject) db.definirNomeContato(g.id, g.subject, 'grupo');
    emitir({ tipo: 'conversas' });
  });
  sock.ev.on('lid-mapping.update', (lista) => {
    for (const x of [].concat(lista || [])) if (x && x.lid && x.pn) lembrarLid(x.lid, x.pn);
  });

  // ---- Conversa apagada no celular → some daqui também ----
  sock.ev.on('chats.delete', async (jids) => {
    for (const j of jids || []) db.apagarConversa(await paraNumero(j));
    emitir({ tipo: 'conversas' });
  });

  // ---- Exclusão de mensagens (protocol messages) ----
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      // quando a própria mensagem é marcada como "revoked" (apagada pra todos)
      if (u.update?.message === null || u.update?.messageStubType === 'REVOKE' || u.update?.messageStubType === 1) {
        db.marcarComoApagada(u.key.id);
        const jid = mapaLid.get(normalizar(u.key.remoteJid)) || normalizar(u.key.remoteJidAlt) || u.key.remoteJid;
        emitir({ tipo: 'mensagem_apagada', id: u.key.id, conversaJid: jid });
      } else if (u.update && u.update.status != null && u.key.fromMe) {
        const st = Number(u.update.status);
        db.atualizarStatusMensagem(u.key.id, st);
        const jid = mapaLid.get(normalizar(u.key.remoteJid)) || normalizar(u.key.remoteJidAlt) || u.key.remoteJid;
        emitir({ tipo: 'status_msg', id: u.key.id, conversaJid: jid, status: st });
      }
    }
  });

  // ---- Presença (online/offline/digitando) ----
  const timersDigitando = new Map();
  sock.ev.on('presence.update', async ({ id, presences }) => {
    for (const [jidBruto, info] of Object.entries(presences)) {
      const participanteJid = await paraNumero(jidBruto);
      const bruto = info.lastKnownPresence; // available, unavailable, composing, recording, paused
      const mapa = {
        available: 'online',
        unavailable: 'offline',
        composing: 'digitando',
        recording: 'gravando',
        paused: 'online', // parou de digitar: volta pra online, não fica "digitando" pra sempre
      };
      const statusTraduzido = mapa[bruto] || bruto;
      clearTimeout(timersDigitando.get(participanteJid));
      const antes = (db.obterPresenca(participanteJid) || {}).status;
      if (statusTraduzido === 'online' && antes !== 'online' && antes !== 'digitando' && antes !== 'gravando') avisarOnline(participanteJid);
      // visto por último: vem junto quando a pessoa sai (se a privacidade dela deixar)
      let vistoEm = info.lastSeen ? Number(info.lastSeen) * 1000 : null;
      if (!vistoEm && statusTraduzido === 'offline' && (antes === 'online' || antes === 'digitando' || antes === 'gravando')) vistoEm = Date.now();
      db.atualizarPresenca(participanteJid, statusTraduzido, vistoEm);
      emitir({ tipo: 'presenca', jid: participanteJid, status: statusTraduzido, visto_em: vistoEm || (db.obterPresenca(participanteJid) || {}).visto_em || null });
      // digitando/gravando expira sozinho se a pessoa parar e o WhatsApp não avisar a parada
      if (statusTraduzido === 'digitando' || statusTraduzido === 'gravando') {
        timersDigitando.set(participanteJid, setTimeout(() => {
          timersDigitando.delete(participanteJid);
          if (['digitando', 'gravando'].includes((db.obterPresenca(participanteJid) || {}).status)) {
            db.atualizarPresenca(participanteJid, 'online', null);
            emitir({ tipo: 'presenca', jid: participanteJid, status: 'online', visto_em: (db.obterPresenca(participanteJid) || {}).visto_em || null });
          }
        }, 12000));
      }
    }
  });

  return sock;
}

async function enviarMidia(jid, { caminhoArquivo, mimetype, tipoMensagem, nomeArquivo, legenda, unica }) {
  if (!socketAtual || statusConexao !== 'conectado') {
    throw new Error('WhatsApp não está conectado no momento');
  }
  db.upsertConversa({ jid, nome: null, ehGrupo: jid.endsWith('@g.us') });

  envios++;
  try {
  const buffer = fs.readFileSync(caminhoArquivo);
  let conteudo;

  if (tipoMensagem === 'imagem') {
    conteudo = { image: buffer, mimetype, caption: legenda || undefined };
  } else if (tipoMensagem === 'video') {
    conteudo = { video: buffer, mimetype, caption: legenda || undefined };
  } else if (tipoMensagem === 'audio') {
    conteudo = { audio: buffer, mimetype, ptt: true }; // ptt = mensagem de voz (bolinha de áudio)
  } else if (tipoMensagem === 'sticker') {
    conteudo = { sticker: buffer };
  } else {
    conteudo = { document: buffer, mimetype, fileName: nomeArquivo || 'arquivo' };
  }

  // visualização única (foto, vídeo e áudio)
  if (unica && ['imagem', 'video', 'audio'].includes(tipoMensagem)) conteudo.viewOnce = true;
  const resultado = await socketAtual.sendMessage(jid, conteudo);
  if (!resultado?.key?.id) {
    throw new Error('Mídia não foi confirmada pelo servidor do WhatsApp');
  }

  // Copia o arquivo pra pasta de mídia local e salva no histórico
  const ext = (mimetype.split('/')[1] || 'bin').split(';')[0];
  const nomeLocal = `${crypto.randomUUID()}.${ext}`;
  const destinoLocal = path.join(db.MIDIA_DIR, nomeLocal);
  fs.copyFileSync(caminhoArquivo, destinoLocal);

  const timestamp = Date.now();
  db.salvarMensagem({
    id: resultado.key.id,
    conversaJid: jid,
    remetenteJid: jid,
    remetenteNome: null,
    deMim: 1,
    tipo: tipoMensagem,
    texto: legenda || '',
    midiaPath: nomeLocal,
    midiaMimetype: mimetype,
    timestamp,
    unica: !!(unica && ['imagem', 'video', 'audio'].includes(tipoMensagem)),
    status: 2,
  });
  db.atualizarUltimaMensagem(jid, unica ? '🔒 Visualização única' : legenda || `[${tipoMensagem}]`, timestamp, { id: resultado.key.id, deMim: true, status: 2 });
  emitir({ tipo: 'mensagem_nova', conversaJid: jid, texto: legenda, tipoMsg: tipoMensagem });

  return resultado;
  } finally {
    envios--;
  }
}

// Conexão pelo número de telefone (pra quando o WhatsApp está no mesmo celular
// e não dá pra escanear o QR): gera o código de 8 letras que a pessoa digita em
// WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone.
async function pedirCodigoPareamento(numero) {
  if (statusConexao === 'conectado') throw new Error('Já está conectado');
  if (!socketAtual || statusConexao !== 'aguardando_qr') {
    throw new Error('O motor ainda está conectando no WhatsApp. Espera uns segundos e tenta de novo.');
  }
  const codigo = await socketAtual.requestPairingCode(numero);
  if (!codigo) throw new Error('O WhatsApp não devolveu o código. Tenta de novo.');
  const limpo = String(codigo).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return limpo.length === 8 ? `${limpo.slice(0, 4)}-${limpo.slice(4)}` : limpo;
}

// Reconectar no modo histórico completo: sai deste aparelho conectado e volta pra tela do código.
// As conversas e contatos guardados aqui continuam; só o login é refeito.
async function reconectarCompleto() {
  try { fs.rmSync(FLAG_WEB, { force: true }); } catch (_) {}
  return resetarConexao(true);
}

// Pede ao WhatsApp pra avisar quando esse contato ficar online/digitando
async function assinarPresenca(jid) {
  if (!socketAtual || statusConexao !== 'conectado') return;
  try {
    await socketAtual.presenceSubscribe(jid);
  } catch (_) {}
}

// ---- Recuperar o máximo de contatos e gerar um arquivo de agenda (.vcf) ----
// Junta tudo que o WhatsApp entrega: agenda inteira guardada no servidor (snapshot),
// participantes de todos os grupos (pra achar o número de quem vem só com @lid),
// contatos das conversas e do histórico. Depois gera o .vcf pra importar no celular.
async function recuperarContatos(modo) {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado');
  const etapas = [];
  // 1) agenda completa do servidor
  try {
    await socketAtual.authState.keys.set({ 'app-state-sync-version': { critical_unblock_low: null, critical_block: null } });
    await socketAtual.resyncAppState(['critical_block', 'critical_unblock_low'], true);
    etapas.push('agenda do WhatsApp baixada');
  } catch (e) { etapas.push('agenda: ' + e.message); }
  // 2) participantes de todos os grupos
  let grupos = 0;
  try {
    const todos = await socketAtual.groupFetchAllParticipating();
    for (const g of Object.values(todos || {})) {
      grupos++;
      for (const p of g.participants || []) {
        const id = p.id || '';
        const pn = p.phoneNumber || (id.endsWith('@s.whatsapp.net') ? id : null);
        const lid = p.lid || (id.endsWith('@lid') ? id : null);
        if (lid && pn) lembrarLid(lid, pn);
        if (p.notify) db.definirNomeContato(normalizar(pn || id), p.notify, 'perfil');
      }
    }
    etapas.push(grupos + ' grupos conferidos');
  } catch (e) { etapas.push('grupos: ' + e.message); }
  // 3) códigos internos (@lid) -> número de telefone
  let resolvidos = 0;
  for (const lid of db.lidsSemNumero()) {
    try {
      const pn = await socketAtual.signalRepository?.lidMapping?.getPNForLID(lid);
      if (pn) { lembrarLid(lid, pn); resolvidos++; }
    } catch (_) {}
  }
  etapas.push(resolvidos + ' números achados');
  emitir({ tipo: 'conversas' });
  if (modo === 'vcf' || modo === 'vcf-todos') return gerarVcf(modo === 'vcf-todos' ? 'todos' : 'agenda', etapas);
  const lista = db.listarContatos();
  return { total: lista.length, agenda: lista.filter((c) => c.agenda).length, etapas, historicoCompleto };
}

function gerarVcf(modo, etapas) {
  const so = modo === 'todos' ? null : 'agenda';
  const lista = db.listarContatos().filter((c) => c.jid.endsWith('@s.whatsapp.net') && (!so || c.agenda));
  const vistos = new Set();
  const esc = (t) => String(t).replace(/[;\\]/g, ' ').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  const linhas = [];
  for (const c of lista) {
    const num = c.jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!num || num.length < 8 || vistos.has(num)) continue;
    vistos.add(num);
    const nome = (c.nome || '').trim() || '+' + num;
    linhas.push('BEGIN:VCARD', 'VERSION:3.0', 'FN:' + esc(nome), 'N:;' + esc(nome) + ';;;', 'TEL;TYPE=CELL:+' + num, 'END:VCARD');
  }
  const d = new Date();
  const arquivo = 'Contatos_Zap_' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + '.vcf';
  fs.writeFileSync(path.join(db.MIDIA_DIR, arquivo), linhas.join('\r\n') + '\r\n', 'utf8');
  const agenda = db.listarContatos().filter((c) => c.agenda && c.jid.endsWith('@s.whatsapp.net')).length;
  console.log(`Contatos recuperados: ${vistos.size} no arquivo (${modo || 'agenda'}) • ${(etapas || []).join(' • ')}`);
  return { arquivo, total: vistos.size, agenda, conhecidos: db.listarContatos().length, etapas: etapas || [] };
}

// ---- Agenda completa (pede ao WhatsApp a sincronização dos contatos) ----
async function sincronizarContatos() {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado');
  const antes = db.contarContatosAgenda();
  // A agenda fica na coleção "critical_unblock_low". O WhatsApp só manda ela INTEIRA
  // (snapshot) quando a versão local é zero; senão manda só o que mudou. Por isso
  // zeramos a versão antes — igual ao WhatsApp Web quando conecta pela 1ª vez.
  await socketAtual.authState.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
  await socketAtual.resyncAppState(['critical_unblock_low'], true);
  // contatos que vieram só com o código interno (@lid): tenta achar o número
  let resolvidos = 0;
  for (const lid of db.lidsSemNumero()) {
    try {
      const pn = await socketAtual.signalRepository?.lidMapping?.getPNForLID(lid);
      if (pn) { lembrarLid(lid, pn); resolvidos++; }
    } catch (_) {}
  }
  const depois = db.contarContatosAgenda();
  const total = db.listarContatos().length;
  console.log(`Agenda sincronizada: ${antes} → ${depois} com nome da agenda, ${total} pra conversar (${resolvidos} números achados)`);
  emitir({ tipo: 'conversas' });
  if (depois === 0) {
    throw new Error('o WhatsApp não mandou a agenda. Isso acontece quando falta a chave de sincronização: desconecte o Zap em Aparelhos conectados e conecte de novo pelo código');
  }
  return { antes, depois, total };
}

// ---- Foto de perfil (guardada no aparelho por 1 dia) ----
const fotosSemFoto = new Map(); // jid -> quando conferiu (pra não perguntar toda hora)
const FOTOS_DIR = path.join(db.MIDIA_DIR, 'fotos');
let fotosEmAndamento = 0;
async function fotoDePerfil(jid) {
  const arq = path.join(FOTOS_DIR, jid.replace(/[^0-9a-zA-Z@._-]/g, '_') + '.jpg');
  try {
    const st = fs.statSync(arq);
    if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) return 'fotos/' + path.basename(arq) + '?v=' + Math.floor(st.mtimeMs);
  } catch (_) {}
  const sem = fotosSemFoto.get(jid);
  if (sem && Date.now() - sem < 6 * 3600 * 1000) return null;
  if (!socketAtual || statusConexao !== 'conectado' || fotosEmAndamento >= 3) return null;
  fotosEmAndamento++;
  try {
    const url = await socketAtual.profilePictureUrl(jid, 'preview', 8000).catch(() => null);
    if (!url) {
      fotosSemFoto.set(jid, Date.now());
      return null;
    }
    const r = await fetch(url);
    if (!r.ok) return null;
    fs.mkdirSync(FOTOS_DIR, { recursive: true });
    fs.writeFileSync(arq, Buffer.from(await r.arrayBuffer()));
    return 'fotos/' + path.basename(arq) + '?v=' + Date.now();
  } catch (_) {
    return null;
  } finally {
    fotosEmAndamento--;
  }
}

// ---- Aviso quando um contato escolhido fica online ----
// O WhatsApp só conta pra você quem está online se você também estiver visível,
// então, enquanto houver alguém na lista de aviso, o motor fica "disponível".
const ultimoAvisoOnline = new Map();
function avisarOnline(jid) {
  // Online agora é nativo pra todos: aparece o pontinho verde na lista e na conversa,
  // sem pop-up de notificação (seria um aviso por contato, viraria spam).
}
let vigiaTimer = null;
// Online: aparece online enquanto você está usando o Zap (igual WhatsApp Web) ou
// enquanto houver contato com aviso de online — a menos que "esconder meu online" esteja ligado.
// (Regra do WhatsApp: escondendo o seu, você também não vê o online dos outros.)
async function atualizarVigia() {
  clearTimeout(vigiaTimer);
  if (!socketAtual || statusConexao !== 'conectado') return;
  const cfg = db.obterConfig();
  // Online nativo pra todos: enquanto o Zap está aberto, fico disponível e assino a presença
  // de TODAS as conversas recentes (sem precisar escolher ninguém). "Esconder meu online" desliga.
  const disponivel = !cfg.esconder_online && appVisivel();
  try {
    await socketAtual.sendPresenceUpdate(disponivel ? 'available' : 'unavailable');
    if (disponivel) {
      const alvos = new Set(db.conversasRecentes(150));
      if (foco.jid && !foco.jid.endsWith('@g.us')) alvos.add(foco.jid);
      for (const j of alvos) await socketAtual.presenceSubscribe(j).catch(() => {});
    }
  } catch (_) {}
  if (appVisivel()) vigiaTimer = setTimeout(atualizarVigia, 2 * 60 * 1000);
}
let focoTimer = null;
function definirFoco(visivel, jid) {
  const mudou = visivel !== foco.visivel || jid !== foco.jid;
  foco = { visivel: !!visivel, jid: jid || null, em: Date.now() };
  if (foco.jid && visivel) db.marcarLidas(foco.jid);
  if (mudou) atualizarVigia();
  clearTimeout(focoTimer);
  if (visivel) focoTimer = setTimeout(() => atualizarVigia(), 95 * 1000); // se o app parar de avisar, volta a ficar escondido
  return { ok: true };
}
function definirVigia(jid, ligar) {
  db.definirVigiado(jid, ligar);
  atualizarVigia();
  return { vigiados: db.listarVigiados() };
}

// ---- Perfil do contato / grupo ----
async function perfil(jid) {
  const ehGrupo = jid.endsWith('@g.us');
  const conv = db.obterConversa(jid) || {};
  const pres = db.obterPresenca(jid) || {};
  const r = {
    jid,
    nome: db.nomeDe(jid),
    nomes: db.nomesDe(jid),
    numero: ehGrupo || jid.endsWith('@lid') ? null : db.formatarNumero(jid),
    grupo: ehGrupo,
    silenciada: !!conv.silenciada,
    vigiado: db.estaVigiado(jid),
    status_silenciado: db.statusSilenciado(jid),
    presenca: { status: pres.status || null, visto_em: pres.visto_em || null },
    foto: await fotoDePerfil(jid),
    midias: db.midiasDaConversa(jid, 30),
  };
  if (socketAtual && statusConexao === 'conectado') {
    if (ehGrupo) {
      try {
        const meta = await socketAtual.groupMetadata(jid);
        r.assunto = meta.subject;
        r.descricao = meta.desc || '';
        r.participantes = [];
        for (const p of meta.participants || []) {
          const pj = await paraNumero(p.id, p.phoneNumber || p.jid);
          r.participantes.push({ jid: pj, nome: db.nomeDe(pj), admin: p.admin || null });
        }
      } catch (_) {}
    } else {
      try {
        const [st] = (await socketAtual.fetchStatus(jid)) || [];
        const info = st && st.status;
        if (info && typeof info === 'object') {
          r.recado = info.status || '';
          r.recado_em = info.setAt ? new Date(info.setAt).getTime() : null;
        } else if (typeof info === 'string') r.recado = info;
      } catch (_) {}
      socketAtual.presenceSubscribe(jid).catch(() => {});
    }
  }
  return r;
}

// Foto de perfil em alta qualidade (pra ver grande e salvar)
async function fotoHD(jid) {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado');
  const url = await socketAtual.profilePictureUrl(jid, 'image', 15000).catch(() => null);
  if (!url) throw new Error('essa pessoa não tem foto (ou esconde a foto de você)');
  const r = await fetch(url);
  if (!r.ok) throw new Error('não consegui baixar a foto');
  fs.mkdirSync(FOTOS_DIR, { recursive: true });
  const nome = 'hd_' + jid.replace(/[^0-9a-zA-Z@._-]/g, '_') + '.jpg';
  fs.writeFileSync(path.join(FOTOS_DIR, nome), Buffer.from(await r.arrayBuffer()));
  return 'fotos/' + nome + '?v=' + Date.now();
}

function silenciarConversa(jid, ligar) {
  db.definirSilenciada(jid, ligar);
  emitir({ tipo: 'conversas' });
  return { ok: true };
}
function silenciarStatus(jid, ligar) {
  db.definirStatusSilenciado(jid, ligar);
  return { ok: true };
}

// ---- Postar status ----
function destinatariosDoStatus() {
  const lista = db.listarContatos().map((c) => c.jid).filter((j) => j.endsWith('@s.whatsapp.net'));
  const eu = socketAtual?.user?.id ? jidNormalizedUser(socketAtual.user.id) : null;
  if (eu && !lista.includes(eu)) lista.push(eu);
  if (lista.length < 2) throw new Error('sincronize os contatos antes de postar status (o WhatsApp precisa saber pra quem mostrar)');
  return lista;
}
const corArgb = (hex) => (0xff000000 | parseInt(String(hex || '#000000').replace('#', '').slice(0, 6), 16)) >>> 0;

async function postarStatusTexto({ texto, fundo, cor, fonte }) {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado');
  if (!texto || !String(texto).trim()) throw new Error('escreva alguma coisa');
  const statusJidList = destinatariosDoStatus();
  const msg = generateWAMessageFromContent('status@broadcast', {
    extendedTextMessage: {
      text: String(texto),
      backgroundArgb: corArgb(fundo || '#1f6a45'),
      textArgb: corArgb(cor || '#ffffff'),
      font: Number(fonte) || 0,
    },
  }, { userJid: socketAtual.user.id });
  await socketAtual.relayMessage('status@broadcast', msg.message, { messageId: msg.key.id, statusJidList });
  db.salvarStatus({ id: msg.key.id, autor_jid: 'eu', tipo: 'texto', texto: String(texto), cor_fundo: fundo, cor_texto: cor, fonte: Number(fonte) || 0, midia_path: null, timestamp: Date.now() });
  emitir({ tipo: 'status_novo', autor: 'eu' });
  return { ok: true, destinatarios: statusJidList.length };
}

async function postarStatusMidia({ caminhoArquivo, mimetype, legenda }) {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado');
  const statusJidList = destinatariosDoStatus();
  const buffer = fs.readFileSync(caminhoArquivo);
  const ehVideo = String(mimetype).startsWith('video/');
  const conteudo = ehVideo ? { video: buffer, mimetype, caption: legenda || undefined } : { image: buffer, mimetype, caption: legenda || undefined };
  envios++;
  try {
    const r = await socketAtual.sendMessage('status@broadcast', conteudo, { statusJidList, broadcast: true });
    const ext = (mimetype.split('/')[1] || 'bin').split(';')[0];
    const nome = `${crypto.randomUUID()}.${ext}`;
    fs.copyFileSync(caminhoArquivo, path.join(db.MIDIA_DIR, nome));
    db.salvarStatus({ id: r.key.id, autor_jid: 'eu', tipo: ehVideo ? 'video' : 'imagem', texto: legenda || '', midia_path: nome, midia_mimetype: mimetype, timestamp: Date.now() });
    emitir({ tipo: 'status_novo', autor: 'eu' });
    return { ok: true, destinatarios: statusJidList.length };
  } finally {
    envios--;
  }
}

// Confere se um número tem WhatsApp (pra iniciar conversa nova)
async function verificarNumero(numero) {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado');
  const [r] = (await socketAtual.onWhatsApp(numero)) || [];
  if (!r || !r.exists) return { existe: false };
  const jid = await paraNumero(r.jid, r.jid);
  return { existe: true, jid: jid.endsWith('@lid') ? numero + '@s.whatsapp.net' : jid };
}

async function apagarConversa(jid) {
  const ult = db.ultimaMensagem(jid);
  let noWhatsApp = false;
  let erro = null;
  if (socketAtual && statusConexao === 'conectado') {
    try {
      const lastMessages = ult
        ? [{
            key: {
              remoteJid: jid,
              id: ult.id,
              fromMe: !!ult.de_mim,
              participant: jid.endsWith('@g.us') && !ult.de_mim ? ult.remetente_jid : undefined,
            },
            messageTimestamp: Math.floor(ult.timestamp / 1000),
          }]
        : [];
      await socketAtual.chatModify({ delete: true, lastMessages }, jid);
      noWhatsApp = true;
    } catch (e) {
      erro = e.message;
      console.error('Não apagou no WhatsApp:', e.message);
    }
  }
  db.apagarConversa(jid);
  emitir({ tipo: 'conversas' });
  return { noWhatsApp, erro };
}

// Responder / reagir ao status de alguém: vai pro privado da pessoa citando o status
// (é assim que o WhatsApp faz: a resposta e as reações rápidas aparecem no chat "respondendo ao status")
async function responderStatus(statusId, texto) {
  if (!socketAtual || statusConexao !== 'conectado') throw new Error('WhatsApp não está conectado no momento');
  const st = db.obterStatus(statusId);
  if (!st || st.autor_jid === 'eu') throw new Error('Status não encontrado');
  texto = String(texto || '').trim();
  if (!texto) throw new Error('Mensagem vazia');
  const jid = st.autor_jid;
  const rot = { imagem: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio' }[st.tipo];
  const resumo = st.texto || rot || 'Status';
  const quotedMsg = st.tipo === 'imagem' ? { imageMessage: { caption: st.texto || '' } }
    : st.tipo === 'video' ? { videoMessage: { caption: st.texto || '' } }
    : { extendedTextMessage: { text: st.texto || '' } };
  const quoted = { key: { remoteJid: 'status@broadcast', id: st.id, fromMe: false, participant: st.participante || jid }, message: quotedMsg };
  db.upsertConversa({ jid, nome: null, ehGrupo: false });
  const resultado = await socketAtual.sendMessage(jid, { text: texto }, { quoted });
  if (!resultado?.key?.id) throw new Error('Mensagem não foi confirmada pelo servidor do WhatsApp');
  const timestamp = Date.now();
  db.salvarMensagem({
    id: resultado.key.id, conversaJid: jid, remetenteJid: jid, remetenteNome: null, deMim: 1, tipo: 'texto', texto,
    midiaPath: null, midiaMimetype: null, timestamp, status: 2,
    citadaId: null, citadaTexto: ('Status · ' + resumo).slice(0, 200), citadaAutor: jid,
  });
  db.atualizarUltimaMensagem(jid, texto, timestamp, { id: resultado.key.id, deMim: true, status: 2 });
  emitir({ tipo: 'mensagem_nova', conversaJid: jid, texto, tipoMsg: 'texto' });
  return { ok: true };
}

async function enviarMensagem(jid, texto, citadaId) {
  if (!socketAtual || statusConexao !== 'conectado') {
    throw new Error('WhatsApp não está conectado no momento');
  }
  db.upsertConversa({ jid, nome: null, ehGrupo: jid.endsWith('@g.us') }); // conversa nova (iniciada por mim)
  const citada = citadaId ? db.obterMensagem(citadaId) : null;
  const opcoes = {};
  if (citada) {
    const rot = { imagem: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', documento: '📄 Documento', sticker: 'Figurinha' }[citada.tipo];
    opcoes.quoted = { key: chaveDaMensagem(jid, citada), message: { conversation: citada.texto || rot || '' } };
  }
  const resultado = await socketAtual.sendMessage(jid, { text: texto }, opcoes);
  if (!resultado?.key?.id) {
    throw new Error('Mensagem não foi confirmada pelo servidor do WhatsApp');
  }

  // Salva localmente na hora, sem esperar o eco do messages.upsert —
  // garante que a mensagem aparece na tela imediatamente.
  const timestamp = Date.now();
  db.salvarMensagem({
    id: resultado.key.id,
    conversaJid: jid,
    remetenteJid: jid,
    remetenteNome: null,
    deMim: 1,
    tipo: 'texto',
    texto,
    midiaPath: null,
    midiaMimetype: null,
    timestamp,
    status: 2,
    citadaId: citada ? citada.id : null,
    citadaTexto: citada ? (citada.texto || '[' + citada.tipo + ']').slice(0, 200) : null,
    citadaAutor: citada ? (citada.de_mim ? 'eu' : citada.remetente_jid) : null,
  });
  db.atualizarUltimaMensagem(jid, texto, timestamp, { id: resultado.key.id, deMim: true, status: 2 });
  emitir({ tipo: 'mensagem_nova', conversaJid: jid, texto, tipoMsg: 'texto' });

  return resultado;
}

module.exports = {
  recuperarContatos,
  reconectarCompleto,
  resetarConexao,
  getHistoricoCompleto: () => historicoCompleto,
  gerarVcf,
  responderStatus,
  reagir,
  encaminhar,
  iniciar,
  onEvento,
  enviarMensagem,
  enviarMidia,
  pedirCodigoPareamento,
  assinarPresenca,
  apagarConversa,
  verificarNumero,
  sincronizarContatos,
  fotoDePerfil,
  definirVigia,
  definirFoco,
  reaplicarOnline: () => atualizarVigia(),
  perfil,
  fotoHD,
  silenciarConversa,
  silenciarStatus,
  postarStatusTexto,
  postarStatusMidia,
  baixarMidiaAntiga,
  enviosEmAndamento: () => envios,
  _processarMensagem: processarMensagem, // usado nos testes
  getStatus: () => statusConexao,
  getQR: () => ultimoQR,
};
