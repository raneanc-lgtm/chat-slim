// ============================================================
// Chat Slim — Converte áudio WebM/Opus (gravado pelo navegador/WebView)
// para OGG/Opus, que é o formato que o WhatsApp exige pra mensagem
// de voz tocar em todos os celulares. Não recodifica nada: só troca
// o "envelope" (container), então é rápido e sem perda.
// ============================================================

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  CLUSTER: 0x1f43b675,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
};
const MASTERS = new Set([ID.SEGMENT, ID.CLUSTER, ID.TRACKS, ID.TRACK_ENTRY, ID.BLOCK_GROUP]);

function lerVint(buf, pos, manterMarcador) {
  const primeiro = buf[pos];
  if (primeiro === undefined) return null;
  let tamanho = 1;
  let mascara = 0x80;
  while (tamanho <= 8 && !(primeiro & mascara)) {
    tamanho++;
    mascara >>= 1;
  }
  if (tamanho > 8 || pos + tamanho > buf.length) return null;
  let valor = manterMarcador ? primeiro : primeiro & (mascara - 1);
  let todosUm = (primeiro & (mascara - 1)) === mascara - 1;
  for (let i = 1; i < tamanho; i++) {
    valor = valor * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) todosUm = false;
  }
  return { valor, tamanho, desconhecido: !manterMarcador && todosUm };
}

function extrairOpusDoWebm(buf) {
  let opusHead = null;
  let ehOpus = false;
  const pacotes = [];

  function percorrer(inicio, fim) {
    let pos = inicio;
    while (pos < fim) {
      const id = lerVint(buf, pos, true);
      if (!id) return;
      const tam = lerVint(buf, pos + id.tamanho, false);
      if (!tam) return;
      const dadosIni = pos + id.tamanho + tam.tamanho;
      const dadosFim = tam.desconhecido ? fim : Math.min(fim, dadosIni + tam.valor);

      if (MASTERS.has(id.valor)) {
        if (tam.desconhecido) {
          // tamanho desconhecido (comum no MediaRecorder do Chrome): os filhos
          // continuam até o fim do pai, então só seguimos lendo em sequência
          pos = dadosIni;
          continue;
        }
        percorrer(dadosIni, dadosFim);
      } else if (id.valor === ID.CODEC_ID) {
        ehOpus = buf.toString('ascii', dadosIni, dadosFim) === 'A_OPUS';
      } else if (id.valor === ID.CODEC_PRIVATE) {
        opusHead = Buffer.from(buf.subarray(dadosIni, dadosFim));
      } else if (id.valor === ID.SIMPLE_BLOCK || id.valor === ID.BLOCK) {
        const trilha = lerVint(buf, dadosIni, false);
        if (trilha) {
          const flags = buf[dadosIni + trilha.tamanho + 2];
          const lacing = (flags >> 1) & 0x03;
          const quadroIni = dadosIni + trilha.tamanho + 3;
          if (lacing === 0 && quadroIni < dadosFim) {
            pacotes.push(Buffer.from(buf.subarray(quadroIni, dadosFim)));
          }
        }
      }
      if (tam.desconhecido) return;
      pos = dadosFim;
    }
  }

  percorrer(0, buf.length);
  return { opusHead, ehOpus, pacotes };
}

// quantas amostras (a 48kHz) um pacote Opus representa
function amostrasDoPacote(pacote) {
  if (!pacote.length) return 0;
  const toc = pacote[0];
  const config = toc >> 3;
  let porQuadro;
  if (config < 12) porQuadro = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) porQuadro = [480, 960][config & 1];
  else porQuadro = [120, 240, 480, 960][config & 3];
  const c = toc & 3;
  let quadros;
  if (c === 0) quadros = 1;
  else if (c === 1 || c === 2) quadros = 2;
  else quadros = pacote.length > 1 ? pacote[1] & 0x3f : 0;
  return porQuadro * quadros;
}

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crcOgg(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ TABELA_CRC[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc;
}

function montarPaginaOgg(pacotes, { granule, serial, sequencia, tipo }) {
  const segmentos = [];
  for (const p of pacotes) {
    let resto = p.length;
    while (resto >= 255) {
      segmentos.push(255);
      resto -= 255;
    }
    segmentos.push(resto);
  }
  const cab = Buffer.alloc(27 + segmentos.length);
  cab.write('OggS', 0, 'ascii');
  cab[4] = 0;
  cab[5] = tipo;
  cab.writeBigInt64LE(BigInt(granule), 6);
  cab.writeUInt32LE(serial, 14);
  cab.writeUInt32LE(sequencia, 18);
  cab.writeUInt32LE(0, 22);
  cab[26] = segmentos.length;
  Buffer.from(segmentos).copy(cab, 27);
  const pagina = Buffer.concat([cab, ...pacotes]);
  pagina.writeUInt32LE(crcOgg(pagina), 22);
  return pagina;
}

function webmParaOgg(webm) {
  const { opusHead: headOriginal, ehOpus, pacotes } = extrairOpusDoWebm(webm);
  if (!ehOpus || !pacotes.length) {
    throw new Error('Áudio não está em WebM/Opus — não dá pra converter');
  }

  let opusHead = headOriginal;
  if (!opusHead || opusHead.toString('ascii', 0, 8) !== 'OpusHead') {
    opusHead = Buffer.alloc(19);
    opusHead.write('OpusHead', 0, 'ascii');
    opusHead[8] = 1; // versão
    opusHead[9] = 1; // canais
    opusHead.writeUInt16LE(312, 10); // pre-skip
    opusHead.writeUInt32LE(48000, 12);
  }

  const opusTags = Buffer.alloc(8 + 4 + 9 + 4);
  opusTags.write('OpusTags', 0, 'ascii');
  opusTags.writeUInt32LE(9, 8);
  opusTags.write('Chat Slim', 12, 'ascii');
  opusTags.writeUInt32LE(0, 21);

  const serial = (Math.random() * 0xffffffff) >>> 0;
  let sequencia = 0;
  const paginas = [
    montarPaginaOgg([opusHead], { granule: 0, serial, sequencia: sequencia++, tipo: 0x02 }),
    montarPaginaOgg([opusTags], { granule: 0, serial, sequencia: sequencia++, tipo: 0x00 }),
  ];

  let granule = 0;
  let lote = [];
  let segmentosNoLote = 0;
  for (let i = 0; i < pacotes.length; i++) {
    const p = pacotes[i];
    const segs = Math.floor(p.length / 255) + 1;
    if (lote.length && (segmentosNoLote + segs > 255 || lote.length >= 50)) {
      paginas.push(montarPaginaOgg(lote, { granule, serial, sequencia: sequencia++, tipo: 0x00 }));
      lote = [];
      segmentosNoLote = 0;
    }
    lote.push(p);
    segmentosNoLote += segs;
    granule += amostrasDoPacote(p);
  }
  paginas.push(montarPaginaOgg(lote, { granule, serial, sequencia: sequencia++, tipo: 0x04 }));

  return Buffer.concat(paginas);
}

function ehWebm(buf) {
  return buf.length > 4 && buf.readUInt32BE(0) === ID.EBML;
}

module.exports = { webmParaOgg, ehWebm };
