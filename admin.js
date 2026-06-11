/**
 * ============================================================
 *  WhatsApp AI Travel Sales Assistant
 *  Built on @whiskeysockets/baileys (no Chrome/Puppeteer)
 * ============================================================
 *  Files used:
 *    - admin.js        (this file)
 *    - config.json     (settings)
 *    - trips.txt       (trip knowledge base)
 *
 *  Auto-generated at runtime:
 *    - auth_info/      (WhatsApp session — persisted via useMultiFileAuthState)
 *    - chat_memory.json
 *
 *  Run: node admin.js
 * ============================================================
 */

const fs   = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

/* Baileys + helpers */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino    = require('pino');
const qrcode  = require('qrcode-terminal');

/* ============================================================
 * 1. CONFIG
 * ============================================================ */

const CONFIG_PATH = path.join(__dirname, 'config.json');
const TRIPS_PATH  = path.join(__dirname, 'trips.txt');
const MEMORY_PATH = path.join(__dirname, 'chat_memory.json');
const AUTH_DIR    = path.join(__dirname, 'auth_info');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error('[FATAL] Cannot read config.json:', err.message);
  process.exit(1);
}

if (!config.groqApiKey || config.groqApiKey.startsWith('PASTE_')) {
  console.error('[FATAL] Set "groqApiKey" in config.json');
  process.exit(1);
}

// Support single adminNumber or array of adminNumbers
const adminNumbers = Array.isArray(config.adminNumbers)
  ? config.adminNumbers
  : [config.adminNumber];
const ADMIN_JIDS    = adminNumbers.map(n => `${String(n).replace(/\D/g, '')}@s.whatsapp.net`);
const ADMIN_JID     = ADMIN_JIDS[0]; // primary admin for commands
const AUTO_REPLY_MS = (config.autoReplyAfterMinutes || 30) * 60 * 1000;
const HISTORY_LIMIT = config.historyMessages || 50;

/* ============================================================
 * 2. TRIP KNOWLEDGE BASE
 * ============================================================ */

let tripKnowledge = '';
function loadTrips() {
  try {
    tripKnowledge = fs.readFileSync(TRIPS_PATH, 'utf8');
    console.log(`[INFO] Loaded trips.txt (${tripKnowledge.length} chars)`);
  } catch {
    tripKnowledge = 'No package information available right now.';
  }
}
loadTrips();
fs.watchFile(TRIPS_PATH, { interval: 5000 }, loadTrips);

/* ============================================================
 * 3. CHAT MEMORY + LEADS
 * ============================================================ */

let memory = {};
try {
  if (fs.existsSync(MEMORY_PATH))
    memory = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  console.log(`[INFO] Loaded memory for ${Object.keys(memory).length} chats`);
} catch {
  memory = {};
}

let saveTimer = null;
function saveMemory() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2)); }
    catch (e) { console.error('[ERROR] Saving memory:', e.message); }
  }, 1000);
}

function getChatState(jid) {
  if (!memory[jid]) {
    memory[jid] = {
      history: [],
      lead: { destination: null, dates: null, travellers: null, departureCity: null, budget: null, qualified: false },
      welcomed: false,
      lastAdminReplyTs: 0,
    };
  }
  return memory[jid];
}

function pushHistory(jid, role, text) {
  const s = getChatState(jid);
  s.history.push({ role, text, ts: Date.now() });
  if (s.history.length > HISTORY_LIMIT)
    s.history = s.history.slice(-HISTORY_LIMIT);
  saveMemory();
}

/* ============================================================
 * 4. GROQ AI
 * ============================================================ */

const groq           = new Groq({ apiKey: config.groqApiKey });
const PRIMARY_MODEL  = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

