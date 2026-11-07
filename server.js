// ============================================================
// Chat Slim — Servidor local (API + interface web)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const qrcode = require('qrcode');

const motor = require('./motor');
const { webmParaOgg, ehWebm } = require('./audio-ogg');
const db = require('./db');

const app = express();
const PORTA = Number(process.env.CHATSLIM_PORTA) || 3000;

const BASE_DIR_GRAVAVEL = process.env.NODEJS_MOBILE_APP_STORAGE || __dirname;
const UPLOAD_TEMP_DIR = path.join(BASE_DIR_GRAVAVEL, 'dados', 'upload_temp');
if (!fs.existsSync(UPLOAD_TEMP_DIR)) fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_TEMP_DIR, limits: { fileSize: 64 * 1024 * 1024 } }); // até 64MB

app.use(express.json());

// ---- Segurança do servidor local ----
// Só a página do próprio app (e a do Radinho, que embute o Chat Slim) pode ler/usar a API.
// Todo comando que muda algo (enviar mensagem, mídia, pareamento) exige o cabeçalho
// X-ChatSlim: isso obriga o navegador a pedir permissão antes, e sites de fora não ganham.
const ORIGENS_PERMITIDAS = new Set(['https://appassets.androidplatform.net']);
app.use((req, res, next) => {
  const origem = req.headers.origin;
  if (origem && ORIGENS_PERMITIDAS.has(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ChatSlim');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origem && ORIGENS_PERMITIDAS.has(origem) ? 204 : 403);
  if (req.method === 'POST' && req.headers['x-chatslim'] !== '1') {
    return res.status(403).json({ erro: 'Pedido recusado' });
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/midia', express.static(db.MIDIA_DIR));

function detectarTipoPorMimetype(mimetype) {
  if (mimetype.startsWith('image/')) return 'imagem';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'documento';
}

// Lista de conversas
app.get('/api/conversas', (req, res) => {
  res.json(db.listarConversas());
});

// Mensagens de uma conversa
app.get('/api/conversas/:jid/mensagens', (req, res) => {
  res.json(db.listarMensagens(decodeURIComponent(req.params.jid)));
});

// Enviar mensagem de texto
app.post('/api/conversas/:jid/mensagens', async (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid);
    const { texto } = req.body;
    if (!texto || !texto.trim()) {
      return res.status(400).json({ erro: 'Texto vazio' });
    }
    await motor.enviarMensagem(jid, texto.trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Enviar mídia (foto, vídeo, áudio, documento, sticker)
app.post('/api/conversas/:jid/midia', upload.single('arquivo'), async (req, res) => {
  const arquivoTemp = req.file?.path;
  try {
    const jid = decodeURIComponent(req.params.jid);
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    }

    let mimetype = req.file.mimetype;
    const tipoForcado = req.body.tipo; // frontend pode forçar 'sticker' ou 'audio' (ptt)
    const tipoMensagem = tipoForcado || detectarTipoPorMimetype(mimetype);

    // Mensagem de voz gravada no app vem em WebM; o WhatsApp exige OGG/Opus
    // pra tocar em todos os aparelhos, então trocamos o container aqui.
    if (tipoMensagem === 'audio') {
      const bruto = fs.readFileSync(arquivoTemp);
      if (ehWebm(bruto)) {
        fs.writeFileSync(arquivoTemp, webmParaOgg(bruto));
        mimetype = 'audio/ogg; codecs=opus';
      }
    }
    const legenda = req.body.legenda || '';

    await motor.enviarMidia(jid, {
      caminhoArquivo: arquivoTemp,
      mimetype,
      tipoMensagem,
      nomeArquivo: req.file.originalname,
      legenda,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar mídia:', err.message);
    res.status(500).json({ erro: err.message });
  } finally {
    if (arquivoTemp && fs.existsSync(arquivoTemp)) {
      fs.unlink(arquivoTemp, () => {});
    }
  }
});

// Apagar conversa (no WhatsApp também, como no WhatsApp Web)
app.post('/api/conversas/:jid/apagar', async (req, res) => {
  try {
    res.json(await motor.apagarConversa(decodeURIComponent(req.params.jid)));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Status (stories) das últimas 24h, agrupados por contato
app.get('/api/status-contatos', (req, res) => {
  res.json(db.listarStatus());
});

// Marcar conversa como lida
app.post('/api/conversas/:jid/lidas', (req, res) => {
  db.marcarLidas(decodeURIComponent(req.params.jid));
  res.json({ ok: true });
});

// Presença de um contato (online/offline/digitando)
app.get('/api/presenca/:jid', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  motor.assinarPresenca(jid);
  res.json(db.obterPresenca(jid) || {});
});

// Conectar pelo número de telefone (código de pareamento)
app.post('/api/pareamento', async (req, res) => {
  try {
    let numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
    if (numero.length === 10 || numero.length === 11) numero = '55' + numero; // número BR sem o 55
    if (numero.length < 12 || numero.length > 15) {
      return res.status(400).json({ erro: 'Número inválido. Use DDD + número, ex: 31 99999-9999' });
    }
    const codigo = await motor.pedirCodigoPareamento(numero);
    res.json({ codigo });
  } catch (err) {
    console.error('Erro no código de pareamento:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Status da conexão + QR code (como imagem base64)
app.get('/api/status', async (req, res) => {
  const status = motor.getStatus();
  const qr = motor.getQR();
  let qrImagem = null;
  if (qr) {
    qrImagem = await qrcode.toDataURL(qr);
  }
  res.json({ status, qrImagem });
});

// Server-Sent Events — atualizações em tempo real pro front
app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const enviar = (evento) => {
    res.write(`data: ${JSON.stringify(evento)}\n\n`);
  };

  const cancelar = motor.onEvento(enviar);

  req.on('close', () => {
    cancelar();
  });
});

// só aceita conexões do próprio celular (ninguém da mesma rede Wi-Fi acessa)
app.listen(PORTA, '127.0.0.1', () => {
  console.log(`\n🚀 Chat Slim rodando! Abra no navegador: http://127.0.0.1:${PORTA}\n`);
});

motor.iniciar().catch((err) => {
  console.error('Erro ao iniciar motor:', err);
});
