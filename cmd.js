// Modo "cmd": uma janelinha de texto (parece o Prompt de Comando) pra usar o Zap no navegador do PC,
// sem foto e sem cara de WhatsApp. Fica DESLIGADO até você ligar no Zap (menu) e só aceita quem sabe a senha.
// Escuta numa porta separada (a do app + 1) e expõe só 3 coisas: lista de conversas, mensagens (texto) e enviar texto.
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');

const SENHA_FIXA = '09767';
const TOKEN_VALE_MS = 12 * 3600 * 1000;

function criar({ db, motor, portaApp }) {
  const PORTA = portaApp + 1;
  let servidor = null;
  const tokens = new Map();           // token -> expira
  let erros = 0, bloqueadoAte = 0;    // trava contra tentativa de senha

  const cfg = () => db.obterConfig();
  const senhaAtual = () => SENHA_FIXA;
  const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  const ROTULO = { imagem: 'imagem', video: 'video', audio: 'audio', documento: 'arquivo', sticker: 'figura', localizacao: 'local', contato: 'contato', enquete: 'enquete', evento: 'evento' };
  const hora = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const texto = (m) => {
    const t = (m.texto || '').trim();
    if (!m.tipo || m.tipo === 'texto') return t;
    const r = '[' + (ROTULO[m.tipo] || m.tipo) + ']';
    return t && t.indexOf(r) < 0 ? r + ' ' + t : (t || r);
  };

  function app() {
    const a = express();
    a.disable('x-powered-by');
    a.use(express.json({ limit: '64kb' }));
    a.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
    a.get('/', (req, res) => res.type('html').send(PAGINA));
    a.get('/favicon.ico', (req, res) => res.status(204).end());
    a.post('/login', (req, res) => {
      if (Date.now() < bloqueadoAte) return res.status(429).json({ erro: 'espere' });
      const s = String((req.body && req.body.senha) || '');
      if (!s || !igual(s, senhaAtual())) {
        if (++erros >= 5) { erros = 0; bloqueadoAte = Date.now() + 60000; }
        return res.status(401).json({ erro: 'negado' });
      }
      erros = 0;
      const t = crypto.randomBytes(18).toString('hex');
      tokens.set(t, Date.now() + TOKEN_VALE_MS);
      res.json({ token: t });
    });
    a.use((req, res, next) => {
      const t = req.headers['x-t'];
      const ate = t && tokens.get(String(t));
      if (!ate || ate < Date.now()) { if (t) tokens.delete(String(t)); return res.status(401).json({ erro: 'sessao' }); }
      next();
    });
    a.get('/c', (req, res) => {
      const lista = db.listarConversas().slice(0, 60).map((c) => ({
        j: c.jid, n: c.nome_exibicao || c.jid.split('@')[0], nl: c.nao_lidas || 0,
        t: String(c.ultima_mensagem_texto || '').slice(0, 80), ts: c.ultima_mensagem_ts || 0,
        g: c.eh_grupo ? 1 : 0, m: c.ultima_de_mim ? 1 : 0,
      }));
      res.json({ status: motor.getStatus(), lista });
    });
    a.get('/m', (req, res) => {
      const jid = String(req.query.jid || '');
      if (!jid) return res.status(400).json({ erro: 'jid' });
      const grupo = jid.endsWith('@g.us');
      const msgs = db.listarMensagens(jid, 40).map((m) => ({
        id: m.id, m: m.de_mim ? 1 : 0, ts: m.timestamp,
        a: m.de_mim ? '' : (grupo ? (m.remetente_nome || String(m.remetente_jid || '').split('@')[0]) : ''),
        x: texto(m) + (m.apagada_pelo_remetente ? ' (apagada)' : ''), h: hora(m.timestamp),
      }));
      res.json({ msgs });
    });
    a.post('/e', async (req, res) => {
      try {
        const jid = String((req.body && req.body.jid) || ''), tx = String((req.body && req.body.texto) || '').trim();
        if (!jid || !tx) return res.status(400).json({ erro: 'vazio' });
        await motor.enviarMensagem(jid, tx.slice(0, 4000), null);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ erro: e.message }); }
    });
    return a;
  }

  // IP do celular na rede (os.networkInterfaces falha em alguns Androids: cai no truque do UDP)
  async function meuIp() {
    try {
      for (const lista of Object.values(os.networkInterfaces())) {
        for (const i of lista || []) if (i.family === 'IPv4' && !i.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address)) return i.address;
      }
    } catch (_) {}
    return new Promise((ok) => {
      try {
        const s = dgram.createSocket('udp4');
        s.on('error', () => { try { s.close(); } catch (_) {} ok(null); });
        s.connect(53, '8.8.8.8', () => { let ip = null; try { ip = s.address().address; } catch (_) {} try { s.close(); } catch (_) {} ok(ip); });
        setTimeout(() => { try { s.close(); } catch (_) {} ok(null); }, 1500);
      } catch (_) { ok(null); }
    });
  }

  function ligar() {
    if (servidor) return Promise.resolve();
    return new Promise((ok, falha) => {
      const s = app().listen(PORTA, '0.0.0.0', () => { servidor = s; ok(); });
      s.on('error', (e) => { if (!servidor) falha(e); else console.error('[cmd]', e.message); });
    });
  }
  function desligar() {
    erros = 0; bloqueadoAte = 0;
    tokens.clear();
    const s = servidor; servidor = null;
    if (s) { try { s.close(); if (s.closeAllConnections) s.closeAllConnections(); } catch (_) {} }
  }

  async function estado() {
    const ativo = !!servidor;
    const ip = ativo ? await meuIp() : null;
    return { ativo, porta: PORTA, ip, url: ip ? 'http://' + ip + ':' + PORTA : null, senha: ativo ? senhaAtual() : null };
  }
  async function definir({ ativo, novaSenha }) {
    if (novaSenha) tokens.clear();   // derruba quem estiver logado
    if (ativo === true) { await ligar(); db.definirConfig({ cmd_ativo: true }); }
    else if (ativo === false) { desligar(); db.definirConfig({ cmd_ativo: false }); }
    return estado();
  }
  // religa sozinho se estava ligado quando o motor reiniciou
  function iniciar() { if (cfg().cmd_ativo) ligar().catch((e) => console.error('[cmd] não subiu:', e.message)); }

  return { estado, definir, iniciar, _app: app };
}

