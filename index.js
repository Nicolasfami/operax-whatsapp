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

// ─── CONFIG ───
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://ynxpowhzhnwqazdxshch.supabase.co'
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || 'sb_publishable_aATPGJyG-Q8KuLLflByr8w_nrHxt0mt'
const PORT          = process.env.PORT          || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const app      = express()
app.use(cors())
app.use(express.json())

const logger = pino({ level: 'silent' })

let sock         = null
let qrCodeBase64 = null
let connected    = false
let reconnecting = false

// ─── CONECTAR WHATSAPP ───
async function conectar() {
  if (reconnecting) return
  reconnecting = true

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version }          = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: ['Operax Sales', 'Chrome', '1.0.0']
  })

  // QR Code
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeBase64 = await qrcode.toDataURL(qr)
      connected    = false
      console.log('QR Code gerado — acesse /qr para visualizar')
    }

    if (connection === 'open') {
      connected    = true
      qrCodeBase64 = null
      reconnecting = false
      console.log('WhatsApp conectado!')

      // Salva status no Supabase
      await supabase.from('whatsapp_status').upsert({
        id: 1, conectado: true, atualizado_em: new Date().toISOString()
      })
    }

    if (connection === 'close') {
      connected    = false
      reconnecting = false
      const codigo = lastDisconnect?.error?.output?.statusCode
      console.log('Desconectado, código:', codigo)

      // Salva status no Supabase
      await supabase.from('whatsapp_status').upsert({
        id: 1, conectado: false, atualizado_em: new Date().toISOString()
      })

      // Reconecta se não foi logout
      if (codigo !== DisconnectReason.loggedOut) {
        console.log('Reconectando em 5 segundos...')
        setTimeout(conectar, 5000)
      } else {
        console.log('Sessão encerrada — escaneie o QR novamente')
        qrCodeBase64 = null
      }
    }
  })

  // Salva credenciais
  sock.ev.on('creds.update', saveCreds)

  // ─── RECEBE MENSAGENS ───
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const de       = msg.key.remoteJid
      const numero   = de.replace('@s.whatsapp.net', '').replace('@g.us', '')
      const nome     = msg.pushName || numero
      const texto    = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || '[mídia]'
      const hora     = new Date(msg.messageTimestamp * 1000).toISOString()

      console.log(`📩 ${nome} (${numero}): ${texto}`)

      // Salva mensagem no Supabase
      await supabase.from('mensagens_whatsapp').insert({
        numero,
        nome,
        mensagem:   texto,
        de_mim:     false,
        criado_em:  hora,
        lida:       false,
        msg_id:     msg.key.id
      })

      // Atualiza ou cria conversa
      await supabase.from('conversas_whatsapp').upsert({
        numero,
        nome,
        ultima_mensagem:  texto,
        atualizado_em:    hora,
        nao_lidas:        1
      }, { onConflict: 'numero', ignoreDuplicates: false })
    }
  })

  reconnecting = false
}

// ─── ROTAS API ───

// Status da conexão
app.get('/status', (req, res) => {
  res.json({ conectado: connected, tem_qr: !!qrCodeBase64 })
})

// QR Code para escanear
app.get('/qr', (req, res) => {
  if (connected) {
    return res.json({ status: 'conectado', mensagem: 'WhatsApp já está conectado!' })
  }
  if (!qrCodeBase64) {
    return res.json({ status: 'aguardando', mensagem: 'Gerando QR Code, aguarde...' })
  }
  res.json({ status: 'qr', qr: qrCodeBase64 })
})

// Enviar mensagem
app.post('/enviar', async (req, res) => {
  const { numero, mensagem } = req.body

  if (!connected) {
    return res.status(400).json({ erro: 'WhatsApp não conectado' })
  }

  if (!numero || !mensagem) {
    return res.status(400).json({ erro: 'Informe numero e mensagem' })
  }

  try {
    // Formata número brasileiro
    let num = numero.replace(/\D/g, '')
    if (!num.startsWith('55')) num = '55' + num
    const jid = num + '@s.whatsapp.net'

    await sock.sendMessage(jid, { text: mensagem })

    // Salva no Supabase
    await supabase.from('mensagens_whatsapp').insert({
      numero:     num,
      mensagem,
      de_mim:     true,
      criado_em:  new Date().toISOString(),
      lida:       true
    })

    // Atualiza conversa
    await supabase.from('conversas_whatsapp').upsert({
      numero:           num,
      ultima_mensagem:  mensagem,
      atualizado_em:    new Date().toISOString()
    }, { onConflict: 'numero' })

    res.json({ sucesso: true, mensagem: 'Enviado!' })
  } catch (e) {
    console.error('Erro ao enviar:', e)
    res.status(500).json({ erro: e.message })
  }
})

// Desconectar
app.post('/desconectar', async (req, res) => {
  if (sock) {
    await sock.logout()
    connected = false
  }
  res.json({ sucesso: true })
})

// Health check
app.get('/', (req, res) => {
  res.json({
    servico:   'Operax WhatsApp Server',
    versao:    '1.0.0',
    conectado: connected,
    status:    connected ? 'online' : 'aguardando QR'
  })
})

// ─── INICIA ───
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
  conectar()
})
