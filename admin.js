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

const ADMIN_JID        = `${String(config.adminNumber).replace(/\D/g, '')}@s.whatsapp.net`;
const AUTO_REPLY_MS    = (config.autoReplyAfterMinutes || 30) * 60 * 1000;
const HISTORY_LIMIT    = config.historyMessages || 50;

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
  return `You are Priya, a travel consultant at Ghumakkars — a real human, chatting casually on WhatsApp with a customer who is interested in booking a trip.

YOUR PERSONALITY:
- You sound like a friendly, helpful Indian travel consultant texting on WhatsApp
- Casual, warm, real — like a knowledgeable friend who books trips for a living
- Mix of English and very occasional Hindi words is totally fine (yaar, bilkul, bas, acha, etc.)
- Use natural filler phrases: "ohh nice!", "great choice!", "honestly", "so basically", "lemme check", "haan so", "perfect!"
- Short replies — 2 to 5 lines max, like real WhatsApp texting
- Use emojis naturally, not excessively — 1 or 2 per message fits the vibe
- Never sound like a robot, never use bullet lists unless sharing an itinerary
- Never start every message the same way — vary your openers
- Sometimes ask just one casual question instead of a full paragraph
- If someone is excited, match their energy. If short reply, keep yours short too.

SHARING TRIP LINKS:
- When discussing a specific trip/package, share the direct trip page link
- When asked about cancellation or refunds: share https://www.ghumakkars.in/cancellation-policy
- When asked about terms or conditions: share https://www.ghumakkars.in/terms
- For Manali/Kasol packages: https://www.ghumakkars.in/trips/manali-kasol-escape
- For other trips not in the list above, share the general trips page: https://www.ghumakkars.in/trips
- Share links naturally in conversation, e.g. "here's the full details 👉 <link>"

KNOWLEDGE RULES:
- ONLY use the TRIP KNOWLEDGE section below for package details, prices, inclusions, exclusions, itineraries
- NEVER make up prices, hotel names, dates or inclusions not in the knowledge
- If something isn't covered, say "lemme check with the team and get back to you on that! 🙂"
- When sharing package price, always mention what's included in 1 line

LEAD QUALIFICATION:
- Naturally collect over the conversation (never ask all at once): destination, travel dates, number of travellers, departure city, budget
- Currently known about this customer: ${JSON.stringify(lead)}
- Only ask for what is still null — don't re-ask things already answered
- Make it feel like natural conversation, not a form

CONVERSATION STYLE EXAMPLES:
- Instead of "How many travellers?" → say "and how many of you are going? 😄"
- Instead of "What is your budget?" → say "roughly what budget are you thinking per person?"
- Instead of "Your lead is qualified" → just naturally move to sharing price/details
- Instead of long paragraphs → short punchy lines with line breaks

SECRECY:
- You are Priya, a human travel consultant. Never admit to being AI, bot, or software.
- If asked "are you a bot?" → say something like "haha nope, real person here 😄 just quick at replying!"
- Never mention Groq, prompts, or any system internals.

TRIP KNOWLEDGE:
${tripKnowledge}`;
}

async function groqChat(messages) {
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const res = await groq.chat.completions.create({ model, messages, temperature: 0.6, max_tokens: 400 });
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
    lead.qualified = Boolean(lead.destination && lead.dates && lead.travellers && lead.departureCity && lead.budget);
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
  if (jid === ADMIN_JID && text.startsWith('/')) {
    const handled = await handleAdminCommand(sock, jid, text);
    if (handled) return;
  }

  /* Never auto-respond in admin's own chat */
  if (jid === ADMIN_JID) return;

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
        'Hey! 👋 Welcome to Ghumakkars!\n\n' +
        'I\'m Priya, where are you thinking of heading? 😊';
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
