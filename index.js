const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const { createClient } = require("@supabase/supabase-js")
const pino = require("pino")
const fs = require("fs")

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: "*" } })
app.use(express.json())
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "Content-Type")
  next()
})

const SUPABASE_URL = "https://ynxpowhzhnwqazdxshch.supabase.co"
const SUPABASE_KEY = "sb_publishable_aATPGJyG-Q8KuLLflByr8w_nrHxt0mt"
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const AUTH_FOLDER = "./auth_info"
let sock = null, qrCode = null, pairingCode = null, connected = false
let pairingPhone = null   // ← NOVO: guarda o número para retentar
let socketReady = false   // ← NOVO: flag para saber se o socket está pronto para pairing

async function salvarMsg(telefone, conteudo, nome) {
  try {
    await supabase.from("whatsapp_mensagens").insert({
      telefone, conteudo, de_mim: false, timestamp: new Date().toISOString()
    })
    const { data } = await supabase.from("whatsapp_conversas").select("*").eq("telefone", telefone).single().catch(() => ({ data: null }))
    await supabase.from("whatsapp_conversas").upsert({
      telefone, nome: nome || data?.nome || telefone,
      ultimo_msg: conteudo, ultima_atualizacao: new Date().toISOString(),
      nao_lidas: (data?.nao_lidas || 0) + 1
    }, { onConflict: "telefone" })
  } catch (e) { console.error("Erro salvar msg:", e.message) }
}

async function conectar() {
  socketReady = false

  // ── CORREÇÃO 1: Limpa auth se existir arquivo corrompido ──────────
  if (fs.existsSync(AUTH_FOLDER)) {
    const files = fs.readdirSync(AUTH_FOLDER)
    // Se pasta existe mas está vazia ou só tem arquivos vazios, limpa
    const hasValidCreds = files.some(f => {
      const fp = `${AUTH_FOLDER}/${f}`
      return fs.statSync(fp).size > 10
    })
    if (!hasValidCreds) {
      console.log("Auth inválida detectada, limpando...")
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    browser: ["OPERAX", "Chrome", "1.0"],
    // ── CORREÇÃO 2: Desativa geração automática de QR quando for usar pairing ──
    generateHighQualityLinkPreview: false,
  })

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = qr
      connected = false
      socketReady = true  // ← socket está pronto, pode pedir pairing agora
      io.emit("qr", { qr })
      console.log("QR gerado, socket pronto para pairing")

      // ── CORREÇÃO 3: Se tinha um número aguardando, pede o código agora ──
      if (pairingPhone) {
        console.log("Gerando pairing code para:", pairingPhone)
        try {
          await new Promise(resolve => setTimeout(resolve, 1500)) // espera 1.5s
          const code = await sock.requestPairingCode(pairingPhone)
          pairingCode = code
          io.emit("pairing_code", { code })
          console.log("Pairing code gerado:", code)
          pairingPhone = null
        } catch (e) {
          console.error("Erro ao gerar pairing code:", e.message)
          io.emit("pairing_error", { error: e.message })
          pairingPhone = null
        }
      }
    }

    if (connection === "close") {
      connected = false
      socketReady = false
      qrCode = null
      pairingCode = null
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : null
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log("Conexão fechada, código:", statusCode, "reconectar:", shouldReconnect)
      if (shouldReconnect) setTimeout(() => conectar(), 3000)
    }

    if (connection === "open") {
      connected = true
      socketReady = false
      qrCode = null
      pairingCode = null
      pairingPhone = null
      io.emit("connected", { status: "connected" })
      console.log("✅ WhatsApp conectado!")
    }
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const jid = msg.key.remoteJid
      if (!jid || jid.endsWith("@g.us")) continue
      const telefone = jid.replace("@s.whatsapp.net", "")
      const conteudo = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || "[mídia]"
      const nome = msg.pushName || telefone
      await salvarMsg(telefone, conteudo, nome)
      io.emit("nova_mensagem", { telefone, conteudo, nome })
    }
  })
}

// ── ROTAS API ─────────────────────────────────────────────────────────
app.get("/status", (req, res) => res.json({
  connected,
  status: connected ? "connected" : "disconnected",
  has_qr: !!qrCode,
  socket_ready: socketReady
}))

