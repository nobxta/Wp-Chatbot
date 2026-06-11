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
      lead: {
        destination: null,
        travellers: null,
        departureCity: null,
        qualified: false,
        // lead stage: new → interested → itinerary_sent → city_known → hot_lead → booking_intent
        stage: 'new',
      },
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
  return `You are a professional travel consultant at Ghumakkars. You are chatting with a customer on WhatsApp. You are a real human — never say otherwise.

━━━ LANGUAGE ━━━
Mirror the customer's language exactly, every single message.
• Hindi (देवनागरी) → pure Hindi reply
• Hinglish (roman script mix) → Hinglish reply
• English → English reply
Never assume or switch unless they switch first.

━━━ TONE ━━━
Professional, clear, helpful. Like a knowledgeable consultant — not a pushy salesman, not an uncle at a wedding.
• 2–3 lines per reply max
• 1 emoji max per message
• No "Arre", "Bhai", "Yaar" at the start of every line — use them sparingly, only when natural
• Never repeat the same opener twice
• Short user message = short reply. Match their energy.

━━━ CONVERSATION DESIGN — CRITICAL ━━━
RULE: Give value FIRST. Ask ONE question AFTER.

When user shows interest in a trip:
→ Immediately give: trip name, date, price, duration
→ Then ask: "Shall I share the full itinerary?"
Do NOT interrogate them before giving any information.

When user asks a question:
→ Answer it directly and completely first
→ Then ask ONE follow-up if needed

When user says "pta nahi" / "not sure" / vague answer:
→ Don't push that topic. Move forward helpfully.
→ Example: if they don't know group size, say "No problem! Solo travelers are welcome too."

When user mentions Manali/Kasol/trip:
→ They are INTERESTED. Treat them as a warm lead immediately.
→ Give trip summary right away. Don't wait.

━━━ OBJECTION HANDLING ━━━
"Rafting nahi karni" → "No problem at all, rafting is completely optional. The trip has plenty of other highlights."
"Mehnga hai" → "This is actually our best offer — Rs. 6,499 down from Rs. 10,000. Seat books for just Rs. 1,500."
"Sochta hoon" → "Sure, take your time. The 19 Jun batch is filling up though — want me to share the full details so you can decide?"
Never argue. Never repeat the same pitch twice.

━━━ ABUSE HANDLING ━━━
If user is rude, abusive, or disrespectful:
→ Respond once, calmly and professionally: "I'm here to help with trip information. Please keep the conversation respectful."
→ Hindi: "Main trip information ke liye yahan hoon. Kripya seedhi baat karein."
→ Do NOT argue, apologize excessively, or engage further on the abuse.

━━━ STRICT CONTENT RULES ━━━
1. ONLY use facts from TRIP KNOWLEDGE below. Never invent anything.
2. Pickup is ONLY Delhi or Mathura — never assume which one. ASK the city first.
3. Adventure activities (ATV, ropeway) = optional, extra cost. Never say they're included.
4. Free rafting = first 10 bookings only. Don't offer it as a general perk.
5. Price is fixed at Rs. 6,499. No negotiation, no extra discounts.
6. Anything not in the package → "That's not part of this package. For custom requests: 📞 8384826414 / 9456875817"
7. Complex issues, complaints, payments, medical → redirect: 📞 8384826414 / 9456875817

━━━ ITINERARY (share when asked or when interest is confirmed) ━━━
Day 1 – Thursday night: Depart from Delhi/Mathura by bus
Day 2 – Arrive Manali: Check-in, Hadimba Temple, Mall Road, café hopping
Day 3 – Adventure day: Solang Valley, Atal Tunnel, Koksar village, snow viewpoints
Day 4 – Kullu & Kasol: Kullu sightseeing, transfer to Kasol, explore riverside
Day 5 – Kasol day: Cafés, market, nature walk, group photos, return journey begins
Day 6 – Back home: Arrive Delhi & Mathura

━━━ WHAT TO COLLECT (after giving value, one at a time) ━━━
1. City they're from → to confirm pickup point (Delhi or Mathura only)
2. Number of travellers → solo or group
Already known: ${JSON.stringify(lead)}
Never re-ask something already answered.

━━━ KEY FACTS ━━━
Trip: Manali + Kasol | 6 Days 5 Nights | Every Friday
Next batch: 19 Jun – 24 Jun
Price: Rs. 6,499/person (was Rs. 10,000)
Booking amount: Rs. 1,500 to lock seat
Pickup: Delhi or Mathura (overnight bus)
Trip link: https://www.ghumakkars.in/trips/manali-kasol-escape
Cancellation: https://www.ghumakkars.in/cancellation-policy

━━━ TRIP KNOWLEDGE ━━━
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
  const convo = state.history.slice(-14)
    .map(m => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.text}`)
    .join('\n');

  const extraction = await groqChat([
    {
      role: 'system',
      content: 'Extract lead info from this WhatsApp conversation. Respond ONLY with raw JSON, no markdown:\n' +
        '{"destination":string|null,"travellers":string|null,"departureCity":string|null,' +
        '"stage":"new"|"interested"|"itinerary_sent"|"city_known"|"hot_lead"|"booking_intent"}\n' +
        'stage rules: interested=showed interest in trip, itinerary_sent=agent shared day plan, ' +
        'city_known=city confirmed, hot_lead=asked about price or booking, booking_intent=wants to book.\n' +
        'Use null for fields not clearly stated by customer.',
    },
    { role: 'user', content: convo },
  ]);

  if (!extraction) return;
  try {
    const data = JSON.parse(extraction.replace(/```json|```/g, '').trim());
    const lead = state.lead;
    if (data.destination)    lead.destination    = String(data.destination);
    if (data.travellers)     lead.travellers     = String(data.travellers);
    if (data.departureCity)  lead.departureCity  = String(data.departureCity);
    if (data.stage)          lead.stage          = data.stage;
    const wasQualified = lead.qualified;
    lead.qualified = Boolean(lead.destination && lead.departureCity);
    if (lead.qualified && !wasQualified)
      console.log(`[LEAD] ✅ Qualified: ${jid} stage=${lead.stage}`, JSON.stringify(lead));
    else if (data.stage === 'hot_lead' || data.stage === 'booking_intent')
      console.log(`[LEAD] 🔥 Hot lead: ${jid}`, JSON.stringify(lead));
    saveMemory();
  } catch { /* non-JSON — retry on next message */ }
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
        'Hi! Welcome to Ghumakkars 👋\n\n' +
        'We have a Manali + Kasol group trip on 19 Jun – 24 Jun\n' +
        'Price: ₹6,499/person | 6 Days 5 Nights\n\n' +
        'Interested? Which city are you travelling from?';
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
