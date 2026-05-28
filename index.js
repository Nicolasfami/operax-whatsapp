const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const { createClient } = require("@supabase/supabase-js")
const pino = require("pino")
const fs = require("fs")
const path = require("path")

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
let sock = null
let qrCode = null
let pairingCode = null
let connected = false
let pairingRequested = false

async function salvarMensagemRecebida(telefone, conteudo, nome) {
  try {
    await supabase.from("whatsapp_mensagens").insert({
      telefone, conteudo, de_mim: false, timestamp: new Date().toISOString()
    })
    const { data } = await supabase.from("whatsapp_conversas").select("*").eq("telefone", telefone).single()
    if (data) {
      await supabase.from("whatsapp_conversas").update({
        ultimo_msg: conteudo,
        ultima_atualizacao: new Date().toISOString(),
        nao_lidas: (data.nao_lidas || 0) + 1,
        nome: nome || data.nome
      }).eq("telefone", telefone)
    } else {
      await supabase.from("whatsapp_conversas").insert({
        telefone, nome: nome || telefone,
        ultimo_msg: conteudo,
        ultima_atualizacao: new Date().toISOString(),
        nao_lidas: 1
      })
    }
  } catch (e) {
    console.error("Erro ao salvar mensagem:", e.message)
  }
}

async function conectar(usePairingCode = false, phoneNumber = null) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: !usePairingCode,
    auth: state,
    browser: ["OPERAX SALES", "Chrome", "1.0"],
  })

  // Pairing code
  if (usePairingCode && phoneNumber && !sock.authState.creds.registered) {
    const phone = phoneNumber.replace(/\D/g, "")
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone)
        pairingCode = code
        console.log("Pairing code gerado:", code)
        io.emit("pairing_code", { code })
      } catch (e) {
        console.error("Erro ao gerar pairing code:", e.message)
        io.emit("pairing_error", { error: e.message })
      }
    }, 3000)
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrCode = qr
      connected = false
      io.emit("qr", { qr })
      console.log("QR Code gerado")
    }

    if (connection === "close") {
      connected = false
      qrCode = null
      pairingCode = null
      pairingRequested = false
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true
      console.log("Desconectado. Reconectando:", shouldReconnect)
      if (shouldReconnect) {
        setTimeout(() => conectar(), 3000)
      }
    }

    if (connection === "open") {
      connected = true
      qrCode = null
      pairingCode = null
      console.log("✅ WhatsApp conectado!")
      io.emit("connected", { status: "connected" })
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
      const conteudo =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "[mídia]"
      const nome = msg.pushName || telefone
      console.log(`Mensagem de ${telefone}: ${conteudo}`)
      await salvarMensagemRecebida(telefone, conteudo, nome)
      io.emit("nova_mensagem", { telefone, conteudo, nome })
    }
  })
}

// =====================
// ROTAS
// =====================

app.get("/status", (req, res) => {
  res.json({
    connected,
    status: connected ? "connected" : "disconnected",
    has_qr: !!qrCode,
    has_pairing_code: !!pairingCode
  })
})