app.post("/send", async (req, res) => {
  const { to, message } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Desconectado" })
  try {
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── CORREÇÃO 4: Rota de pairing completamente refeita ─────────────────
app.post("/request-pairing", async (req, res) => {
  const { phone } = req.body
  const phoneClean = (phone || "").replace(/\D/g, "")

  if (!phoneClean || phoneClean.length < 10) {
    return res.status(400).json({ error: "Número inválido" })
  }

  if (connected) {
    return res.json({ error: "Já conectado" })
  }

  if (!sock) {
    return res.status(503).json({ error: "Servidor não iniciado ainda" })
  }

  // Se o socket ainda não recebeu o QR (não está pronto), guarda o número e aguarda
  if (!socketReady) {
    console.log("Socket não pronto ainda, guardando número para quando o QR chegar:", phoneClean)
    pairingPhone = phoneClean
    return res.json({ waiting: true, message: "Aguardando socket ficar pronto..." })
  }

  // Socket pronto, pede o código agora
  try {
    console.log("Solicitando pairing code para:", phoneClean)
    await new Promise(resolve => setTimeout(resolve, 500))
    const code = await sock.requestPairingCode(phoneClean)
    pairingCode = code
    pairingPhone = null
    io.emit("pairing_code", { code })
    console.log("Pairing code:", code)
    res.json({ code })
  } catch (e) {
    console.error("Erro pairing:", e.message)
    io.emit("pairing_error", { error: e.message })
    res.json({ error: e.message })
  }
})

app.delete("/auth", (req, res) => {
  try {
    if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
    connected = false
    socketReady = false
    qrCode = null
    pairingCode = null
    pairingPhone = null
    res.json({ ok: true })
    setTimeout(() => conectar(), 2000)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PÁGINA QR/PAIRING ─────────────────────────────────────────────
app.get("/qr", (req, res) => {
  if (connected) return res.send(`<!DOCTYPE html><html><body style="background:#020c1e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;"><div style="background:#0a1628;border:1px solid rgba(56,189,248,0.3);border-radius:20px;padding:40px;text-align:center;"><div style="font-size:60px;">✅</div><h2 style="color:#22c55e;">Conectado!</h2><p style="color:#94a3b8;">Pode fechar esta janela.</p><a href="/chat" style="display:inline-block;margin-top:16px;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff;padding:10px 24px;border-radius:10px;text-decoration:none;font-weight:700;">Abrir Chat →</a></div></body></html>`)

  res.send(`<!DOCTYPE html><html><head><title>OPERAX - Conectar</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>*{box-sizing:border-box;margin:0;padding:0;font-family:sans-serif}body{background:#020c1e;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#0a1628;border:1px solid rgba(56,189,248,0.3);border-radius:20px;padding:36px;text-align:center;max-width:420px;width:100%}.logo{font-size:28px;font-weight:900;color:#fff;letter-spacing:.08em;margin-bottom:4px}.logo span{color:#38bdf8}.sub{color:#64748b;font-size:13px;margin-bottom:24px}.tabs{display:flex;gap:6px;margin-bottom:20px;background:#0f1f3d;border-radius:12px;padding:4px}.tab{flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:700;background:transparent;color:#64748b}.tab.active{background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff}#qr-s,#pair-s{display:none}#qr-s.show,#pair-s.show{display:block}.st{padding:9px 14px;border-radius:8px;font-size:12px;font-weight:700;margin:10px 0}.st.wait{background:rgba(14,165,233,0.1);color:#38bdf8;border:1px solid rgba(14,165,233,0.3)}.st.ok{background:rgba(34,197,94,0.1);color:#22c55e;border:1px solid rgba(34,197,94,0.3)}.st.err{background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.3)}#qrcode{display:flex;justify-content:center;margin:14px 0;min-height:180px;align-items:center}#qrcode img,#qrcode canvas{border-radius:10px;border:7px solid #fff}input{width:100%;background:#0f1f3d;border:1.5px solid rgba(56,189,248,0.4);border-radius:10px;padding:11px 14px;color:#e2f4ff;font-size:15px;letter-spacing:.1em;outline:none;margin:6px 0 14px}input:focus{border-color:#0ea5e9}button.btn{width:100%;background:linear-gradient(90deg,#1848cc,#0ea5e9);border:none;border-radius:10px;padding:13px;color:#fff;font-size:14px;font-weight:700;cursor:pointer}.code-box{background:#0f1f3d;border:2px solid #38bdf8;border-radius:12px;padding:18px;margin:12px 0;letter-spacing:.4em;font-size:26px;font-weight:900;color:#38bdf8}.note{color:#64748b;font-size:11px;text-align:left;line-height:1.7;margin-top:10px}.note b{color:#94a3b8}.spinner{border:3px solid rgba(56,189,248,0.2);border-top:3px solid #38bdf8;border-radius:50%;width:36px;height:36px;animation:spin 1s linear infinite;margin:20px auto}@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="card"><div class="logo">OPERAX <span>CHAT</span></div><div class="sub">Vincular WhatsApp ao sistema</div>
<div class="tabs"><button class="tab active" onclick="sw('qr')">📷 QR Code</button><button class="tab" onclick="sw('pair')">🔑 Código</button></div>
<div id="qr-s" class="show"><div class="st wait" id="qs">Aguardando QR Code...</div><div id="qrcode"><div class="spinner"></div></div><div class="note">Abra o <b>WhatsApp</b> → <b>Dispositivos vinculados</b> → <b>Vincular dispositivo</b> → aponte para o QR</div></div>
<div id="pair-s">
  <div id="pc">
    <div class="st wait">Digite seu número com código do país (sem +)</div>
    <input type="tel" id="ph" placeholder="5511999999999" maxlength="15">
    <div style="font-size:11px;color:#64748b;margin-bottom:10px;">Ex: 55 + DDD + número → 5511999999999</div>
    <button class="btn" onclick="reqCode()">🔑 Gerar código</button>
  </div>
  <div id="pr" style="display:none">
    <div class="st wait" id="ps">Aguardando servidor ficar pronto...</div>
    <div class="code-box" id="pb" style="display:none"></div>
    <div class="note" id="pi" style="display:none"><b>WhatsApp → Dispositivos vinculados → Vincular com número de telefone</b> → digite o código acima</div>
    <button class="btn" style="margin-top:12px;background:#0f1f3d;border:1px solid rgba(56,189,248,0.3);" onclick="document.getElementById('pc').style.display='block';document.getElementById('pr').style.display='none';">← Voltar</button>
  </div>
</div>
</div><script>
const s=io();
function sw(t){document.querySelectorAll('.tab').forEach((x,i)=>x.classList.toggle('active',(t==='qr'&&i===0)||(t==='pair'&&i===1)));document.getElementById('qr-s').classList.toggle('show',t==='qr');document.getElementById('pair-s').classList.toggle('show',t==='pair');}
s.on('qr',({qr})=>{document.getElementById('qs').textContent='📱 Escaneie com o WhatsApp';document.getElementById('qrcode').innerHTML='';new QRCode(document.getElementById('qrcode'),{text:qr,width:200,height:200,colorDark:'#000',colorLight:'#fff'});});
s.on('connected',()=>{['qs','ps'].forEach(id=>{const el=document.getElementById(id);if(el){el.className='st ok';el.textContent='✅ Conectado! Redirecionando...'}});setTimeout(()=>location.href='/chat',1500);});
s.on('pairing_code',({code})=>{
  const ps=document.getElementById('ps'); ps.className='st ok'; ps.textContent='Digite no WhatsApp:';
  const b=document.getElementById('pb'); b.textContent=code; b.style.display='block';
  document.getElementById('pi').style.display='block';
});
s.on('pairing_error',({error})=>{const el=document.getElementById('ps');el.className='st err';el.textContent='Erro: '+error+' — tente novamente.';});
function reqCode(){
  const p=document.getElementById('ph').value.replace(/\D/g,'');
  if(p.length<12){alert('Digite o número completo com código do país.\nEx: 5511999999999');return;}
  document.getElementById('pc').style.display='none';
  document.getElementById('pr').style.display='block';
  document.getElementById('ps').className='st wait';
  document.getElementById('ps').textContent='Aguardando sistema gerar o código...';
  document.getElementById('pb').style.display='none';
  fetch('/request-pairing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p})})
    .then(r=>r.json())
    .then(d=>{
      if(d.error){document.getElementById('ps').className='st err';document.getElementById('ps').textContent='Erro: '+d.error;}
      else if(d.waiting){document.getElementById('ps').textContent='Aguardando QR Code ser gerado para depois gerar o código...';}
      else if(d.code){
        document.getElementById('ps').className='st ok';document.getElementById('ps').textContent='Digite no WhatsApp:';
        const b=document.getElementById('pb');b.textContent=d.code;b.style.display='block';
        document.getElementById('pi').style.display='block';
      }
    }).catch(()=>{document.getElementById('ps').className='st err';document.getElementById('ps').textContent='Erro de conexão com o servidor.';});
}
fetch('/status').then(r=>r.json()).then(d=>{if(d.connected){document.getElementById('qs').className='st ok';document.getElementById('qs').textContent='✅ Já conectado!';document.getElementById('qrcode').innerHTML='<div style="font-size:50px;margin:20px">✅</div>';}});
</script></body></html>`)
})

// ── PÁGINA CHAT PRINCIPAL ─────────────────────────────────────────────
app.get("/chat", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OPERAX CHAT</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#dff0fb;height:100vh;display:flex;flex-direction:column;overflow:hidden;}
.topbar{background:#071828;padding:10px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(56,189,248,0.18);flex-shrink:0;}
.tb-logo{width:32px;height:32px;border-radius:9px;background:radial-gradient(circle at 38% 35%,#bfdbfe 0%,#3b82f6 28%,#1d4ed8 56%,#030a1a 88%);display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 0 14px rgba(56,189,248,0.65);flex-shrink:0;}
.tb-title{font-family:'Orbitron',sans-serif;font-size:16px;font-weight:900;color:#fff;letter-spacing:.08em;}
.tb-title span{color:#38bdf8;}
.tb-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:700;margin-left:auto;}
.badge-ok{background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.35);}
.badge-err{background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.35);}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;}
.layout{flex:1;display:flex;overflow:hidden;}
.sidebar{width:280px;background:#071828;display:flex;flex-direction:column;border-right:1px solid rgba(56,189,248,0.15);flex-shrink:0;}
.sb-search{padding:10px 12px;border-bottom:1px solid rgba(56,189,248,0.10);}
.sb-search input{width:100%;background:#0a1e32;border:1px solid rgba(56,189,248,0.20);border-radius:18px;padding:7px 13px;color:#c8e8f8;font-size:12px;outline:none;}
.sb-search input::placeholder{color:rgba(148,210,240,0.35);}
.sb-label{padding:8px 14px 4px;font-size:10px;font-weight:700;color:#38bdf8;letter-spacing:.10em;text-transform:uppercase;}
.convs{flex:1;overflow-y:auto;}
.convs::-webkit-scrollbar{width:3px;}
.convs::-webkit-scrollbar-thumb{background:rgba(56,189,248,0.20);}
.conv{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(56,189,248,0.06);transition:.15s;}
.conv:hover{background:rgba(56,189,248,0.08);}
.conv.active{background:rgba(56,189,248,0.15);border-left:3px solid #38bdf8;}
.av{width:40px;height:40px;border-radius:50%;background:#0a1e32;border:1.5px solid rgba(56,189,248,0.28);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#7dd3fc;flex-shrink:0;}
.conv-info{flex:1;min-width:0;}
.conv-top{display:flex;justify-content:space-between;align-items:center;}
.conv-name{font-size:12px;font-weight:700;color:#c8e8f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.conv-time{font-size:10px;color:rgba(148,185,210,0.45);flex-shrink:0;}
.conv-prev{font-size:11px;color:rgba(148,185,210,0.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
.nr{background:#38bdf8;color:#020c1e;font-size:9px;font-weight:800;border-radius:999px;padding:1px 6px;}
.prop-tag{font-size:9px;padding:2px 6px;border-radius:4px;font-weight:700;display:inline-block;margin-top:2px;}
.pt-pend{background:rgba(250,204,21,0.15);color:#facc15;border:1px solid rgba(250,204,21,0.28);}
.pt-pago{background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.28);}
.pt-agass{background:rgba(167,139,250,0.15);color:#a78bfa;border:1px solid rgba(167,139,250,0.28);}
.pt-agpag{background:rgba(56,189,248,0.15);color:#38bdf8;border:1px solid rgba(56,189,248,0.28);}
.sb-new{padding:10px 12px;border-top:1px solid rgba(56,189,248,0.10);}
.sb-new label{font-size:10px;font-weight:700;color:#38bdf8;letter-spacing:.08em;text-transform:uppercase;display:block;margin-bottom:4px;}
.sb-new input{width:100%;background:#0a1e32;border:1px solid rgba(56,189,248,0.22);border-radius:8px;padding:6px 10px;color:#c8e8f8;font-size:12px;outline:none;margin-bottom:5px;}
.sb-new button{width:100%;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border:none;border-radius:8px;padding:7px;color:#fff;font-size:12px;font-weight:700;cursor:pointer;}
.chat-main{flex:1;display:flex;flex-direction:column;overflow:hidden;}
.chat-header{background:#071828;padding:10px 16px;border-bottom:1px solid rgba(56,189,248,0.15);display:flex;align-items:center;gap:10px;flex-shrink:0;}
.ch-av{width:36px;height:36px;border-radius:50%;background:#0a1e32;border:1.5px solid rgba(56,189,248,0.38);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#7dd3fc;flex-shrink:0;}
.ch-name{font-size:13px;font-weight:700;color:#e0f2fe;}
.ch-status{font-size:11px;color:#38bdf8;}
.msgs{flex:1;padding:14px 18px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;background:#dff0fb;position:relative;}
.msgs::-webkit-scrollbar{width:3px;}
.msgs::-webkit-scrollbar-thumb{background:rgba(14,165,233,0.20);}
.wm{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);opacity:.07;pointer-events:none;}
.date-sep{align-self:center;font-size:10px;color:#0369a1;padding:3px 12px;background:rgba(255,255,255,.65);border-radius:99px;border:1px solid rgba(14,165,233,.18);margin:4px 0;}
.msg-d{align-self:flex-start;background:rgba(255,255,255,.90);border:1px solid rgba(14,165,233,.18);border-radius:3px 13px 13px 13px;padding:8px 12px;max-width:72%;font-size:13px;color:#0c2a4a;}
.msg-m{align-self:flex-end;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border-radius:13px 3px 13px 13px;padding:8px 12px;max-width:72%;font-size:13px;color:#fff;}
.msg-ts{font-size:10px;opacity:.60;margin-top:3px;text-align:right;}
.chat-input{background:#071828;padding:10px 14px;border-top:1px solid rgba(56,189,248,0.15);display:flex;align-items:center;gap:8px;flex-shrink:0;}
.chat-input input{flex:1;background:#0a1e32;border:1px solid rgba(56,189,248,0.22);border-radius:20px;padding:9px 14px;color:#e0f2fe;font-size:13px;outline:none;}
.chat-input input::placeholder{color:rgba(148,185,210,.38);}
.chat-input input:focus{border-color:#38bdf8;}
.send-btn{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 0 12px rgba(14,165,233,.45);}
.send-btn svg{width:15px;height:15px;stroke:#fff;fill:none;stroke-width:2;}
.right-panel{width:260px;background:#071828;border-left:1px solid rgba(56,189,248,0.15);display:flex;flex-direction:column;flex-shrink:0;}
.rp-tabs{display:flex;border-bottom:1px solid rgba(56,189,248,0.12);}
.rp-tab{flex:1;padding:10px 4px;text-align:center;font-size:11px;font-weight:700;color:rgba(125,211,252,.50);cursor:pointer;border-bottom:2px solid transparent;transition:.15s;}
.rp-tab.active{color:#38bdf8;border-bottom-color:#38bdf8;}
.rp-content{flex:1;overflow-y:auto;padding:8px;}
.rp-content::-webkit-scrollbar{width:2px;}
.rp-content::-webkit-scrollbar-thumb{background:rgba(56,189,248,.18);}
.rp-sec{font-size:10px;font-weight:700;color:#38bdf8;letter-spacing:.10em;text-transform:uppercase;padding:4px 2px 6px;}
.rr-item{padding:7px 9px;background:#0a1e32;border:1px solid rgba(56,189,248,.13);border-radius:8px;cursor:pointer;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;transition:.15s;}
.rr-item:hover{border-color:rgba(56,189,248,.40);background:#0d2444;}
.rr-title{font-size:12px;font-weight:700;color:#7dd3fc;}
.rr-prev{font-size:10px;color:rgba(148,185,210,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;}
.rr-del{font-size:12px;color:rgba(248,113,133,.50);cursor:pointer;padding:2px 4px;flex-shrink:0;}
.rr-del:hover{color:#f87171;}
.add-rr{padding:7px 9px;background:rgba(56,189,248,.05);border:1px dashed rgba(56,189,248,.22);border-radius:8px;text-align:center;font-size:11px;color:rgba(125,211,252,.50);cursor:pointer;margin-bottom:8px;}
.add-rr:hover{border-color:#38bdf8;color:#7dd3fc;}
hr{border:none;border-top:1px solid rgba(56,189,248,.10);margin:8px 0;}
.prop-card{background:#0a1e32;border:1px solid rgba(56,189,248,.25);border-radius:10px;padding:12px;}
.pc-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.pc-title{font-size:11px;font-weight:700;color:#38bdf8;letter-spacing:.06em;}
.pc-sync{font-size:9px;color:#4ade80;}
.pf-label{font-size:9px;font-weight:700;color:rgba(125,211,252,.65);letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px;}
.pf-value{font-size:13px;font-weight:600;color:#e0f2fe;margin-bottom:8px;}
.pf-valor{font-size:16px;font-weight:800;color:#4ade80;}
.st-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;}
.sp-pend{background:rgba(250,204,21,.15);color:#facc15;border:1px solid rgba(250,204,21,.30);}
.sp-pago{background:rgba(74,222,128,.15);color:#4ade80;border:1px solid rgba(74,222,128,.30);}
.sp-agass{background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.30);}
.sp-agpag{background:rgba(56,189,248,.15);color:#38bdf8;border:1px solid rgba(56,189,248,.30);}
.sp-canc{background:rgba(248,113,133,.15);color:#f87171;border:1px solid rgba(248,113,133,.30);}
.edit-btn{width:100%;margin-top:8px;background:rgba(56,189,248,.10);border:1px solid rgba(56,189,248,.30);border-radius:7px;padding:7px;color:#7dd3fc;font-size:11px;font-weight:700;cursor:pointer;}
.edit-btn:hover{background:rgba(56,189,248,.18);}
.no-prop{background:#0a1e32;border:1px dashed rgba(56,189,248,.20);border-radius:10px;padding:14px;text-align:center;color:rgba(148,185,210,.55);font-size:12px;line-height:1.6;}
.ef-label{font-size:9px;font-weight:700;color:rgba(125,211,252,.65);letter-spacing:.08em;text-transform:uppercase;margin:5px 0 2px;}
.ef-input{width:100%;background:#0a1e32;border:1px solid rgba(56,189,248,.18);border-radius:7px;padding:6px 9px;color:#c8e8f8;font-size:12px;outline:none;margin-bottom:2px;}
.ef-input:focus{border-color:#38bdf8;}
.ef-select{width:100%;background:#0a1e32;border:1px solid rgba(56,189,248,.18);border-radius:7px;padding:6px 9px;color:#c8e8f8;font-size:11px;outline:none;margin-bottom:2px;}
.st-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin:4px 0;}
.st-chip{display:flex;align-items:center;gap:4px;padding:5px 7px;border-radius:6px;cursor:pointer;border:1px solid rgba(56,189,248,.10);background:#0a1e32;transition:.15s;font-size:10px;color:#94a3b8;}
.st-chip.sel{border-color:rgba(56,189,248,.50);background:#0d2a44;color:#e0f2fe;}
.st-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.sc-pend .st-dot{background:#facc15;}.sc-agpag .st-dot{background:#38bdf8;}
.sc-agass .st-dot{background:#a78bfa;}.sc-pago .st-dot{background:#4ade80;}
.sc-canc .st-dot{background:#f87171;}
.save-btn{width:100%;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border:none;border-radius:8px;padding:8px;color:#fff;font-size:11px;font-weight:700;cursor:pointer;margin-top:6px;box-shadow:0 0 10px rgba(14,165,233,.30);}
.sync-msg{background:rgba(74,222,128,.10);border:1px solid rgba(74,222,128,.25);border-radius:6px;padding:6px;font-size:10px;color:#4ade80;text-align:center;margin-top:6px;display:none;}
.back-link{font-size:10px;color:rgba(125,211,252,.40);cursor:pointer;text-align:center;margin-top:6px;}
.back-link:hover{color:#7dd3fc;}
.empty-chat{flex:1;display:flex;align-items:center;justify-content:center;color:rgba(14,80,130,.55);font-size:13px;text-align:center;flex-direction:column;gap:8px;}
.empty-chat svg{width:40px;height:40px;stroke:rgba(14,80,130,.35);fill:none;stroke-width:1.5;}
</style>
</head>
<body>
<div class="topbar">
  <div class="tb-logo">🌀</div>
  <span class="tb-title">OPERAX <span>CHAT</span></span>
  <div id="conn-badge" class="tb-badge badge-err"><span class="dot"></span>Verificando...</div>
  <a href="/qr" target="_blank" id="qr-link" style="display:none;margin-left:8px;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff;padding:5px 12px;border-radius:8px;font-size:11px;font-weight:700;text-decoration:none;">🔑 Conectar</a>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="sb-search"><input id="search-input" placeholder="Buscar conversa..." oninput="filtrarConvs()"></div>
    <div class="sb-label">💬 Conversas</div>
    <div class="convs" id="convs-list"><div style="padding:16px;text-align:center;color:rgba(148,185,210,.50);font-size:12px;">Carregando...</div></div>
    <div class="sb-new">
      <label>Nova conversa</label>
      <input id="new-tel" placeholder="5511999999999" maxlength="15">
      <button onclick="iniciarConv()">Iniciar</button>
    </div>
  </div>
  <div class="chat-main">
    <div class="chat-header">
      <div class="ch-av" id="ch-av">?</div>
      <div><div class="ch-name" id="ch-name">Selecione uma conversa</div><div class="ch-status" id="ch-status"></div></div>
    </div>
    <div class="msgs" id="msgs-area">
      <svg class="wm" viewBox="0 0 200 200" width="320" height="320">
        <path fill="none" stroke="#0369a1" stroke-width="8" stroke-linecap="round" d="M100,100 m0,-52 a52,52 0 1,1 -0.1,0"/>
        <path fill="none" stroke="#0369a1" stroke-width="6" stroke-linecap="round" d="M100,100 m0,-36 a36,36 0 1,1 -0.1,0"/>
        <path fill="none" stroke="#0369a1" stroke-width="4" stroke-linecap="round" d="M100,100 m0,-22 a22,22 0 1,1 -0.1,0"/>
        <path fill="none" stroke="#0369a1" stroke-width="3" stroke-linecap="round" d="M100,100 m0,-11 a11,11 0 1,1 -0.1,0"/>
        <circle cx="100" cy="100" r="4" fill="#0369a1"/>
        <text x="100" y="172" text-anchor="middle" font-family="Arial" font-size="11" font-weight="900" fill="#0369a1" letter-spacing="5">OPERAX</text>
      </svg>
      <div class="empty-chat" id="empty-msg">
        <svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        Selecione uma conversa ao lado
      </div>
    </div>
    <div class="chat-input">
      <input id="msg-input" placeholder="Digite uma mensagem..." onkeydown="if(event.key==='Enter')enviar()">
      <button class="send-btn" onclick="enviar()" aria-label="Enviar">
        <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
  </div>
  <div class="right-panel">
    <div class="rp-tabs">
      <div class="rp-tab active" onclick="showTab('rr',this)">⚡ Respostas</div>
      <div class="rp-tab" onclick="showTab('prop',this)">📄 Proposta</div>
    </div>
    <div class="rp-content" id="tab-rr"></div>
    <div class="rp-content" id="tab-prop" style="display:none"></div>
  </div>
</div>
<script>
const SUPABASE_URL="${SUPABASE_URL}",SUPABASE_KEY="${SUPABASE_KEY}"
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_KEY)
const socket=io()
let telAtivo=null,todasConvs=[],vendaAtiva=null,editando=false
async function checkStatus(){try{const r=await fetch('/status');const d=await r.json();const b=document.getElementById('conn-badge');const l=document.getElementById('qr-link');if(d.connected){b.className='tb-badge badge-ok';b.innerHTML='<span class="dot"></span>Conectado ✓';l.style.display='none'}else{b.className='tb-badge badge-err';b.innerHTML='<span class="dot"></span>Desconectado';l.style.display='inline-block'}}catch(e){}}
socket.on('connected',()=>{checkStatus();carregarConvs()})
socket.on('nova_mensagem',({telefone})=>{if(telefone===telAtivo)carregarMsgs(telefone);carregarConvs()})
checkStatus();setInterval(checkStatus,15000)
async function carregarConvs(){const{data}=await sb.from('whatsapp_conversas').select('*').order('ultima_atualizacao',{ascending:false});todasConvs=data||[];renderConvs(todasConvs)}
function filtrarConvs(){const q=document.getElementById('search-input').value.toLowerCase();renderConvs(q?todasConvs.filter(c=>(c.nome||c.telefone||'').toLowerCase().includes(q)):todasConvs)}
async function renderConvs(lista){const el=document.getElementById('convs-list');if(!lista.length){el.innerHTML='<div style="padding:16px;text-align:center;color:rgba(148,185,210,.50);font-size:12px;">Nenhuma conversa</div>';return}let html='';for(const c of lista){const tel=c.telefone||'';const nome=c.nome||tel;const prev=(c.ultimo_msg||'').substring(0,28);const nr=c.nao_lidas>0?`<span class="nr">${c.nao_lidas}</span>`:'';const ini=nome.split(' ').slice(0,2).map(p=>p[0]?.toUpperCase()||'').join('');const ativo=tel===telAtivo?'active':'';const{data:vd}=await sb.from('vendas').select('status,valor').eq('telefone',tel.replace(/\D/g,'')).order('id',{ascending:false}).limit(1);let tag='';if(vd&&vd[0]){const s=vd[0].status;const v=formatMoney(vd[0].valor);if(s==='Pago')tag=`<span class="prop-tag pt-pago">✅ Pago: ${v}</span>`;else if(s==='Aguardando Assinatura')tag=`<span class="prop-tag pt-agass">🟣 Ag. Assin.</span>`;else if(s==='Aguardando Pagamento')tag=`<span class="prop-tag pt-agpag">🔵 Ag. Pgto</span>`;else if(s)tag=`<span class="prop-tag pt-pend">📄 ${s}: ${v}</span>`;}html+=`<div class="conv ${ativo}" onclick="selecionarConv('${tel}','${nome.replace(/'/g,"\\'")}')" ><div class="av">${ini}</div><div class="conv-info"><div class="conv-top"><span class="conv-name">${nome}</span>${nr}</div><div class="conv-prev">${prev}</div>${tag}</div></div>`}el.innerHTML=html}
async function selecionarConv(tel,nome){telAtivo=tel;editando=false;document.getElementById('ch-av').textContent=nome.split(' ').slice(0,2).map(p=>p[0]?.toUpperCase()||'').join('');document.getElementById('ch-name').textContent=nome;document.getElementById('ch-status').textContent=tel;renderConvs(todasConvs);await sb.from('whatsapp_conversas').update({nao_lidas:0}).eq('telefone',tel);await carregarMsgs(tel);await carregarVenda(tel);renderRespostas()}
async function carregarMsgs(tel){const{data}=await sb.from('whatsapp_mensagens').select('*').eq('telefone',tel).order('timestamp').limit(100);const el=document.getElementById('msgs-area');document.getElementById('empty-msg').style.display='none';const wm=el.querySelector('.wm');let html=wm?wm.outerHTML:'';if(!data||!data.length){html+='<div class="empty-chat"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Nenhuma mensagem ainda.</div>'}else{for(const m of data){const cls=m.de_mim?'msg-m':'msg-d';const ts=(m.timestamp||'').substring(0,16);html+=`<div class="${cls}">${m.conteudo}<div class="msg-ts">${m.de_mim?'✓✓ ':''}${ts}</div></div>`}}el.innerHTML=html;el.scrollTop=el.scrollHeight}
async function carregarVenda(tel){const t=tel.replace(/\D/g,'');const{data}=await sb.from('vendas').select('*').eq('telefone',t).order('id',{ascending:false}).limit(1);vendaAtiva=data&&data[0]?data[0]:null;renderProposta()}
async function iniciarConv(){const t=document.getElementById('new-tel').value.replace(/\D/g,'');if(t.length<10){alert('Número inválido');return}await sb.from('whatsapp_conversas').upsert({telefone:t,ultimo_msg:'',ultima_atualizacao:new Date().toISOString(),nao_lidas:0},{onConflict:'telefone'});document.getElementById('new-tel').value='';await carregarConvs();selecionarConv(t,t)}
async function enviar(){const txt=document.getElementById('msg-input').value.trim();if(!txt||!telAtivo)return;const r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:telAtivo,message:txt})});const d=await r.json();if(d.ok){await sb.from('whatsapp_mensagens').insert({telefone:telAtivo,conteudo:txt,de_mim:true,timestamp:new Date().toISOString()});await sb.from('whatsapp_conversas').upsert({telefone:telAtivo,ultimo_msg:txt,ultima_atualizacao:new Date().toISOString(),nao_lidas:0},{onConflict:'telefone'});document.getElementById('msg-input').value='';await carregarMsgs(telAtivo);await carregarConvs()}else alert('Erro ao enviar: '+(d.error||'desconhecido'))}
async function renderRespostas(){const{data}=await sb.from('whatsapp_respostas_rapidas').select('*').order('id');const el=document.getElementById('tab-rr');let html='<div class="rp-sec">Respostas rápidas</div>';for(const r of(data||[])){html+=`<div class="rr-item" onclick="usarResposta('${r.texto.replace(/'/g,"\\'")}')"><div><div class="rr-title">${r.titulo}</div><div class="rr-prev">${r.texto}</div></div><span class="rr-del" onclick="event.stopPropagation();deletarResposta(${r.id})">✕</span></div>`}html+=`<div class="add-rr" onclick="novaResposta()">+ Nova resposta</div>`;el.innerHTML=html}
function usarResposta(txt){document.getElementById('msg-input').value=txt;document.getElementById('msg-input').focus()}
async function deletarResposta(id){await sb.from('whatsapp_respostas_rapidas').delete().eq('id',id);renderRespostas()}
async function novaResposta(){const tit=prompt('Título:');if(!tit)return;const txt=prompt('Texto:');if(!txt)return;await sb.from('whatsapp_respostas_rapidas').insert({titulo:tit,texto:txt});renderRespostas()}
const STATUS_LIST=['Pendente','Aguardando Pagamento','Aguardando Assinatura','Pago','Cancelado']
const STATUS_CLS={Pendente:'sp-pend','Aguardando Pagamento':'sp-agpag','Aguardando Assinatura':'sp-agass',Pago:'sp-pago',Cancelado:'sp-canc'}
function pillHtml(s){return`<span class="st-pill ${STATUS_CLS[s]||'sp-pend'}"><span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;"></span> ${s}</span>`}
function formatMoney(v){try{return'R$ '+parseFloat(v).toLocaleString('pt-BR',{minimumFractionDigits:2})}catch{return'R$ 0,00'}}
function renderProposta(){const el=document.getElementById('tab-prop');if(!telAtivo){el.innerHTML='<div class="no-prop">Selecione uma conversa</div>';return}if(!editando){if(vendaAtiva){el.innerHTML=`<div class="prop-card"><div class="pc-header"><span class="pc-title">📄 PROPOSTA ATIVA</span><span class="pc-sync">🔄 Supabase</span></div><div class="pf-label">Cliente</div><div class="pf-value">${vendaAtiva.cliente||'—'}</div><div class="pf-label">Tabela/Banco</div><div class="pf-value">${vendaAtiva.tabela_banco||'—'}</div><div class="pf-label">Valor</div><div class="pf-valor">${formatMoney(vendaAtiva.valor)}</div><div class="pf-label" style="margin-top:8px;">Status</div><div style="margin-top:3px;">${pillHtml(vendaAtiva.status||'Pendente')}</div>${vendaAtiva.observacao?'<div class="pf-label" style="margin-top:6px;">Observação</div><div style="font-size:11px;color:#94a3b8;">'+vendaAtiva.observacao+'</div>':''}<button class="edit-btn" onclick="abrirEdicao()">✏️ Editar proposta</button></div>`}else{el.innerHTML=`<div class="no-prop">📋<br>Nenhuma proposta ainda.</div><hr><div class="rp-sec">+ Cadastrar venda</div><div class="ef-label">Cliente</div><input class="ef-input" id="nc-cli" placeholder="Nome"><div class="ef-label">CPF</div><input class="ef-input" id="nc-cpf" placeholder="00000000000"><div class="ef-label">Tabela/Banco</div><input class="ef-input" id="nc-tab" placeholder="3RN CAPITAL..."><div class="ef-label">Valor R$</div><input class="ef-input" id="nc-val" placeholder="5.000,00"><div class="ef-label">Status</div><div class="st-grid">${STATUS_LIST.map((s,i)=>`<div class="st-chip sc-${['pend','agpag','agass','pago','canc'][i]} ${i===0?'sel':''}" onclick="selSt(this)"><span class="st-dot"></span>${s}</div>`).join('')}</div><button class="save-btn" onclick="salvarNovaVenda()">💾 Salvar venda</button>`}}else{const v=vendaAtiva;el.innerHTML=`<div class="rp-sec">✏️ Editar proposta</div><div class="ef-label">Cliente</div><input class="ef-input" id="e-cli" value="${v.cliente||''}"><div class="ef-label">Tabela/Banco</div><input class="ef-input" id="e-tab" value="${v.tabela_banco||''}"><div class="ef-label">Valor R$</div><input class="ef-input" id="e-val" value="${parseFloat(v.valor||0).toFixed(2).replace('.',',')}"><div class="ef-label">Status</div><div class="st-grid">${STATUS_LIST.map((s,i)=>{const c='sc-'+['pend','agpag','agass','pago','canc'][i];return`<div class="st-chip ${c} ${s===v.status?'sel':''}" onclick="selSt(this)"><span class="st-dot"></span>${s}</div>`}).join('')}</div><div class="ef-label">Observação</div><input class="ef-input" id="e-obs" value="${v.observacao||''}"><div id="sync-ok" class="sync-msg">✅ Atualizado no Painel de Vendas!</div><button class="save-btn" onclick="salvarEdicao()">💾 Salvar → Atualiza Painel</button><div class="back-link" onclick="editando=false;renderProposta()">← voltar</div>`}}
function abrirEdicao(){editando=true;renderProposta()}
function selSt(el){document.querySelectorAll('.st-chip').forEach(c=>c.classList.remove('sel'));el.classList.add('sel')}
function getSelStatus(){const s=document.querySelector('.st-chip.sel');return s?STATUS_LIST[['sc-pend','sc-agpag','sc-agass','sc-pago','sc-canc'].findIndex(c=>s.classList.contains(c))]:'Pendente'}
async function salvarNovaVenda(){const cli=document.getElementById('nc-cli').value;const cpf=document.getElementById('nc-cpf').value.replace(/\D/g,'');const tab=document.getElementById('nc-tab').value;const valStr=document.getElementById('nc-val').value;const val=parseFloat(valStr.replace(/\./g,'').replace(',','.'));const st=getSelStatus();if(!cli||!tab||!val){alert('Preencha cliente, tabela e valor');return}await sb.from('vendas').insert({data:new Date().toISOString(),cliente:cli,cpf,telefone:telAtivo.replace(/\D/g,''),produto:tab,tabela_banco:tab,valor:val,status:st,percentual_comissao:0,valor_comissao:0,comissao_empresa:0,valor_comissao_empresa:0,conferido:false,alterado_vendedor:false});await carregarVenda(telAtivo);await carregarConvs()}
async function salvarEdicao(){const cli=document.getElementById('e-cli').value;const tab=document.getElementById('e-tab').value;const valStr=document.getElementById('e-val').value;const val=parseFloat(valStr.replace(/\./g,'').replace(',','.'));const st=getSelStatus();const obs=document.getElementById('e-obs').value;if(!val){alert('Valor inválido');return}await sb.from('vendas').update({cliente:cli,tabela_banco:tab,produto:tab,valor:val,status:st,observacao:obs}).eq('id',vendaAtiva.id);const ok=document.getElementById('sync-ok');ok.style.display='block';setTimeout(async()=>{editando=false;await carregarVenda(telAtivo);await carregarConvs();renderProposta()},1200)}
function showTab(id,tab){document.querySelectorAll('.rp-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');document.getElementById('tab-rr').style.display=id==='rr'?'block':'none';document.getElementById('tab-prop').style.display=id==='prop'?'block':'none';if(id==='prop')renderProposta();else renderRespostas()}
carregarConvs();renderRespostas()
</script>
</body></html>`)
})

io.on("connection", (socket) => {
  if (qrCode) socket.emit("qr", { qr: qrCode })
  if (pairingCode) socket.emit("pairing_code", { code: pairingCode })
  if (connected) socket.emit("connected", { status: "connected" })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => { console.log(`Servidor na porta ${PORT}`); conectar() })
