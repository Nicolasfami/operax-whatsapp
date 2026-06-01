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
let sock = null, qrCode = null, pairingCode = null, connected = false, qrReady = false

// Limpa sessão antiga se variável CLEAR_AUTH estiver definida
if (process.env.CLEAR_AUTH) {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
      console.log("Auth limpa!")
    }
  } catch(e) { console.log("Erro ao limpar auth:", e.message) }
}

async function salvarMsg(telefone, conteudo, nome) {
  try {
    await supabase.from("whatsapp_mensagens").insert({ telefone, conteudo, de_mim: false, timestamp: new Date().toISOString() })
    const { data } = await supabase.from("whatsapp_conversas").select("*").eq("telefone", telefone).single().catch(() => ({ data: null }))
    await supabase.from("whatsapp_conversas").upsert({
      telefone, nome: nome || data?.nome || telefone,
      ultimo_msg: conteudo, ultima_atualizacao: new Date().toISOString(),
      nao_lidas: (data?.nao_lidas || 0) + 1
    }, { onConflict: "telefone" })
  } catch (e) { console.error("Erro salvar msg:", e.message) }
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({ version, logger: pino({ level: "silent" }), printQRInTerminal: true, auth: state, browser: ["OPERAX", "Chrome", "1.0"] })
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { qrCode = qr; qrReady = true; connected = false; io.emit("qr", { qr }) }
    if (connection === "close") { qrReady = false;
      connected = false; qrCode = null; pairingCode = null
      const should = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true
      if (should) setTimeout(() => conectar(), 3000)
    }
    if (connection === "open") { connected = true; qrCode = null; pairingCode = null; io.emit("connected", { status: "connected" }); console.log("Conectado!") }
  })
  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const jid = msg.key.remoteJid
      if (!jid || jid.endsWith("@g.us")) continue
      const telefone = jid.replace("@s.whatsapp.net", "")
      const conteudo = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "[midia]"
      const nome = msg.pushName || telefone
      await salvarMsg(telefone, conteudo, nome)
      io.emit("nova_mensagem", { telefone, conteudo, nome })
    }
  })
}

app.get("/status", (req, res) => res.json({ connected, status: connected ? "connected" : "disconnected", has_qr: !!qrCode }))

