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
  if (!m || !m.message || !m.key) return;
  const conversaJid = m.key.remoteJid;
  if (ignorarConversa(conversaJid)) return;

  const conteudo = normalizeMessageContent(m.message) || m.message;
  if (conteudo.protocolMessage || conteudo.reactionMessage || conteudo.pollUpdateMessage) return;
  const tipo = detectarTipo(conteudo);
  if (tipo === 'outro') return;

  const ehGrupo = conversaJid.endsWith('@g.us');
  const deMim = Boolean(m.key.fromMe);
  const remetenteJid = ehGrupo ? m.key.participant : conversaJid;
  const texto = extrairTexto(conteudo);
  const timestamp = (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

  const { path: midiaPath, mimetype } = tempoReal
    ? await salvarMidiaSeHouver(m, conteudo, tipo)
    : { path: null, mimetype: (conteudo[CHAVE_DO_TIPO[tipo]] || {}).mimetype || null };

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
  }
}

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false, // não força seu próprio status online ao conectar
  });

  socketAtual = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

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
      if (deveReconectar) {
        setTimeout(iniciar, 2000);
      }
    } else if (connection === 'open') {
      statusConexao = 'conectado';
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
      for (const c of contacts || []) {
        const nome = c.name || c.notify || c.verifiedName;
        if (c.id && nome) db.definirNomeContato(c.id, nome);
      }
      for (const ch of chats || []) {
        if (ignorarConversa(ch.id)) continue;
        db.upsertConversa({ jid: ch.id, nome: null, ehGrupo: ch.id.endsWith('@g.us') });
        if (ch.name) db.definirNomeContato(ch.id, ch.name);
        const ts = Number(ch.conversationTimestamp || 0) * 1000;
        if (ts) db.atualizarUltimaMensagem(ch.id, null, ts);
      }
      for (const m of messages || []) await processarMensagem(m, false);
      emitir({ tipo: 'conversas' });
    } catch (err) {
      console.error('Erro no histórico:', err.message);
    }
  });

  // ---- Nomes dos contatos (agenda do celular / nome do perfil) ----
  const salvarContatos = (lista) => {
    let mudou = false;
    for (const c of lista || []) {
      const nome = c.name || c.notify || c.verifiedName;
      if (c.id && nome) {
        db.definirNomeContato(c.id, nome);
        mudou = true;
      }
    }
    if (mudou) emitir({ tipo: 'conversas' });
  };
  sock.ev.on('contacts.upsert', salvarContatos);
  sock.ev.on('contacts.update', salvarContatos);
  sock.ev.on('groups.update', (lista) => {
    for (const g of lista || []) if (g.id && g.subject) db.definirNomeContato(g.id, g.subject);
    emitir({ tipo: 'conversas' });
  });

  // ---- Exclusão de mensagens (protocol messages) ----
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      // quando a própria mensagem é marcada como "revoked" (apagada pra todos)
      if (u.update?.message === null || u.update?.messageStubType === 'REVOKE') {
        db.marcarComoApagada(u.key.id);
        emitir({ tipo: 'mensagem_apagada', id: u.key.id, conversaJid: u.key.remoteJid });
      }
    }
  });

  // ---- Presença (online/offline/digitando) ----
  sock.ev.on('presence.update', ({ id, presences }) => {
    for (const [participanteJid, info] of Object.entries(presences)) {
      const status = info.lastKnownPresence; // available, unavailable, composing, recording
      const mapa = {
        available: 'online',
        unavailable: 'offline',
        composing: 'digitando',
        recording: 'gravando',
      };
      const statusTraduzido = mapa[status] || status;
      db.atualizarPresenca(participanteJid, statusTraduzido);
      emitir({ tipo: 'presenca', jid: participanteJid, status: statusTraduzido });
    }
  });

  return sock;
}

async function enviarMidia(jid, { caminhoArquivo, mimetype, tipoMensagem, nomeArquivo, legenda }) {
  if (!socketAtual || statusConexao !== 'conectado') {
    throw new Error('WhatsApp não está conectado no momento');
  }

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
  });
  db.atualizarUltimaMensagem(jid, legenda || `[${tipoMensagem}]`, timestamp);
  emitir({ tipo: 'mensagem_nova', conversaJid: jid, texto: legenda, tipoMsg: tipoMensagem });

  return resultado;
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

async function enviarMensagem(jid, texto) {
  if (!socketAtual || statusConexao !== 'conectado') {
    throw new Error('WhatsApp não está conectado no momento');
  }
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

module.exports = {
  iniciar,
  onEvento,
  enviarMensagem,
  enviarMidia,
  pedirCodigoPareamento,
  assinarPresenca,
  _processarMensagem: processarMensagem, // usado nos testes
  getStatus: () => statusConexao,
  getQR: () => ultimoQR,
};