const PAGINA = String.raw`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>C:\Windows\system32\cmd.exe</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3E%3Crect width=%2716%27 height=%2716%27 fill=%27%23000%27/%3E%3Cpath d=%27M3 4l4 4-4 4%27 stroke=%27%23ccc%27 fill=%27none%27/%3E%3Cpath d=%27M8 12h5%27 stroke=%27%23ccc%27/%3E%3C/svg%3E">
<style>
html,body{margin:0;height:100%;background:#0c0c0c;color:#ccc;font:15px/1.25 Consolas,"Lucida Console","Courier New",monospace}
#t{box-sizing:border-box;height:100%;overflow-y:auto;padding:6px 8px;white-space:pre-wrap;word-break:break-word;cursor:text}
#t::-webkit-scrollbar{width:14px}#t::-webkit-scrollbar-track{background:#171717}#t::-webkit-scrollbar-thumb{background:#4d4d4d}
.d{color:#767676}.l{display:flex}.l span{white-space:pre}
#i{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#ccc;font:inherit;caret-color:#ccc;padding:0}
</style></head><body><div id="t"><div id="o"></div><div class="l"><span id="p"></span><input id="i" autocomplete="off" autocapitalize="off" spellcheck="false"></div></div>
<script>
(function(){
var o=document.getElementById("o"),p=document.getElementById("p"),i=document.getElementById("i"),t=document.getElementById("t");
var tok=null;try{tok=sessionStorage.getItem("t")}catch(e){}
var modo=tok?"dir":"senha",lista=[],atual=null,vistos={},timer=null,ultTs={},hist=[],hp=0;
var RAIZ="C:\\Users\\Admin";
function sem(s){return String(s==null?"":s).replace(/[\p{Extended_Pictographic}\u200d\ufe0f\u20e3\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu,"").replace(/[ \t]{2,}/g," ").trim()}
function out(s,c){var d=document.createElement("div");if(c)d.className=c;d.textContent=s;o.appendChild(d);t.scrollTop=t.scrollHeight}
function banner(){out("Microsoft Windows [Version 10.0.19045.3693]");out("(c) Microsoft Corporation. Todos os direitos reservados.");out("")}
function prompt_(){if(modo==="senha"){p.textContent="Senha: ";i.type="password"}else{i.type="text";p.textContent=atual?RAIZ+"\\"+sem(atual.n).replace(/[\\\/:*?"<>|]/g,"")+">":RAIZ+">"}}
function api(m,u,b){return fetch(u,{method:m,headers:{"Content-Type":"application/json","X-T":tok||""},body:b?JSON.stringify(b):undefined}).then(function(r){if(r.status===401&&tok){sair()}return r.json().then(function(j){if(!r.ok)throw new Error(j.erro||r.status);return j})})}
function sair(){tok=null;try{sessionStorage.removeItem("t")}catch(e){}modo="senha";atual=null;parar();out("Sessao encerrada.","d");prompt_()}
function pad(s,n){s=String(s);return s.length>=n?s.slice(0,n):s+new Array(n-s.length+1).join(" ")}
function hhmm(ts){var d=new Date(ts);return("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2)}
function dia(ts){var d=new Date(ts),h=new Date();return d.toDateString()===h.toDateString()?hhmm(ts):("0"+d.getDate()).slice(-2)+"/"+("0"+(d.getMonth()+1)).slice(-2)}
function carregar(){return api("GET","/c").then(function(r){lista=r.lista;return r})}
function dir(){carregar().then(function(r){out("");out(" Pasta de "+RAIZ);out("");if(!lista.length)out("Nenhum arquivo encontrado.");lista.forEach(function(c,k){out(pad(k+1,3)+pad(c.nl?"<"+c.nl+">":"",6)+pad(sem(c.n),24)+" "+pad(dia(c.ts),6)+" "+(c.m?"> ":"")+sem(c.t).replace(/\s+/g," ").slice(0,40))});out("");if(r.status!=="conectado")out("(rede: "+r.status+")","d")}).catch(function(e){out("Erro: "+e.message)})}
function linha(m){var q=m.m?"eu":sem(m.a||(atual?atual.n:"?"));return"["+m.h+"] "+q+"> "+sem(m.x)}
function trazer(){if(!atual)return;var j=atual.j;api("GET","/m?jid="+encodeURIComponent(j)).then(function(r){if(!atual||atual.j!==j)return;r.msgs.forEach(function(m){if(vistos[m.id])return;vistos[m.id]=1;out(linha(m),m.m?"d":"")})}).catch(function(){})}
function abrir(arg){var c=null,n=parseInt(arg,10);if(n&&lista[n-1])c=lista[n-1];else{var q=arg.toLowerCase();for(var k=0;k<lista.length;k++)if(sem(lista[k].n).toLowerCase().indexOf(q)>=0){c=lista[k];break}}
if(!c){out("O sistema nao pode encontrar o caminho especificado.");return}atual=c;vistos={};out("");trazer();prompt_();parar();timer=setInterval(function(){if(!document.hidden)trazer()},2500)}
function parar(){if(timer){clearInterval(timer);timer=null}}
function voltar(){parar();atual=null;prompt_()}
function ajuda(){out("Comandos:");out("  dir            lista as pastas (conversas)");out("  N              (so o numero) abre a pasta");out("  cd ..          volta");out("  cls | Esc      limpa a tela");out("  texto          (dentro da pasta) envia");out("  > texto        envia mesmo que seja um comando");out("  exit           encerra a sessao")}
function enviar(x){var j=atual.j;api("POST","/e",{jid:j,texto:x}).then(function(){setTimeout(trazer,700)}).catch(function(e){out("Falha ao gravar: "+e.message)})}
function executar(s){var low=s.toLowerCase().trim();
if(modo==="senha"){out("Senha: ******");fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({senha:s})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(r.status);return j})}).then(function(j){tok=j.token;try{sessionStorage.setItem("t",tok)}catch(e){}modo="dir";o.innerHTML="";banner();prompt_();dir()}).catch(function(){out("Acesso negado.")});return}
out(p.textContent+s);if(!s.trim())return;
if(s.charAt(0)===">"){var x=s.slice(1).trim();if(atual&&x)enviar(x);else out("Nao ha pasta aberta.");return}
if(low==="cls"||low==="clear"){o.innerHTML="";return}
if(low==="exit"){if(atual)voltar();else{o.innerHTML="";sair()}return}
if(low==="cd .."||low==="cd.."||low==="cd\\"){voltar();return}
if(!atual&&/^\d{1,3}$/.test(low)){var go2=function(){abrir(low)};if(!lista.length)carregar().then(go2).catch(function(e){out("Erro: "+e.message)});else go2();return}
if(low==="dir"||low==="ls"){if(atual)voltar();dir();return}
if(low==="help"||low==="?"){ajuda();return}
var m=/^(cd|open|abrir)\s+(.+)$/i.exec(s.trim());
if(m){var go=function(){abrir(m[2].trim())};if(atual)voltar();if(!lista.length)carregar().then(go).catch(function(e){out("Erro: "+e.message)});else go();return}
if(atual){enviar(s.trim());return}
out('"'+s.trim().split(" ")[0]+'" nao e reconhecido como um comando interno ou externo,');out("programa operavel ou arquivo em lotes.")}
function vigiar(){if(modo==="senha"||document.hidden)return;carregar().then(function(r){r.lista.forEach(function(c){var a=ultTs[c.j];if(a&&c.ts>a&&!c.m&&(!atual||atual.j!==c.j))out("[+] "+sem(c.n),"d");ultTs[c.j]=c.ts})}).catch(function(){})}
setInterval(vigiar,8000);
i.addEventListener("keydown",function(e){if(e.key==="Enter"){var s=i.value;if(modo!=="senha"&&s.trim()){hist.push(s);hp=hist.length}i.value="";executar(s)}
else if(e.key==="ArrowUp"&&modo!=="senha"){if(hp>0){hp--;i.value=hist[hp];e.preventDefault()}}
else if(e.key==="ArrowDown"&&modo!=="senha"){if(hp<hist.length){hp++;i.value=hist[hp]||"";e.preventDefault()}}});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){o.innerHTML="";i.value=""}});
t.addEventListener("click",function(){if(!getSelection().toString())i.focus()});
banner();prompt_();if(tok){carregar().then(function(r){r.lista.forEach(function(c){ultTs[c.j]=c.ts});dir()}).catch(function(){})}i.focus();
})();
</script></body></html>
`;

module.exports = { criar };