function buildSystemPrompt(lead) {
  return `You are a professional travel consultant at Ghumakkars, chatting on WhatsApp. You are a real human — never admit otherwise.

LANGUAGE: Detect and match the customer's language every reply.
- Hindi script → reply in Hindi
- Hinglish (roman Hindi) → reply in Hinglish
- English → reply in English
Never switch unless they do.

TONE & FORMAT:
- Professional yet warm and friendly, like a knowledgeable consultant
- WhatsApp style: 2–3 short lines max, 1–2 emojis
- Never send walls of text or bullet lists in normal chat
- Vary your openers, never sound scripted

STRICT RULES — READ CAREFULLY:
1. ONLY answer from the TRIP KNOWLEDGE below. Never invent or assume anything.
2. If asked for something NOT in the package (extra hotel, custom itinerary, special food, anything not listed) → say it's not part of this package and redirect to team: 📞 8384826414 / 9456875817
3. Adventure activities (ATV, ropeway etc.) are OPTIONAL and NOT included — be clear about this
4. FREE river rafting is ONLY for first 10 bookings — don't offer it generally
5. Price is fixed: Rs. 6,499/person (was Rs. 10,000). Never negotiate or offer discounts beyond what's in the data.
6. Pickup is ONLY from Delhi or Mathura — no other pickup points exist
7. For complaints, payments, refunds, medical, or anything complex → don't guess, send to team: 📞 8384826414 / 9456875817

ITINERARY EXPLANATION (when asked):
- Day 1 (Thursday night): Board bus from Delhi/Mathura, overnight journey
- Day 2: Arrive Manali, check-in, Hadimba Temple, Mall Road
- Day 3: Solang Valley, Atal Tunnel, Koksar — full adventure day
- Day 4: Kullu sightseeing, then drive to Kasol
- Day 5: Full day in Kasol — cafés, river, market, group photos, then return journey
- Day 6: Arrive back Delhi/Mathura, trip ends
Explain this naturally in conversation, not as a list unless they ask for full itinerary.

COLLECT NATURALLY (one at a time, never re-ask):
- City (for pickup point) | How many people
- Known so far: ${JSON.stringify(lead)}

KEY INFO TO SHARE WHEN RELEVANT:
- Next batch: 19 Jun – 24 Jun (trips run every Friday)
- Booking amount: Rs. 1,500 to confirm seat
- Trip link: https://www.ghumakkars.in/trips/manali-kasol-escape
- Cancellation policy: https://www.ghumakkars.in/cancellation-policy

TRIP KNOWLEDGE:
${tripKnowledge}`;
}

async function groqChat(messages) {
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const res = await groq.chat.completions.create({ model, messages, temperature: 0.5, max_tokens: 220 });
      const text = res.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (err) {
      console.error(`[ERROR] Groq (${model}):`, err.message);
    }
  }
  return null;
}

async function generateReply(jid, customerMessage) {
  const state = getChatState(jid);
  const messages = [{ role: 'system', content: buildSystemPrompt(state.lead) }];
  for (const m of state.history.slice(-HISTORY_LIMIT))
    messages.push({ role: m.role === 'assistant' || m.role === 'admin' ? 'assistant' : 'user', content: m.text });
  messages.push({ role: 'user', content: customerMessage });
  return groqChat(messages);
}