app.get("/qr", (req, res) => {
  if (connected) {
    return res.send(`<!DOCTYPE html><html><body style="background:#020c1e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;"><div style="background:#0a1628;border:1px solid rgba(56,189,248,0.3);border-radius:20px;padding:40px;text-align:center;max-width:400px;"><div style="font-size:60px;margin-bottom:16px;">✅</div><h2 style="color:#22c55e;font-size:22px;margin:0 0 8px;">WhatsApp Conectado!</h2><p style="color:#94a3b8;font-size:14px;">Você já pode fechar esta janela e usar o sistema.</p></div></body></html>`)
  }
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>OPERAX - Conectar WhatsApp</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;font-family:sans-serif}
    body{background:#020c1e;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#0a1628;border:1px solid rgba(56,189,248,0.3);border-radius:20px;padding:40px;text-align:center;max-width:420px;width:100%}
    .logo{font-size:32px;font-weight:900;color:#fff;letter-spacing:.08em;margin-bottom:4px}
    .logo span{color:#38bdf8}
    .sub{color:#64748b;font-size:13px;margin-bottom:28px}
    .tabs{display:flex;gap:8px;margin-bottom:24px;background:#0f1f3d;border-radius:12px;padding:4px}
    .tab{flex:1;padding:10px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:700;transition:.2s;background:transparent;color:#64748b}
    .tab.active{background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff}
    #qr-section, #pairing-section{display:none}
    #qr-section.show, #pairing-section.show{display:block}
    #qrcode{display:flex;justify-content:center;margin:16px 0;min-height:200px;align-items:center}
    #qrcode img, #qrcode canvas{border-radius:12px;border:8px solid #fff}
    .status{padding:10px 16px;border-radius:10px;font-size:13px;font-weight:700;margin:12px 0}
    .status.waiting{background:rgba(14,165,233,0.1);color:#38bdf8;border:1px solid rgba(14,165,233,0.3)}
    .status.connected{background:rgba(34,197,94,0.1);color:#22c55e;border:1px solid rgba(34,197,94,0.3)}
    .status.error{background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.3)}
    input{width:100%;background:#0f1f3d;border:1.5px solid rgba(56,189,248,0.4);border-radius:12px;padding:12px 16px;color:#e2f4ff;font-size:16px;letter-spacing:.1em;outline:none;margin:8px 0 16px}
    input:focus{border-color:#0ea5e9;box-shadow:0 0 0 3px rgba(14,165,233,0.15)}
    input::placeholder{color:#334155;letter-spacing:normal}
    button.btn{width:100%;background:linear-gradient(90deg,#1848cc,#0ea5e9);border:none;border-radius:12px;padding:14px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px}
    button.btn:hover{opacity:.9}
    .code-box{background:#0f1f3d;border:2px solid #38bdf8;border-radius:14px;padding:20px;margin:16px 0;letter-spacing:.5em;font-size:28px;font-weight:900;color:#38bdf8;text-shadow:0 0 20px rgba(56,189,248,0.5)}
    .instructions{color:#64748b;font-size:12px;text-align:left;line-height:1.7;margin-top:12px}
    .instructions b{color:#94a3b8}
    .spinner{border:3px solid rgba(56,189,248,0.2);border-top:3px solid #38bdf8;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:20px auto}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">OPERAX <span>SALES</span></div>
  <div class="sub">Conectar WhatsApp ao sistema</div>

  <div class="tabs">
    <button class="tab active" onclick="showTab('qr')">📷 QR Code</button>
    <button class="tab" onclick="showTab('pairing')">🔑 Código</button>
  </div>

  <div id="qr-section" class="show">
    <div class="status waiting" id="qr-status">Aguardando QR Code...</div>
    <div id="qrcode"><div class="spinner"></div></div>
    <div class="instructions">
      Abra o <b>WhatsApp</b> no celular → <b>Menu (⋮)</b> → <b>Dispositivos vinculados</b> → <b>Vincular dispositivo</b> → Aponte a câmera para o QR
    </div>
  </div>

  <div id="pairing-section">
    <div id="pairing-content">
      <div class="status waiting">Digite seu número com DDD para receber o código</div>
      <input type="tel" id="phone-input" placeholder="Ex: 11999999999" maxlength="15">
      <button class="btn" onclick="solicitarCodigo()">🔑 Gerar código</button>
    </div>
    <div id="pairing-result" style="display:none">
      <div class="status waiting" id="pairing-status">Gerando código...</div>
      <div class="code-box" id="pairing-code-box" style="display:none"></div>
      <div class="instructions" id="pairing-instructions" style="display:none">
        No celular: <b>WhatsApp → Dispositivos vinculados → Vincular dispositivo → Vincular com número de telefone</b> → Digite o código acima
      </div>
    </div>
  </div>
</div>

<script>
const socket = io()
let qrGenerated = false

function showTab(tab) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', (tab==='qr'&&i===0)||(tab==='pairing'&&i===1)))
  document.getElementById('qr-section').classList.toggle('show', tab==='qr')
  document.getElementById('pairing-section').classList.toggle('show', tab==='pairing')
}

socket.on('qr', ({qr}) => {
  document.getElementById('qr-status').textContent = '📱 Escaneie com o WhatsApp'
  document.getElementById('qrcode').innerHTML = ''
  new QRCode(document.getElementById('qrcode'), {text:qr, width:220, height:220, colorDark:'#000', colorLight:'#fff'})
  qrGenerated = true
})

socket.on('connected', () => {
  document.getElementById('qr-status').className = 'status connected'
  document.getElementById('qr-status').textContent = '✅ Conectado! Pode fechar esta janela.'
  document.getElementById('qrcode').innerHTML = '<div style="font-size:60px;margin:20px 0">✅</div>'
  document.getElementById('pairing-status').className = 'status connected'
  document.getElementById('pairing-status').textContent = '✅ Conectado! Pode fechar esta janela.'
})

socket.on('pairing_code', ({code}) => {
  document.getElementById('pairing-status').textContent = 'Digite este código no WhatsApp:'
  const box = document.getElementById('pairing-code-box')
  box.textContent = code
  box.style.display = 'block'
  document.getElementById('pairing-instructions').style.display = 'block'
})

socket.on('pairing_error', ({error}) => {
  document.getElementById('pairing-status').className = 'status error'
  document.getElementById('pairing-status').textContent = 'Erro: ' + error
})

function solicitarCodigo() {
  const phone = document.getElementById('phone-input').value.replace(/\\D/g,'')
  if (phone.length < 10) { alert('Digite um número válido com DDD'); return }
  document.getElementById('pairing-content').style.display = 'none'
  document.getElementById('pairing-result').style.display = 'block'
  fetch('/request-pairing', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone})})
    .then(r => r.json())
    .then(d => { if (d.error) { document.getElementById('pairing-status').className='status error'; document.getElementById('pairing-status').textContent = 'Erro: '+d.error } })
    .catch(e => { document.getElementById('pairing-status').className='status error'; document.getElementById('pairing-status').textContent = 'Erro de conexão' })
}

if (!qrGenerated) {
  fetch('/status').then(r=>r.json()).then(d => {
    if (d.connected) {
      document.getElementById('qr-status').className='status connected'
      document.getElementById('qr-status').textContent='✅ Já conectado!'
      document.getElementById('qrcode').innerHTML='<div style="font-size:60px;margin:20px 0">✅</div>'
    }
  })
}
</script>
</body>
</html>`)
})

app.post("/request-pairing", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ error: "Número obrigatório" })
  if (!sock) return res.json({ error: "Servidor não iniciado" })
  if (connected) return res.json({ error: "Já conectado" })
  try {
    pairingRequested = true
    const code = await sock.requestPairingCode(phone.replace(/\D/g, ""))
    pairingCode = code
    io.emit("pairing_code", { code })
    res.json({ code })
  } catch (e) {
    io.emit("pairing_error", { error: e.message })
    res.json({ error: e.message })
  }
})

app.post("/send", async (req, res) => {
  const { to, message } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "WhatsApp não conectado" })
  try {
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get("/mensagens/:telefone", async (req, res) => {
  try {
    const { data } = await supabase.from("whatsapp_mensagens").select("*").eq("telefone", req.params.telefone).order("timestamp").limit(100)
    res.json(data || [])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get("/conversas", async (req, res) => {
  try {
    const { data } = await supabase.from("whatsapp_conversas").select("*").order("ultima_atualizacao", { ascending: false })
    res.json(data || [])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete("/auth", (req, res) => {
  try {
    if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
    connected = false
    qrCode = null
    pairingCode = null
    pairingRequested = false
    res.json({ ok: true, message: "Auth removida. Reiniciando..." })
    setTimeout(() => conectar(), 2000)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

io.on("connection", (socket) => {
  if (qrCode) socket.emit("qr", { qr: qrCode })
  if (pairingCode) socket.emit("pairing_code", { code: pairingCode })
  if (connected) socket.emit("connected", { status: "connected" })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
  conectar()
})
