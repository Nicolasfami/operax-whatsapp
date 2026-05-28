import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import express from 'express'
import cors from 'cors'
import qrcode from 'qrcode'
import pino from 'pino'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ynxpowhzhnwqazdxshch.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_aATPGJyG-Q8KuLLflByr8w_nrHxt0mt'
const PORT = process.env.PORT || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const app = express()
app.use(cors())
app.use(express.json())

const logger = pino({ level: 'silent' })

let sock = null
let qrCodeBase64 = null
let connected = false
let reconnecting = false

async function conectar() {
  if (reconnecting) return
  reconnecting = true

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: ['Operax Sales', 'Chrome', '1.0.0']
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeBase64 = await qrcode.toDataURL(qr)
      connected = false
      console.log('QR Code gerado!')
    }
    if (connection === 'open') {
      connected = true
      qrCodeBase64 = null
      reconnecting = false
      console.log('WhatsApp conectado!')
      await supabase.from('whatsapp_status').upsert({ id: 1, conectado: true, atualizado_em: new Date().toISOString() })
    }
    if (connection === 'close') {
      connected = false
      reconnecting = false
      const codigo = lastDisconnect?.error?.output?.statusCode
      await supabase.from('whatsapp_status').upsert({ id: 1, conectado: false, atualizado_em: new Date().toISOString() })
      if (codigo !== DisconnectReason.loggedOut) {
        setTimeout(conectar, 5000)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue
      const de = msg.key.remoteJid
      const numero = de.replace('@s.whatsapp.net', '').replace('@g.us', '')
      const nome = msg.pushName || numero
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[midia]'
      const hora = new Date(msg.messageTimestamp * 1000).toISOString()
      console.log(`Mensagem de ${nome}: ${texto}`)
      await supabase.from('mensagens_whatsapp').insert({ numero, nome, mensagem: texto, de_mim: false, criado_em: hora, lida: false, msg_id: msg.key.id })
      await supabase.from('conversas_whatsapp').upsert({ numero, nome, ultima_mensagem: texto, atualizado_em: hora }, { onConflict: 'numero' })
    }
  })

  reconnecting = false
}

// Pagina visual do QR Code
app.get('/qr', (req, res) => {
  if (connected) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Operax WhatsApp</title></head><body style="font-family:Arial;text-align:center;padding:50px;background:#0a1628;color:#fff"><h1 style="color:#25D366">✅ WhatsApp Conectado!</h1><p style="color:#7dd3fc">O servidor está online e pronto para receber mensagens.</p></body></html>`)
  }
  if (!qrCodeBase64) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Operax WhatsApp</title></head><body style="font-family:Arial;text-align:center;padding:50px;background:#0a1628;color:#fff"><h2 style="color:#38bdf8">⏳ Gerando QR Code...</h2><p style="color:#7dd3fc">Aguarde, a página vai atualizar automaticamente.</p></body></html>`)
  }
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Operax WhatsApp - QR Code</title></head><body style="font-family:Arial;text-align:center;padding:30px;background:#0a1628;color:#fff"><h1 style="color:#38bdf8">📱 Operax WhatsApp</h1><h3 style="color:#7dd3fc">Escaneie o QR Code com seu WhatsApp</h3><img src="${qrCodeBase64}" style="width:300px;height:300px;border:4px solid #38bdf8;border-radius:16px;"/><p style="color:#94a3b8;margin-top:20px">Abra o WhatsApp → Menu → Aparelhos conectados → Conectar aparelho</p></body></html>`)
})

app.get('/status', (req, res) => {
  res.json({ conectado: connected, tem_qr: !!qrCodeBase64 })
})

app.post('/enviar', async (req, res) => {
  const { numero, mensagem } = req.body
  if (!connected) return res.status(400).json({ erro: 'WhatsApp nao conectado' })
  if (!numero || !mensagem) return res.status(400).json({ erro: 'Informe numero e mensagem' })
  try {
    let num = numero.replace(/\D/g, '')
    if (!num.startsWith('55')) num = '55' + num
    const jid = num + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: mensagem })
    await supabase.from('mensagens_whatsapp').insert({ numero: num, mensagem, de_mim: true, criado_em: new Date().toISOString(), lida: true })
    await supabase.from('conversas_whatsapp').upsert({ numero: num, ultima_mensagem: mensagem, atualizado_em: new Date().toISOString() }, { onConflict: 'numero' })
    res.json({ sucesso: true })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

app.post('/desconectar', async (req, res) => {
  if (sock) { await sock.logout(); connected = false }
  res.json({ sucesso: true })
})

app.get('/', (req, res) => {
  res.json({ servico: 'Operax WhatsApp Server', versao: '1.0.0', conectado: connected, status: connected ? 'online' : 'aguardando QR' })
})

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
  conectar()
})