app.post("/send", async (req, res) => {
  const { to, message } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Desconectado" })
  try {
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post("/request-pairing", async (req, res) => {
  const { phone } = req.body
  const phoneClean = (phone || "").replace(/\D/g, "")
  if (!phoneClean || phoneClean.length < 10) return res.status(400).json({ error: "Numero invalido" })
  if (connected) return res.json({ error: "Ja conectado" })
  if (!sock) return res.status(503).json({ error: "Servidor nao iniciado" })
  try {
    console.log("Aguardando QR ficar pronto para gerar pairing code...")
    // Aguarda o QR ser gerado (ate 30 segundos)
    let tentativas = 0
    while (!qrReady && tentativas < 60) {
      await new Promise(r => setTimeout(r, 500))
      tentativas++
    }
    if (!qrReady) return res.json({ error: "Servidor ainda inicializando, tente novamente em 10 segundos" })
    console.log("QR pronto! Gerando pairing code para:", phoneClean)
    await new Promise(r => setTimeout(r, 1000))
    const code = await sock.requestPairingCode(phoneClean)
    pairingCode = code
    io.emit("pairing_code", { code })
    res.json({ code })
    console.log("Pairing code gerado:", code)
  } catch (e) {
    console.error("Erro pairing:", e.message)
    io.emit("pairing_error", { error: e.message })
    res.json({ error: e.message })
  }
})

app.delete("/auth", (req, res) => {
  try {
    if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
    connected = false; qrCode = null; pairingCode = null
    res.json({ ok: true })
    setTimeout(() => conectar(), 2000)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get("/qr", (req, res) => {
  if (connected) return res.send(`<!DOCTYPE html><html><body style="background:#020c1e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;"><div style="background:#0a1628;border:1px solid rgba(56,189,248,0.3);border-radius:20px;padding:40px;text-align:center;"><div style="font-size:60px;">ok</div><h2 style="color:#22c55e;">Conectado!</h2><p style="color:#94a3b8;">Pode fechar esta janela.</p><a href="/chat" style="display:inline-block;margin-top:16px;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff;padding:10px 24px;border-radius:10px;text-decoration:none;font-weight:700;">Abrir Chat</a></div></body></html>`)
  res.send(`<!DOCTYPE html><html><head><title>OPERAX - Conectar</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>*{box-sizing:border-box;margin:0;padding:0;font-family:sans-serif}body{background:#020c1e;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#0a1628;border:1px solid rgba(56,189,248,0.3);border-radius:20px;padding:36px;text-align:center;max-width:420px;width:100%}.logo{font-size:28px;font-weight:900;color:#fff;letter-spacing:.08em;margin-bottom:4px}.logo span{color:#38bdf8}.sub{color:#64748b;font-size:13px;margin-bottom:24px}.tabs{display:flex;gap:6px;margin-bottom:20px;background:#0f1f3d;border-radius:12px;padding:4px}.tab{flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:700;background:transparent;color:#64748b}.tab.active{background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff}#qr-s,#pair-s{display:none}#qr-s.show,#pair-s.show{display:block}.st{padding:9px 14px;border-radius:8px;font-size:12px;font-weight:700;margin:10px 0}.st.wait{background:rgba(14,165,233,0.1);color:#38bdf8;border:1px solid rgba(14,165,233,0.3)}.st.ok{background:rgba(34,197,94,0.1);color:#22c55e;border:1px solid rgba(34,197,94,0.3)}.st.err{background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.3)}#qrcode{display:flex;justify-content:center;margin:14px 0;min-height:180px;align-items:center}#qrcode img,#qrcode canvas{border-radius:10px;border:7px solid #fff}input{width:100%;background:#0f1f3d;border:1.5px solid rgba(56,189,248,0.4);border-radius:10px;padding:11px 14px;color:#e2f4ff;font-size:15px;letter-spacing:.1em;outline:none;margin:6px 0 14px}input:focus{border-color:#0ea5e9}button.btn{width:100%;background:linear-gradient(90deg,#1848cc,#0ea5e9);border:none;border-radius:10px;padding:13px;color:#fff;font-size:14px;font-weight:700;cursor:pointer}.code-box{background:#0f1f3d;border:2px solid #38bdf8;border-radius:12px;padding:18px;margin:12px 0;letter-spacing:.4em;font-size:26px;font-weight:900;color:#38bdf8}.note{color:#64748b;font-size:11px;text-align:left;line-height:1.7;margin-top:10px}.note b{color:#94a3b8}.spinner{border:3px solid rgba(56,189,248,0.2);border-top:3px solid #38bdf8;border-radius:50%;width:36px;height:36px;animation:spin 1s linear infinite;margin:20px auto}@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="card"><div class="logo">OPERAX <span>CHAT</span></div><div class="sub">Vincular WhatsApp ao sistema</div>
<div class="tabs"><button class="tab active" onclick="sw('qr')">QR Code</button><button class="tab" onclick="sw('pair')">Codigo</button></div>
<div id="qr-s" class="show"><div class="st wait" id="qs">Aguardando QR Code...</div><div id="qrcode"><div class="spinner"></div></div><div class="note">Abra o <b>WhatsApp</b> no celular, va em <b>Dispositivos vinculados</b> e aponte a camera para o QR</div></div>
<div id="pair-s"><div id="pc"><div class="st wait">Digite seu numero com DDD (sem 55)</div><input type="tel" id="ph" placeholder="11999999999" maxlength="13"><button class="btn" onclick="reqCode()">Gerar codigo</button></div>
<div id="pr" style="display:none"><div class="st wait" id="ps">Gerando...</div><div class="code-box" id="pb" style="display:none"></div><div class="note" id="pi" style="display:none"><b>WhatsApp > Dispositivos vinculados > Vincular com numero de telefone</b> > digite o codigo acima</div></div></div>
</div><script>
const s=io();
function sw(t){document.querySelectorAll('.tab').forEach((x,i)=>x.classList.toggle('active',(t==='qr'&&i===0)||(t==='pair'&&i===1)));document.getElementById('qr-s').classList.toggle('show',t==='qr');document.getElementById('pair-s').classList.toggle('show',t==='pair');}
s.on('qr',({qr})=>{document.getElementById('qs').textContent='Escaneie com o WhatsApp';document.getElementById('qrcode').innerHTML='';new QRCode(document.getElementById('qrcode'),{text:qr,width:200,height:200,colorDark:'#000',colorLight:'#fff'});});
s.on('connected',()=>{['qs','ps'].forEach(id=>{const el=document.getElementById(id);if(el){el.className='st ok';el.textContent='Conectado! Redirecionando...'}});setTimeout(()=>location.href='/chat',1500);});
s.on('pairing_code',({code})=>{document.getElementById('ps').textContent='Digite no WhatsApp:';const b=document.getElementById('pb');b.textContent=code;b.style.display='block';document.getElementById('pi').style.display='block';});
s.on('pairing_error',({error})=>{const el=document.getElementById('ps');el.className='st err';el.textContent='Erro: '+error;});
function reqCode(){const p=document.getElementById('ph').value.replace(/\D/g,'');if(p.length<10){alert('Numero invalido');return;}document.getElementById('pc').style.display='none';document.getElementById('pr').style.display='block';fetch('/request-pairing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p})}).then(r=>r.json()).then(d=>{if(d.error){document.getElementById('ps').className='st err';document.getElementById('ps').textContent='Erro: '+d.error;}});}
fetch('/status').then(r=>r.json()).then(d=>{if(d.connected){document.getElementById('qs').className='st ok';document.getElementById('qs').textContent='Ja conectado!';document.getElementById('qrcode').innerHTML='<div style="font-size:50px;margin:20px">ok</div>';}});
</script></body></html>`)
})

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
.tb-logo{width:32px;height:32px;border-radius:9px;background:#1d4ed8;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.tb-title{font-family:'Orbitron',sans-serif;font-size:16px;font-weight:900;color:#fff;letter-spacing:.08em;}
.tb-title span{color:#38bdf8;}
.tb-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:700;margin-left:auto;}
.badge-ok{background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.35);}
.badge-err{background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.35);}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;}
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
.msgs{flex:1;padding:14px 18px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;background:#dff0fb;}
.msgs::-webkit-scrollbar{width:3px;}
.msgs::-webkit-scrollbar-thumb{background:rgba(14,165,233,0.20);}
.msg-d{align-self:flex-start;background:rgba(255,255,255,.90);border:1px solid rgba(14,165,233,.18);border-radius:3px 13px 13px 13px;padding:8px 12px;max-width:72%;font-size:13px;color:#0c2a4a;}
.msg-m{align-self:flex-end;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border-radius:13px 3px 13px 13px;padding:8px 12px;max-width:72%;font-size:13px;color:#fff;}
.msg-ts{font-size:10px;opacity:.60;margin-top:3px;text-align:right;}
.chat-input{background:#071828;padding:10px 14px;border-top:1px solid rgba(56,189,248,0.15);display:flex;align-items:center;gap:8px;flex-shrink:0;}
.chat-input input{flex:1;background:#0a1e32;border:1px solid rgba(56,189,248,0.22);border-radius:20px;padding:9px 14px;color:#e0f2fe;font-size:13px;outline:none;}
.chat-input input::placeholder{color:rgba(148,185,210,.38);}
.chat-input input:focus{border-color:#38bdf8;}
.send-btn{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border:none;cursor:pointer;color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;}
.right-panel{width:260px;background:#071828;border-left:1px solid rgba(56,189,248,0.15);display:flex;flex-direction:column;flex-shrink:0;}
.rp-tabs{display:flex;border-bottom:1px solid rgba(56,189,248,0.12);}
.rp-tab{flex:1;padding:10px 4px;text-align:center;font-size:11px;font-weight:700;color:rgba(125,211,252,.50);cursor:pointer;border-bottom:2px solid transparent;transition:.15s;}
.rp-tab.active{color:#38bdf8;border-bottom-color:#38bdf8;}
.rp-content{flex:1;overflow-y:auto;padding:8px;}
.rp-sec{font-size:10px;font-weight:700;color:#38bdf8;letter-spacing:.10em;text-transform:uppercase;padding:4px 2px 6px;}
.rr-item{padding:7px 9px;background:#0a1e32;border:1px solid rgba(56,189,248,.13);border-radius:8px;cursor:pointer;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;}
.rr-item:hover{border-color:rgba(56,189,248,.40);}
.rr-title{font-size:12px;font-weight:700;color:#7dd3fc;}
.rr-prev{font-size:10px;color:rgba(148,185,210,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;}
.rr-del{font-size:12px;color:rgba(248,113,133,.50);cursor:pointer;padding:2px 4px;}
.rr-del:hover{color:#f87171;}
.add-rr{padding:7px 9px;background:rgba(56,189,248,.05);border:1px dashed rgba(56,189,248,.22);border-radius:8px;text-align:center;font-size:11px;color:rgba(125,211,252,.50);cursor:pointer;margin-bottom:8px;}
.add-rr:hover{border-color:#38bdf8;}
hr{border:none;border-top:1px solid rgba(56,189,248,.10);margin:8px 0;}
.prop-card{background:#0a1e32;border:1px solid rgba(56,189,248,.25);border-radius:10px;padding:12px;}
.pc-title{font-size:11px;font-weight:700;color:#38bdf8;}
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
.no-prop{background:#0a1e32;border:1px dashed rgba(56,189,248,.20);border-radius:10px;padding:14px;text-align:center;color:rgba(148,185,210,.55);font-size:12px;line-height:1.6;}
.ef-label{font-size:9px;font-weight:700;color:rgba(125,211,252,.65);letter-spacing:.08em;text-transform:uppercase;margin:5px 0 2px;}
.ef-input{width:100%;background:#0a1e32;border:1px solid rgba(56,189,248,.18);border-radius:7px;padding:6px 9px;color:#c8e8f8;font-size:12px;outline:none;margin-bottom:2px;}
.ef-input:focus{border-color:#38bdf8;}
.st-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin:4px 0;}
.st-chip{display:flex;align-items:center;gap:4px;padding:5px 7px;border-radius:6px;cursor:pointer;border:1px solid rgba(56,189,248,.10);background:#0a1e32;font-size:10px;color:#94a3b8;}
.st-chip.sel{border-color:rgba(56,189,248,.50);background:#0d2a44;color:#e0f2fe;}
.st-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.sc-pend .st-dot{background:#facc15;}.sc-agpag .st-dot{background:#38bdf8;}
.sc-agass .st-dot{background:#a78bfa;}.sc-pago .st-dot{background:#4ade80;}
.sc-canc .st-dot{background:#f87171;}
.save-btn{width:100%;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);border:none;border-radius:8px;padding:8px;color:#fff;font-size:11px;font-weight:700;cursor:pointer;margin-top:6px;}
.sync-msg{background:rgba(74,222,128,.10);border:1px solid rgba(74,222,128,.25);border-radius:6px;padding:6px;font-size:10px;color:#4ade80;text-align:center;margin-top:6px;display:none;}
.back-link{font-size:10px;color:rgba(125,211,252,.40);cursor:pointer;text-align:center;margin-top:6px;}
.empty-chat{flex:1;display:flex;align-items:center;justify-content:center;color:rgba(14,80,130,.55);font-size:13px;text-align:center;flex-direction:column;gap:8px;}
</style>
</head>
<body>
<div class="topbar">
  <div class="tb-logo">O</div>
  <span class="tb-title">OPERAX <span>CHAT</span></span>
  <div id="conn-badge" class="tb-badge badge-err"><span class="dot"></span> Verificando...</div>
  <a href="/qr" target="_blank" id="qr-link" style="display:none;margin-left:8px;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff;padding:5px 12px;border-radius:8px;font-size:11px;font-weight:700;text-decoration:none;">Conectar</a>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="sb-search"><input id="search-input" placeholder="Buscar conversa..." oninput="filtrarConvs()"></div>
    <div class="sb-label">Conversas</div>
    <div class="convs" id="convs-list"><div style="padding:16px;text-align:center;color:rgba(148,185,210,.50);font-size:12px;">Carregando...</div></div>
    <div class="sb-new">
      <label>Nova conversa</label>
      <input id="new-tel" placeholder="11999999999" maxlength="15">
      <button onclick="iniciarConv()">Iniciar</button>
    </div>
  </div>
  <div class="chat-main">
    <div class="chat-header">
      <div class="ch-av" id="ch-av">?</div>
      <div><div class="ch-name" id="ch-name">Selecione uma conversa</div><div class="ch-status" id="ch-status"></div></div>
    </div>
    <div class="msgs" id="msgs-area">
      <div class="empty-chat" id="empty-msg">Selecione uma conversa ao lado</div>
    </div>
    <div class="chat-input">
      <input id="msg-input" placeholder="Digite uma mensagem..." onkeydown="if(event.key==='Enter')enviar()">
      <button class="send-btn" onclick="enviar()">></button>
    </div>
  </div>
  <div class="right-panel">
    <div class="rp-tabs">
      <div class="rp-tab active" onclick="showTab('rr',this)">Respostas</div>
      <div class="rp-tab" onclick="showTab('prop',this)">Proposta</div>
    </div>
    <div class="rp-content" id="tab-rr"></div>
    <div class="rp-content" id="tab-prop" style="display:none"></div>
  </div>
</div>
<script>
var SURL="https://ynxpowhzhnwqazdxshch.supabase.co",SKEY="sb_publishable_aATPGJyG-Q8KuLLflByr8w_nrHxt0mt";
var sb=supabase.createClient(SURL,SKEY),socket=io();
var telAtivo=null,todasConvs=[],vendaAtiva=null,editando=false;
var SL=['Pendente','Aguardando Pagamento','Aguardando Assinatura','Pago','Cancelado'];
var SC={Pendente:'sp-pend','Aguardando Pagamento':'sp-agpag','Aguardando Assinatura':'sp-agass',Pago:'sp-pago',Cancelado:'sp-canc'};
function fm(v){try{return'R$ '+parseFloat(v).toLocaleString('pt-BR',{minimumFractionDigits:2});}catch(e){return'R$ 0,00';}}
function pill(s){return'<span class="st-pill '+(SC[s]||'sp-pend')+'"><span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;"></span> '+s+'</span>';}
async function checkStatus(){try{var r=await fetch('/status'),d=await r.json(),b=document.getElementById('conn-badge'),l=document.getElementById('qr-link');if(d.connected){b.className='tb-badge badge-ok';b.innerHTML='<span class="dot"></span> Conectado';l.style.display='none';}else{b.className='tb-badge badge-err';b.innerHTML='<span class="dot"></span> Desconectado';l.style.display='inline-block';}}catch(e){}}
socket.on('connected',function(){checkStatus();carregarConvs();});
socket.on('nova_mensagem',function(d){if(d.telefone===telAtivo)carregarMsgs(d.telefone);carregarConvs();});
checkStatus();setInterval(checkStatus,15000);
async function carregarConvs(){var r=await sb.from('whatsapp_conversas').select('*').order('ultima_atualizacao',{ascending:false});todasConvs=r.data||[];renderConvs(todasConvs);}
function filtrarConvs(){var q=document.getElementById('search-input').value.toLowerCase();renderConvs(q?todasConvs.filter(function(c){return(c.nome||c.telefone||'').toLowerCase().includes(q);}):todasConvs);}
async function renderConvs(lista){var el=document.getElementById('convs-list');if(!lista.length){el.innerHTML='<div style="padding:16px;text-align:center;color:rgba(148,185,210,.50);font-size:12px;">Nenhuma conversa</div>';return;}var html='';for(var i=0;i<lista.length;i++){var c=lista[i],tel=c.telefone||'',nome=c.nome||tel,prev=(c.ultimo_msg||'').substring(0,28),nr=c.nao_lidas>0?'<span class="nr">'+c.nao_lidas+'</span>':'',ini=nome.split(' ').slice(0,2).map(function(p){return p[0]?p[0].toUpperCase():'';}).join(''),ativo=tel===telAtivo?'active':'';var vd=await sb.from('vendas').select('status,valor').eq('telefone',tel.replace(/\D/g,'')).order('id',{ascending:false}).limit(1);var tag='';if(vd.data&&vd.data[0]){var s=vd.data[0].status,v=fm(vd.data[0].valor);if(s==='Pago')tag='<span class="prop-tag pt-pago">Pago: '+v+'</span>';else if(s==='Aguardando Assinatura')tag='<span class="prop-tag pt-agass">Ag.Assin.</span>';else if(s==='Aguardando Pagamento')tag='<span class="prop-tag pt-agpag">Ag.Pgto</span>';else if(s)tag='<span class="prop-tag pt-pend">'+s+'</span>';}var ns=nome.replace(/\\/g,'\\\\').replace(/'/g,"\\'");html+='<div class="conv '+ativo+'" onclick="sel(\''+tel+'\',\''+ns+'\')">'+'<div class="av">'+ini+'</div>'+'<div class="conv-info"><div class="conv-top"><span class="conv-name">'+nome+'</span>'+nr+'</div>'+'<div class="conv-prev">'+prev+'</div>'+tag+'</div></div>';}el.innerHTML=html;}
async function sel(tel,nome){telAtivo=tel;editando=false;document.getElementById('ch-av').textContent=nome.split(' ').slice(0,2).map(function(p){return p[0]?p[0].toUpperCase():'';}).join('');document.getElementById('ch-name').textContent=nome;document.getElementById('ch-status').textContent=tel;renderConvs(todasConvs);await sb.from('whatsapp_conversas').update({nao_lidas:0}).eq('telefone',tel);await carregarMsgs(tel);await carregarVenda(tel);renderRR();}
async function carregarMsgs(tel){var r=await sb.from('whatsapp_mensagens').select('*').eq('telefone',tel).order('timestamp').limit(100),el=document.getElementById('msgs-area'),data=r.data||[];if(!data.length){el.innerHTML='<div class="empty-chat">Nenhuma mensagem ainda.</div>';return;}var html='';for(var i=0;i<data.length;i++){var m=data[i],cls=m.de_mim?'msg-m':'msg-d',ts=(m.timestamp||'').substring(0,16);html+='<div class="'+cls+'">'+m.conteudo+'<div class="msg-ts">'+ts+'</div></div>';}el.innerHTML=html;el.scrollTop=el.scrollHeight;}
async function carregarVenda(tel){var t=tel.replace(/\D/g,''),r=await sb.from('vendas').select('*').eq('telefone',t).order('id',{ascending:false}).limit(1);vendaAtiva=r.data&&r.data[0]?r.data[0]:null;renderProp();}
async function iniciarConv(){var t=document.getElementById('new-tel').value.replace(/\D/g,'');if(t.length<10){alert('Invalido');return;}await sb.from('whatsapp_conversas').upsert({telefone:t,ultimo_msg:'',ultima_atualizacao:new Date().toISOString(),nao_lidas:0},{onConflict:'telefone'});document.getElementById('new-tel').value='';await carregarConvs();sel(t,t);}
async function enviar(){var txt=document.getElementById('msg-input').value.trim();if(!txt||!telAtivo)return;var r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:telAtivo,message:txt})}),d=await r.json();if(d.ok){await sb.from('whatsapp_mensagens').insert({telefone:telAtivo,conteudo:txt,de_mim:true,timestamp:new Date().toISOString()});await sb.from('whatsapp_conversas').upsert({telefone:telAtivo,ultimo_msg:txt,ultima_atualizacao:new Date().toISOString(),nao_lidas:0},{onConflict:'telefone'});document.getElementById('msg-input').value='';await carregarMsgs(telAtivo);await carregarConvs();}else alert('Erro: '+(d.error||'?'));}
async function renderRR(){var r=await sb.from('whatsapp_respostas_rapidas').select('*').order('id'),el=document.getElementById('tab-rr'),html='<div class="rp-sec">Respostas rapidas</div>';for(var i=0;i<(r.data||[]).length;i++){var rr=r.data[i],t=rr.texto.replace(/\\/g,'\\\\').replace(/'/g,"\\'");html+='<div class="rr-item" onclick="useRR(\''+t+'\')">'+'<div><div class="rr-title">'+rr.titulo+'</div><div class="rr-prev">'+rr.texto+'</div></div>'+'<span class="rr-del" onclick="event.stopPropagation();delRR('+rr.id+')">X</span></div>';}html+='<div class="add-rr" onclick="novaRR()">+ Nova resposta</div>';el.innerHTML=html;}
function useRR(txt){document.getElementById('msg-input').value=txt;document.getElementById('msg-input').focus();}
async function delRR(id){await sb.from('whatsapp_respostas_rapidas').delete().eq('id',id);renderRR();}
async function novaRR(){var t=prompt('Titulo:');if(!t)return;var tx=prompt('Texto:');if(!tx)return;await sb.from('whatsapp_respostas_rapidas').insert({titulo:t,texto:tx});renderRR();}
function renderProp(){var el=document.getElementById('tab-prop');if(!telAtivo){el.innerHTML='<div class="no-prop">Selecione uma conversa</div>';return;}if(!editando){if(vendaAtiva){var v=vendaAtiva,html='<div class="prop-card">';html+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><span class="pc-title">PROPOSTA ATIVA</span><span style="font-size:9px;color:#4ade80;">sync</span></div>';html+='<div class="pf-label">Cliente</div><div class="pf-value">'+(v.cliente||'--')+'</div>';html+='<div class="pf-label">Tabela/Banco</div><div class="pf-value">'+(v.tabela_banco||'--')+'</div>';html+='<div class="pf-label">Valor</div><div class="pf-valor">'+fm(v.valor)+'</div>';html+='<div class="pf-label" style="margin-top:8px;">Status</div><div style="margin-top:3px;">'+pill(v.status||'Pendente')+'</div>';if(v.observacao)html+='<div class="pf-label" style="margin-top:6px;">Obs</div><div style="font-size:11px;color:#94a3b8;">'+v.observacao+'</div>';html+='<button class="edit-btn" onclick="abrirEd()">Editar proposta</button></div>';el.innerHTML=html;}else{var html='<div class="no-prop">Nenhuma proposta ainda.</div><hr><div class="rp-sec">Cadastrar venda</div>';html+='<div class="ef-label">Cliente</div><input class="ef-input" id="nc-cli" placeholder="Nome">';html+='<div class="ef-label">CPF</div><input class="ef-input" id="nc-cpf" placeholder="00000000000">';html+='<div class="ef-label">Tabela/Banco</div><input class="ef-input" id="nc-tab" placeholder="tabela...">';html+='<div class="ef-label">Valor R$</div><input class="ef-input" id="nc-val" placeholder="5.000,00">';html+='<div class="ef-label">Status</div><div class="st-grid">';var cls2=['pend','agpag','agass','pago','canc'];for(var i=0;i<SL.length;i++)html+='<div class="st-chip sc-'+cls2[i]+' '+(i===0?'sel':'')+'" onclick="selSt(this)"><span class="st-dot"></span>'+SL[i]+'</div>';html+='</div><button class="save-btn" onclick="salvarNova()">Salvar venda</button>';el.innerHTML=html;}}else{var v=vendaAtiva,html='<div class="rp-sec">Editar proposta</div>';html+='<div class="ef-label">Cliente</div><input class="ef-input" id="e-cli" value="'+(v.cliente||'')+'">';html+='<div class="ef-label">Tabela/Banco</div><input class="ef-input" id="e-tab" value="'+(v.tabela_banco||'')+'">';html+='<div class="ef-label">Valor R$</div><input class="ef-input" id="e-val" value="'+parseFloat(v.valor||0).toFixed(2).replace('.',',')+'">';html+='<div class="ef-label">Status</div><div class="st-grid">';var cls3=['pend','agpag','agass','pago','canc'];for(var i=0;i<SL.length;i++)html+='<div class="st-chip sc-'+cls3[i]+' '+(SL[i]===v.status?'sel':'')+'" onclick="selSt(this)"><span class="st-dot"></span>'+SL[i]+'</div>';html+='</div><div class="ef-label">Obs</div><input class="ef-input" id="e-obs" value="'+(v.observacao||'')+'">';html+='<div id="sync-ok" class="sync-msg">Atualizado!</div>';html+='<button class="save-btn" onclick="salvarEd()">Salvar - Atualiza Painel</button>';html+='<div class="back-link" onclick="editando=false;renderProp()">voltar</div>';el.innerHTML=html;}}
function abrirEd(){editando=true;renderProp();}
function selSt(el){document.querySelectorAll('.st-chip').forEach(function(c){c.classList.remove('sel');});el.classList.add('sel');}
function getSt(){var s=document.querySelector('.st-chip.sel');if(!s)return'Pendente';var cls=['sc-pend','sc-agpag','sc-agass','sc-pago','sc-canc'];for(var i=0;i<cls.length;i++){if(s.classList.contains(cls[i]))return SL[i];}return'Pendente';}
async function salvarNova(){var cli=document.getElementById('nc-cli').value,cpf=document.getElementById('nc-cpf').value.replace(/\D/g,''),tab=document.getElementById('nc-tab').value,val=parseFloat(document.getElementById('nc-val').value.replace(/\./g,'').replace(',','.')),st=getSt();if(!cli||!tab||!val){alert('Preencha tudo');return;}await sb.from('vendas').insert({data:new Date().toISOString(),cliente:cli,cpf:cpf,telefone:telAtivo.replace(/\D/g,''),produto:tab,tabela_banco:tab,valor:val,status:st,percentual_comissao:0,valor_comissao:0,comissao_empresa:0,valor_comissao_empresa:0,conferido:false,alterado_vendedor:false});await carregarVenda(telAtivo);await carregarConvs();}
async function salvarEd(){var cli=document.getElementById('e-cli').value,tab=document.getElementById('e-tab').value,val=parseFloat(document.getElementById('e-val').value.replace(/\./g,'').replace(',','.')),st=getSt(),obs=document.getElementById('e-obs').value;if(!val){alert('Valor invalido');return;}await sb.from('vendas').update({cliente:cli,tabela_banco:tab,produto:tab,valor:val,status:st,observacao:obs}).eq('id',vendaAtiva.id);var ok=document.getElementById('sync-ok');ok.style.display='block';setTimeout(async function(){editando=false;await carregarVenda(telAtivo);await carregarConvs();renderProp();},1200);}
function showTab(id,tab){document.querySelectorAll('.rp-tab').forEach(function(t){t.classList.remove('active');});tab.classList.add('active');document.getElementById('tab-rr').style.display=id==='rr'?'block':'none';document.getElementById('tab-prop').style.display=id==='prop'?'block':'none';if(id==='prop')renderProp();else renderRR();}
carregarConvs();renderRR();
</script>
</body></html>`)
})

io.on("connection", (socket) => {
  if (qrCode) socket.emit("qr", { qr: qrCode })
  if (pairingCode) socket.emit("pairing_code", { code: pairingCode })
  if (connected) socket.emit("connected", { status: "connected" })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => { console.log("Servidor na porta " + PORT); conectar() })
