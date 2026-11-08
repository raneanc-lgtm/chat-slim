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

/**
 * Guarda uma mensagem do WhatsApp.
 *   tempoReal = true  → chegou agora (baixa a mídia, conta como não lida, avisa a tela)
 *   tempoReal = false → veio do histórico ao conectar (só registra, sem baixar mídia)
 */
async function processarMensagem(m, tempoReal) {
  if (!m || !m.key) return;
  // Visualização única: o WhatsApp não entrega o conteúdo pra aparelhos conectados
  // (igual o WhatsApp Web, que manda abrir no celular). Registramos o aviso dela.
  if (!m.message && m.key.isViewOnce) return processarVisualizacaoUnica(m, tempoReal);
  if (!m.message) return;
  if (m.key.remoteJid === 'status@broadcast' || m.broadcast) return processarStatus(m, tempoReal);
  if (ignorarConversa(m.key.remoteJid)) return;

  const conteudo = normalizeMessageContent(m.message) || m.message;
  if (conteudo.protocolMessage || conteudo.reactionMessage || conteudo.pollUpdateMessage) return;
  const tipo = detectarTipo(conteudo);
  const embrulho = m.message || {};
  const ehUnica = !!(embrulho.viewOnceMessage || embrulho.viewOnceMessageV2 || embrulho.viewOnceMessageV2Extension ||
    (conteudo[CHAVE_DO_TIPO[tipo]] || {}).viewOnce);
  if (tipo === 'outro') return;

  const conversaJid = await paraNumero(m.key.remoteJid, m.key.remoteJidAlt);
  const ehGrupo = conversaJid.endsWith('@g.us');
  const deMim = Boolean(m.key.fromMe);
  const remetenteJid = ehGrupo ? await paraNumero(m.key.participant, m.key.participantAlt) : conversaJid;
  if (ehGrupo && !deMim && remetenteJid && m.pushName) db.definirNomeContato(remetenteJid, m.pushName, 'perfil');
  const texto = extrairTexto(conteudo);
  const timestamp = (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

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
    unica: ehUnica,
  });

  db.atualizarUltimaMensagem(conversaJid, texto || `[${tipo}]`, timestamp);
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
    tipo,
    texto: extrairTexto(conteudo),
    midia_path: midia.path,
    midia_mimetype: midia.mimetype,
    cor_fundo: fundo ? '#' + (fundo >>> 0).toString(16).padStart(8, '0').slice(2) : null,
    timestamp,
  });
  if (tempoReal) emitir({ tipo: 'status_novo', autor });
}

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // enquanto não está conectado, guarda no motor.log o que o WhatsApp responde (pra achar erro de pareamento)
    logger: state.creds.registered ? pino({ level: 'silent' })
      : pino({ level: 'info' }, { write: (l) => { try { const o = JSON.parse(l); console.log('[wa]', o.msg || '', JSON.stringify(o).slice(0, 400)); } catch (_) { console.log('[wa]', String(l).slice(0, 400)); } } }),
    printQRInTerminal: false,
    // modo celular: conecta como celular Android adicional (igual GB/OG em modo aparelho
    // conectado), que é o tipo de aparelho pra quem o WhatsApp entrega a visualização única
    browser: db.obterConfig().modo_celular ? ['Chat Slim', 'ANDROID_PHONE', ''] : Browsers.macOS('Chrome'),
    // no modo celular o QR é escaneado de outra tela: cada QR dura 90s (normal é 20s)
    qrTimeout: db.obterConfig().modo_celular ? 90000 : undefined,
    markOnlineOnConnect: false, // não força seu próprio status online ao conectar
  });

  socketAtual = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection || lastDisconnect) {
      const e = lastDisconnect && lastDisconnect.error;
      console.log('[conexão]', connection || '', e ? 'motivo=' + (e.output && e.output.statusCode) + ' ' + (e.message || '') : '',
        update.isNewLogin ? 'novo login' : '', 'modo=' + (db.obterConfig().modo_celular ? 'celular' : 'computador'));
    }

    if (qr) {
      ultimoQR = qr;
      statusConexao = 'aguardando_qr';
      emitir({ tipo: 'qr', qr });
    }

    if (connection === 'close') {
      const motivo = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = motivo !== DisconnectReason.loggedOut;
      statusConexao = 'desconectado';
      emitir({ tipo: 'status', status: 'desconectado' });
      if (socketAtual !== sock) return; // trocando de modo: quem reinicia é a troca
      if (deveReconectar) {
        setTimeout(iniciar, 2000);
      } else {
        // desconectado pelo celular: limpa a sessão e volta pra tela de conectar
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        setTimeout(iniciar, 2000);
      }
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

  sock.ev.on('creds.update', saveCreds);

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
      for (const m of messages || []) await processarMensagem(m, false);
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
      }
    }
  });

  // ---- Presença (online/offline/digitando) ----
  sock.ev.on('presence.update', async ({ id, presences }) => {
    for (const [jidBruto, info] of Object.entries(presences)) {
      const participanteJid = await paraNumero(jidBruto);
      const status = info.lastKnownPresence; // available, unavailable, composing, recording
      const mapa = {
        available: 'online',
        unavailable: 'offline',
        composing: 'digitando',
        recording: 'gravando',
      };
      const statusTraduzido = mapa[status] || status;
      const antes = (db.obterPresenca(participanteJid) || {}).status;
      if (statusTraduzido === 'online' && antes !== 'online' && antes !== 'digitando' && antes !== 'gravando') avisarOnline(participanteJid);
      // visto por último: vem junto quando a pessoa sai (se a privacidade dela deixar)
      let vistoEm = info.lastSeen ? Number(info.lastSeen) * 1000 : null;
      if (!vistoEm && statusTraduzido === 'offline' && (antes === 'online' || antes === 'digitando' || antes === 'gravando')) vistoEm = Date.now();
      db.atualizarPresenca(participanteJid, statusTraduzido, vistoEm);
      emitir({ tipo: 'presenca', jid: participanteJid, status: statusTraduzido, visto_em: vistoEm || (db.obterPresenca(participanteJid) || {}).visto_em || null });
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
  });
  db.atualizarUltimaMensagem(jid, unica ? '🔒 Visualização única' : legenda || `[${tipoMensagem}]`, timestamp);
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

// Pede ao WhatsApp pra avisar quando esse contato ficar online/digitando
async function assinarPresenca(jid) {
  if (!socketAtual || statusConexao !== 'conectado') return;
  try {
    await socketAtual.presenceSubscribe(jid);
  } catch (_) {}
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
  if (!db.estaVigiado(jid)) return;
  const ult = ultimoAvisoOnline.get(jid) || 0;
  if (Date.now() - ult < 10 * 60 * 1000) return; // no máximo 1 aviso a cada 10 min por pessoa
  ultimoAvisoOnline.set(jid, Date.now());
  const nome = db.nomeDe(jid);
  console.log('Online agora:', nome);
  emitir({ tipo: 'alerta_online', jid, nome });
  emitir({ tipo: 'notificar', canal: 'online', jid, titulo: nome, texto: '🟢 está online agora' });
}
let vigiaTimer = null;
// Online: aparece online enquanto você está usando o Zap (igual WhatsApp Web) ou
// enquanto houver contato com aviso de online — a menos que "esconder meu online" esteja ligado.
// (Regra do WhatsApp: escondendo o seu, você também não vê o online dos outros.)
async function atualizarVigia() {
  clearTimeout(vigiaTimer);
  if (!socketAtual || statusConexao !== 'conectado') return;
  const lista = db.listarVigiados();
  const cfg = db.obterConfig();
  const disponivel = !cfg.esconder_online && (appVisivel() || lista.length > 0);
  try {
    await socketAtual.sendPresenceUpdate(disponivel ? 'available' : 'unavailable');
    const alvos = new Set(lista);
    if (appVisivel()) db.conversasRecentes(40).forEach((j) => alvos.add(j));
    if (foco.jid && !foco.jid.endsWith('@g.us')) alvos.add(foco.jid);
    for (const j of alvos) await socketAtual.presenceSubscribe(j).catch(() => {});
  } catch (_) {}
  if (lista.length || appVisivel()) vigiaTimer = setTimeout(atualizarVigia, appVisivel() ? 2 * 60 * 1000 : 4 * 60 * 1000);
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

async function enviarMensagem(jid, texto) {
  if (!socketAtual || statusConexao !== 'conectado') {
    throw new Error('WhatsApp não está conectado no momento');
  }
  db.upsertConversa({ jid, nome: null, ehGrupo: jid.endsWith('@g.us') }); // conversa nova (iniciada por mim)
  const resultado = await socketAtual.sendMessage(jid, { text: texto });
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
  });
  db.atualizarUltimaMensagem(jid, texto, timestamp);
  emitir({ tipo: 'mensagem_nova', conversaJid: jid, texto, tipoMsg: 'texto' });

  return resultado;
}

// Troca entre "computador" (igual WhatsApp Web) e "celular adicional" (recebe visualização única).
// Precisa conectar de novo: desconecta, apaga a sessão e mostra a tela de conectar.
async function trocarModoAparelho(celular) {
  console.log('[conexão] trocando para modo', celular ? 'celular' : 'computador');
  db.definirConfig({ modo_celular: !!celular });
  const antigo = socketAtual;
  socketAtual = null;
  statusConexao = 'desconectado';
  ultimoQR = null;
  emitir({ tipo: 'status', status: 'desconectado' });
  if (antigo) {
    // o socket velho não pode regravar a sessão depois que ela for apagada
    try { antigo.ev.removeAllListeners('creds.update'); } catch (_) {}
    try { await Promise.race([antigo.logout(), new Promise((r) => setTimeout(r, 5000))]); } catch (e) { console.log('[conexão] logout:', e.message); }
    try { antigo.end(undefined); } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, 1000));
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { console.log('[conexão] apagar sessão:', e.message); }
  setTimeout(() => {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
    iniciar().catch((e) => console.log('[conexão] iniciar:', e.message));
  }, 1000);
  return { ok: true, modo_celular: !!celular };
}

module.exports = {
  trocarModoAparelho,
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