async function updateLeadInfo(jid) {
  const state = getChatState(jid);
  const convo = state.history.slice(-20)
    .map(m => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.text}`)
    .join('\n');

  const extraction = await groqChat([
    { role: 'system', content: 'Extract travel lead details from the conversation. Respond ONLY with raw JSON (no markdown): {"destination":string|null,"dates":string|null,"travellers":string|null,"departureCity":string|null,"budget":string|null}. Use null for anything not clearly stated by the customer.' },
    { role: 'user', content: convo },
  ]);

  if (!extraction) return;
  try {
    const data = JSON.parse(extraction.replace(/```json|```/g, '').trim());
    const lead = state.lead;
    for (const key of ['destination', 'dates', 'travellers', 'departureCity', 'budget'])
      if (data[key]) lead[key] = String(data[key]);
    const wasQualified = lead.qualified;
    lead.qualified = Boolean(lead.destination && lead.travellers && lead.departureCity);
    if (lead.qualified && !wasQualified)
      console.log(`[LEAD] ✅ Qualified: ${jid} →`, JSON.stringify(lead));
    saveMemory();
  } catch { /* non-JSON extraction — retry next message */ }
}

/* ============================================================
 * 5. ADMIN COMMANDS
 * ============================================================ */

async function handleAdminCommand(sock, jid, text) {
  const cmd = text.trim().toLowerCase();

  if (cmd === '/ai on') {
    config.botEnabled = true;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await sock.sendMessage(jid, { text: '🤖 AI replies: *ENABLED*' });
    return true;
  }
  if (cmd === '/ai off') {
    config.botEnabled = false;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await sock.sendMessage(jid, { text: '🤖 AI replies: *DISABLED*' });
    return true;
  }
  if (cmd === '/status') {
    const chats = Object.keys(memory).length;
    const qualified = Object.values(memory).filter(s => s.lead?.qualified).length;
    await sock.sendMessage(jid, {
      text: `📊 *Bot Status*\n\nAI: ${config.botEnabled ? '✅ ON' : '❌ OFF'}\nWhatsApp: ✅ Connected\nStored chats: ${chats}\nQualified leads: ${qualified}`,
    });
    return true;
  }
  if (cmd === '/help') {
    await sock.sendMessage(jid, {
      text: '🛠 *Admin Commands*\n\n/ai on — enable AI replies\n/ai off — disable AI replies\n/status — show bot status\n/help — show this help',
    });
    return true;
  }
  return false;
}

/* ============================================================
 * 6. WHATSAPP CONNECTION
 * ============================================================ */

const processedIds = new Set();
const replyLocks   = new Set();
let   sock         = null;

async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),   // suppress Baileys internal logs
    printQRInTerminal: false,            // we handle QR ourselves
    browser: ['Travel Bot', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  /* ---- QR ---- */
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n[INFO] Scan this QR code with WhatsApp (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('\n✅ Connected Successfully\n');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log(`\n❌ WhatsApp Disconnected (code ${reason})`);

      if (shouldReconnect) {
        console.log('[INFO] Reconnecting in 5s...');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('[INFO] Logged out. Delete auth_info/ folder and restart to re-link.');
      }
    }
  });

  /* ---- Persist credentials on update ---- */
  sock.ev.on('creds.update', saveCreds);

  /* ---- Incoming messages ---- */
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;

    for (const msg of msgs) {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error('[ERROR] handleMessage:', err.message);
      }
    }
  });
}

/* ============================================================
 * 7. MESSAGE HANDLER
 * ============================================================ */

async function handleMessage(msg) {
  if (!msg?.key?.remoteJid) return;

  const jid    = msg.key.remoteJid;
  const fromMe = msg.key.fromMe;

  /* Ignore groups, broadcasts, status */
  if (isJidGroup(jid))     return;
  if (isJidBroadcast(jid)) return;
  if (jid === 'status@broadcast') return;

  /* Extract text from various message types */
  const m       = msg.message;
  const rawText = m?.conversation
    || m?.extendedTextMessage?.text
    || m?.imageMessage?.caption
    || m?.videoMessage?.caption
    || (m?.buttonsResponseMessage?.selectedButtonId ? `[Button: ${m.buttonsResponseMessage.selectedButtonId}]` : null)
    || (m?.listResponseMessage?.singleSelectReply?.selectedRowId ? `[List: ${m.listResponseMessage.singleSelectReply.selectedRowId}]` : null)
    || '';

  /* ---- Track MY outgoing messages (from phone or web) ---- */
  if (fromMe) {
    const state = getChatState(jid);
    state.lastAdminReplyTs = Date.now();
    if (rawText) pushHistory(jid, 'admin', rawText);
    return;
  }

  /* De-duplicate */
  const msgId = msg.key.id;
  if (msgId) {
    if (processedIds.has(msgId)) return;
    processedIds.add(msgId);
    if (processedIds.size > 2000) processedIds.delete(processedIds.values().next().value);
  }

  const text = rawText.trim();

  /* ---- Admin commands (only from admin number) ---- */
  const isAdmin = ADMIN_JIDS.includes(jid);

  if (isAdmin && text.startsWith('/')) {
    const handled = await handleAdminCommand(sock, jid, text);
    if (handled) return;
  }

  /* Never auto-respond in any admin's own chat */
  if (isAdmin) return;

  /* Media without caption */
  const displayText = text || (m && !m.conversation ? '[Customer sent media]' : '');
  if (!displayText) return;

  const state         = getChatState(jid);
  const isFirstContact = state.history.length === 0 && !state.welcomed;

  pushHistory(jid, 'user', displayText);

  /* Bot disabled */
  if (!config.botEnabled) return;

  /* Don't interrupt active human conversation */
  const sinceAdmin = Date.now() - (state.lastAdminReplyTs || 0);
  if (state.lastAdminReplyTs && sinceAdmin < AUTO_REPLY_MS) {
    console.log(`[SKIP] ${jid}: admin replied ${Math.round(sinceAdmin / 60000)}m ago`);
    return;
  }

  /* Prevent concurrent replies for same chat */
  if (replyLocks.has(jid)) return;
  replyLocks.add(jid);

  try {
    let reply;

    if (isFirstContact) {
      reply =
        'Hey! 👋 Ghumakkars mein aapka swagat hai!\n\n' +
        'Hum har Friday ko group trips chalate hain 🏔️\n' +
        'Abhi next batch hai 19 Jun - Manali + Kasol!\n\n' +
        'Aap kahan se ho?';
      state.welcomed = true;
    } else {
      reply = await generateReply(jid, displayText);
    }

    if (!reply) {
      console.error(`[ERROR] No AI reply for ${jid}`);
      return;
    }

    pushHistory(jid, 'assistant', reply);
    await sock.sendMessage(jid, { text: reply });
    console.log(`[REPLY] → ${jid}: ${reply.slice(0, 80).replace(/\n/g, ' ')}...`);

    updateLeadInfo(jid).catch(e => console.error('[ERROR] Lead extraction:', e.message));
  } finally {
    replyLocks.delete(jid);
  }
}

/* ============================================================
 * 8. STARTUP
 * ============================================================ */

process.on('unhandledRejection', err => console.error('[ERROR] Unhandled rejection:', err?.message || err));
process.on('uncaughtException',  err => console.error('[ERROR] Uncaught exception:',  err?.message || err));

console.log('[INFO] Starting WhatsApp AI Travel Assistant (Baileys — no Chrome needed)...');
connectToWhatsApp();
