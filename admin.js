/**
 * ============================================================
 *  WhatsApp AI Travel Sales Assistant — Ghumakkars
 *  Built on @whiskeysockets/baileys (no Chrome/Puppeteer)
 * ============================================================
 */

'use strict';

// Suppress Baileys "Closing session" spam — it writes via process.stdout.write directly
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.includes('Closing session')) return true;
  return _origStdoutWrite(chunk, ...rest);
};
const _origLog = console.log.bind(console);
console.log = (...args) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.startsWith('Closing session') || first.startsWith('session closed')) return;
  _origLog(...args);
};

const fs     = require('fs');
const path   = require('path');
const Groq   = require('groq-sdk');
const OpenAI = require('openai');

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
const pino   = require('pino');
const qrcode = require('qrcode-terminal');

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

const adminNumbers = Array.isArray(config.adminNumbers)
  ? config.adminNumbers
  : [config.adminNumber];
// Mutable — LIDs appended after connection or from config.adminLids
const ADMIN_JIDS = adminNumbers.map(n => `${String(n).replace(/\D/g, '')}@s.whatsapp.net`);
// Support manually configured LIDs in config: "adminLids": ["241875445375097"]
const adminLids = Array.isArray(config.adminLids) ? config.adminLids : [];
for (const lid of adminLids) {
  const lidJid = `${lid}@lid`;
  if (!ADMIN_JIDS.includes(lidJid)) ADMIN_JIDS.push(lidJid);
}
const AUTO_REPLY_MS = (config.autoReplyAfterMinutes || 30) * 60 * 1000;
const HISTORY_LIMIT = config.historyMessages || 8;

// Payment / booking config — update these in config.json
const PAYMENT_LINK   = config.paymentLink   || 'https://www.ghumakkars.in/trips/manali-kasol-escape';
const TRIP_LINK      = config.tripLink      || 'https://www.ghumakkars.in/trips/manali-kasol-escape';
const CANCEL_LINK    = config.cancelLink    || 'https://www.ghumakkars.in/cancellation-policy';
const TERMS_LINK     = config.termsLink     || 'https://www.ghumakkars.in/terms';
const TEAM_NUMBERS   = config.teamNumbers   || '8384826414 / 9456875817';

/* ============================================================
 * 2. TRIP KNOWLEDGE
 * ============================================================ */

let tripKnowledge = '';
let tripCompact   = '';   // short version for every message
let tripDetailed  = '';   // long version only when itinerary/FAQ asked

function loadTrips() {
  try {
    tripKnowledge = fs.readFileSync(TRIPS_PATH, 'utf8');
    // Compact = everything up to "ITINERARY SUMMARY" line
    const split = tripKnowledge.indexOf('ITINERARY SUMMARY');
    tripCompact  = split > -1 ? tripKnowledge.slice(0, split).trim() : tripKnowledge;
    tripDetailed = tripKnowledge;
    console.log(`[INFO] Loaded trips.txt (${tripKnowledge.length} chars)`);
  } catch {
    tripKnowledge = tripCompact = tripDetailed = 'No trip data available.';
  }
}
loadTrips();
fs.watchFile(TRIPS_PATH, { interval: 5000 }, loadTrips);

/* ============================================================
 * 3. MEMORY
 * Lead stages: new → interested → itinerary_sent → booking_started
 *              → payment_pending → confirmed | ghosted | followup
 * ============================================================ */

let memory = {};
try {
  if (fs.existsSync(MEMORY_PATH))
    memory = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  console.log(`[INFO] Loaded memory for ${Object.keys(memory).length} chats`);
} catch { memory = {}; }

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
        stage: 'new',           // conversation stage
        destination: null,
        travellers: null,
        departureCity: null,
        qualified: false,
        bookingStep: null,      // name | age | gender | city | done
        booking: {},            // collected booking details
        abuseCount: 0,
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
 * 4. INTENT DETECTION  (code-level, runs before AI)
 * ============================================================ */

const GREET_REGEX   = /^(hi|hello|hey|hii|hlo|helo|good\s*(morning|evening|night|afternoon)|start|restart|namaste|namaskar|hy|sup|yo)\s*[!.]*$/i;
const BOOK_REGEX    = /\b(book|booking|seat|advance|pay|payment|confirm|register|enroll|lena hai|le lena|le lu|buk|le loon|book kar|booking karni)\b/i;
const PRICE_REGEX   = /\b(price|kitna|cost|amount|fees|charge|rate|paisa|rupee|rs\b|₹|kitne ka|kitni|lagega|lagta|how much)\b/i;
const ITIN_REGEX    = /\b(itinerary|schedule|plan|details|day|programme|batao|bata|kya kya|kahan kahan|places|poora|pura|full|trip details)\b/i;
const CANCEL_REGEX  = /\b(cancel|refund|return|wapas|nahi aana|drop|policy|cancellation)\b/i;
const DEST_REGEX    = /\b(manali|kasol|goa|kashmir|kedarnath|shimla|leh|ladakh|spiti|rishikesh|mussoorie|nainital|dharamshala|mcleodganj)\b/i;
const ABUSE_WORDS   = ['aukat','gali','bc ','mc ','chutiya','bhen','madarch','harami','bkl','bsdk','randi','gaand','bhench','teri maa'];
const BYE_REGEX     = /^(bye|goodbye|ok bye|tata|alvida|chal bye|no thanks|nahi chahiye|nhi chahiye|nahi\s*ji|nope|not interested|nahi\s*chahiye)\s*[!.]*$/i;
// Pure acknowledgements — no new info, conversation should move forward or end naturally
const ACK_REGEX     = /^(ok|okay|k|cool|got it|noted|fine|sure|alright|accha|theek hai|theek|haan|ha|ha ji|ho|hmm|nice|great|perfect|👍|👌|thank you|thanks|thnx|thx|ty|done|understood)\s*[!.]*$/i;

function detectIntent(text) {
  const t = text.toLowerCase().trim();
  if (ABUSE_WORDS.some(w => t.includes(w))) return 'ABUSE';
  if (GREET_REGEX.test(t))  return 'GREET';
  if (BYE_REGEX.test(t))    return 'BYE';
  if (ACK_REGEX.test(t))    return 'ACK';
  if (BOOK_REGEX.test(t))   return 'BOOK';
  if (PRICE_REGEX.test(t))  return 'PRICE';
  if (ITIN_REGEX.test(t))   return 'ITINERARY';
  if (CANCEL_REGEX.test(t)) return 'CANCEL';
  if (DEST_REGEX.test(t))   return 'DESTINATION';
  return 'GENERAL';
}

// Extract group size from message (e.g. "25 log", "10 people", "hum 15 hain")
function extractGroupSize(text) {
  const m = text.match(/\b(\d+)\s*(log|people|person|persons|friends|members|travellers?|travelers?|hai|hain|h)\b/i)
           || text.match(/\bhum\s+(\d+)\b/i)
           || text.match(/\b(\d+)\s+(?:ka\s+)?group\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// Resets topic context but keeps lead identity
function softReset(state) {
  state.lead.bookingStep       = null;
  state.lead.lastHandoffReplyTs = 0;
  // Keep stage, city, travellers — just don't reference them unprompted
  state.history = []; // clear history so AI starts fresh
  saveMemory();
}

/* ============================================================
 * 5. MULTI-PROVIDER AI
 * ============================================================
 * Model list — admin selects by number via /model N
 * Add more entries here anytime.
 */

const AI_MODELS = [
  {
    id: 1,
    name: 'Groq — Llama 3.3 70B',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    fallback: 'llama-3.1-8b-instant',
  },
  {
    id: 2,
    name: 'Groq — Llama 3.1 8B Fast',
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    fallback: null,
  },
  {
    id: 3,
    name: 'NVIDIA — StepFun 3.7 Flash',
    provider: 'nvidia',
    model: 'stepfun-ai/step-3.7-flash',
    apiKey: () => config.nvidiaApiKey1,
  },
  {
    id: 4,
    name: 'NVIDIA — GPT OSS 120B',
    provider: 'nvidia',
    model: 'openai/gpt-oss-120b',
    apiKey: () => config.nvidiaApiKey2,
  },
];

// Active model index — persisted in config.json
let activeModelId = config.activeModel || 1;
function getActiveModel() {
  return AI_MODELS.find(m => m.id === activeModelId) || AI_MODELS[0];
}

// Provider clients
const groq = new Groq({ apiKey: config.groqApiKey });

const nvidiaClients = {};
function getNvidiaClient(apiKey) {
  if (!nvidiaClients[apiKey]) {
    nvidiaClients[apiKey] = new OpenAI({
      apiKey,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });
  }
  return nvidiaClients[apiKey];
}

function buildSystemPrompt(lead) {
  return `You are Support — a real human travel consultant chatting on WhatsApp for Ghumakkars.
Goal: help travelers, answer naturally, build trust, collect what's needed, maximize qualified bookings.

PRIORITY ORDER
1. Understand the user's latest message.
2. Continue the conversation naturally.
3. Use everything already shared in chat — never ask again.
4. Help the user make a decision.
5. Share trip info only when relevant.

QUALITY CHECK BEFORE EVERY REPLY — ask yourself:
1. What did the user just say?
2. What do I already know about them?
3. Am I repeating something I already said?
4. Is this response actually useful?
5. Would a real human send this message?
If the answer to 3, 4, or 5 is no — rewrite.

CONVERSATION STYLE
- Real WhatsApp human. Not customer support. Not a brochure.
- Match language: Hindi → Hindi, English → English, Hinglish → Hinglish.
- Max 2–3 lines. 1 emoji every 4–5 messages (not every reply).
- Mirror tone: casual if they're casual, formal if they're formal.
- Use "bro" if they do. First name if known. "Sir/ma'am" only when genuinely formal.
- Never ignore what the user said. Never repeat the same answer twice.

PICKUP & DATES
- Pickup: Delhi Akshardham only. Do NOT mention Mathura.
- Route city? "If your city falls on our route, we can usually arrange a nearby pickup — let me check with the team."
- Never promise route pickup without team confirmation.
- Trips depart every Friday. Share nearest batch first, then ask preferred month/weekend.

PRICING
- Price is fixed for individuals. Never negotiate. Never ask budget for an existing itinerary.
- If user says expensive: explain value — stays, transport, meals, coordinator, 6 days. Don't argue.
- Groups 8+: "For larger groups, special pricing may sometimes be available."

GROUP LEADS (8+ travelers)
- High priority. Shift to qualifying mode immediately.
- Collect: group size, preferred dates, departure city, trip type (friends/college/office/family).
- Never treat a group lead like a solo traveler.

CUSTOM TRIPS
- Different destination/dates/private/corporate/family → collect destination, dates, group size, departure city.
- Then: "I'll share this with our team and they'll check available options."
- Never end a custom-trip inquiry without collecting requirements.

LEAD RETENTION
- "Mehenga", "sochna hai", "later", "not sure" → understand reason before ending.
- Budget issue? Date issue? Group issue? Leave? Ask one relevant question.
- Don't pressure. Be helpful and confident.

ACK HANDLING ("ok", "cool", "thanks", "noted", "👍", "haan")
- Do NOT repeat previous information.
- Move forward, confirm next step, or end naturally. If nothing to add — stay silent.

AFTER COLLECTING ALL INFO
- Stop asking questions. Summarize briefly. Confirm next action. Stop.
- Example: "Got it — 12 people, Delhi, mid-July. I'll share this with the team and they'll confirm availability."

HARD RULES — never break:
- Never say "booking confirmed", "seat booked", "payment received".
- Never share or generate a payment link.
- Never invent trip details — use only TRIP KNOWLEDGE below.
- If unsure → "Let me check with the team and confirm."
- For booking → "Team will connect with you shortly to confirm your seat."

Customer info: ${JSON.stringify(lead)}

TRIP KNOWLEDGE (use only when relevant — never dump everything):
${tripCompact}`;
}

async function callAI(messages) {
  const model = getActiveModel();
  try {
    if (model.provider === 'groq') {
      const modelsToTry = [model.model, model.fallback].filter(Boolean);
      for (const m of modelsToTry) {
        try {
          const res = await groq.chat.completions.create({ model: m, messages, temperature: 0.4, max_tokens: 200 });
          const text = res.choices?.[0]?.message?.content?.trim();
          if (text) return text;
        } catch (err) {
          console.error(`[ERROR] Groq (${m}):`, err.message);
        }
      }
    } else if (model.provider === 'nvidia') {
      const client = getNvidiaClient(model.apiKey());
      const res = await client.chat.completions.create({ model: model.model, messages, temperature: 0.4, max_tokens: 500 });
      const msg = res.choices?.[0]?.message;
      const showReasoning = config.showReasoning === true;
      // Reasoning models may return null content; fall back to reasoning_content only when enabled
      const text = (msg?.content || (showReasoning ? msg?.reasoning_content : '') || '').trim();
      if (text) return text;
    }
  } catch (err) {
    console.error(`[ERROR] AI (${model.name}):`, err.message);
  }
  return null;
}

async function generateReply(jid, customerMessage) {
  const state    = getChatState(jid);
  const messages = [{ role: 'system', content: buildSystemPrompt(state.lead) }];
  for (const m of state.history.slice(-HISTORY_LIMIT))
    messages.push({ role: m.role === 'assistant' || m.role === 'admin' ? 'assistant' : 'user', content: m.text });
  messages.push({ role: 'user', content: customerMessage });
  return callAI(messages);
}

/* ============================================================
 * 6. ADMIN NOTIFICATION
 * ============================================================ */

let sock = null;

async function notifyAdmins(message) {
  if (!sock) return;
  for (const jid of ADMIN_JIDS) {
    try { await sock.sendMessage(jid, { text: message }); }
    catch (e) { console.error('[ERROR] Admin notify:', e.message); }
  }
}

function buildHotLeadAlert(jid, lead) {
  const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
  return `🔥 *HOT LEAD — ACTION REQUIRED*\n\n` +
    `📱 WhatsApp: ${phone}\n` +
    `👤 Name: ${lead.booking?.name || 'Not collected'}\n` +
    `🏔️ Trip: Manali + Kasol | 19 Jun\n` +
    `🚌 Pickup: ${lead.booking?.city || lead.departureCity || 'Not confirmed'}\n` +
    `👥 Travellers: ${lead.travellers || 'Unknown'}\n` +
    `📊 Stage: ${lead.stage}\n\n` +
    `⚡ Human followup required!`;
}

/* ============================================================
 * 7. BOOKING FLOW  (code-controlled, not AI)
 * ============================================================ */

async function handleBookingFlow(jid, text) {
  const state = getChatState(jid);
  const lead  = state.lead;

  // Already handed off — any follow-up message from user also goes to admin
  if (lead.stage === 'human_handoff') {
    const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
    await notifyAdmins(
      `💬 *Follow-up from Handoff Lead*\n` +
      `📱 ${phone}\n` +
      `Message: "${text.slice(0, 200)}"`
    );
    // Only reply once every 10 mins to avoid spam
    const lastReply = lead.lastHandoffReplyTs || 0;
    if (Date.now() - lastReply > 10 * 60 * 1000) {
      lead.lastHandoffReplyTs = Date.now();
      saveMemory();
      await sock.sendMessage(jid, {
        text: `Team member aapko shortly connect karenge 😊\nFor urgent queries: 📞 ${TEAM_NUMBERS}`,
      });
    }
    return true;
  }

  // First time booking intent detected
  lead.stage    = 'human_handoff';
  lead.qualified = true;
  saveMemory();

  const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');

  await sock.sendMessage(jid, {
    text: `Great 😊 Booking aur payment process hamari team handle karti hai.\n\nMain aapki request admin tak forward kar raha hoon — team aapse shortly connect karegi.\n\nYa directly contact karein: 📞 ${TEAM_NUMBERS}`,
  });

  await notifyAdmins(
    `🔥 *HOT LEAD — BOOKING INTENT*\n\n` +
    `📱 WhatsApp: ${phone}\n` +
    `🏔️ Trip: Manali + Kasol | 19 Jun\n` +
    `🚌 City: ${lead.departureCity || 'Not confirmed'}\n` +
    `👥 Travellers: ${lead.travellers || 'Unknown'}\n` +
    `📊 Stage: human_handoff\n\n` +
    `⚡ User wants to BOOK. Contact NOW!`
  );

  console.log(`[HANDOFF] 🤝 ${jid} handed off to admin`);
  return true;
}

/* ============================================================
 * 8. ADMIN COMMANDS
 * ============================================================ */

async function handleAdminCommand(jid, text) {
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
    const chats      = Object.keys(memory).length;
    const qualified  = Object.values(memory).filter(s => s.lead?.qualified).length;
    const hotLeads   = Object.values(memory).filter(s => ['payment_pending','booking_started'].includes(s.lead?.stage)).length;
    const booked     = Object.values(memory).filter(s => s.lead?.stage === 'confirmed').length;
    await sock.sendMessage(jid, {
      text: `📊 *Bot Status*\n\n` +
        `AI: ${config.botEnabled ? '✅ ON' : '❌ OFF'}\n` +
        `WhatsApp: ✅ Connected\n` +
        `Total chats: ${chats}\n` +
        `Qualified leads: ${qualified}\n` +
        `Hot leads (payment pending): ${hotLeads}\n` +
        `Confirmed bookings: ${booked}`,
    });
    return true;
  }
  if (cmd === '/leads') {
    const hot = Object.entries(memory)
      .filter(([, s]) => ['payment_pending','booking_started','hot_lead'].includes(s.lead?.stage))
      .map(([jid, s]) => `• ${jid.replace('@s.whatsapp.net','').replace('@lid','')} — ${s.lead.stage} — ${s.lead.booking?.name || 'no name'}`)
      .join('\n') || 'No hot leads right now.';
    await sock.sendMessage(jid, { text: `🔥 *Hot Leads*\n\n${hot}` });
    return true;
  }
  if (cmd === '/reasoning on') {
    config.showReasoning = true;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await sock.sendMessage(jid, { text: '🧠 Reasoning output: *ON* — AI will show chain-of-thought in replies.' });
    return true;
  }
  if (cmd === '/reasoning off') {
    config.showReasoning = false;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await sock.sendMessage(jid, { text: '🧠 Reasoning output: *OFF* — AI will send clean replies only.' });
    return true;
  }
  if (cmd === '/model') {
    const active = getActiveModel();
    const list = AI_MODELS.map(m => `${m.id === active.id ? '✅' : '  '} ${m.id}. ${m.name}`).join('\n');
    await sock.sendMessage(jid, {
      text: `🤖 *AI Models*\n\n${list}\n\nSwitch: /model <number>`,
    });
    return true;
  }
  const modelMatch = cmd.match(/^\/model\s+(\d+)$/);
  if (modelMatch) {
    const id = parseInt(modelMatch[1], 10);
    const found = AI_MODELS.find(m => m.id === id);
    if (!found) {
      await sock.sendMessage(jid, { text: `❌ Model ${id} not found. Send /model to see options.` });
      return true;
    }
    activeModelId = id;
    config.activeModel = id;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await sock.sendMessage(jid, { text: `✅ Switched to: *${found.name}*` });
    return true;
  }
  if (cmd === '/help') {
    await sock.sendMessage(jid, {
      text: '🛠 *Admin Commands*\n\n/ai on — enable AI\n/ai off — disable AI\n/status — stats\n/leads — hot leads list\n/model — list AI models\n/model N — switch to model N\n/reasoning on — show AI chain-of-thought\n/reasoning off — clean replies only\n/help — this menu',
    });
    return true;
  }
  return false;
}

/* ============================================================
 * 9. WHATSAPP CONNECTION
 * ============================================================ */

let connected = false;

async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  // Fully silent logger — suppresses all Baileys internal output including
  // "Closing session" and signal-store debug lines.
  const noopLogger = {
    level: 'silent',
    trace: () => {}, debug: () => {}, info: () => {},
    warn:  () => {}, error: () => {}, fatal: () => {},
    child: () => noopLogger,
  };

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, noopLogger),
    },
    logger: noopLogger,
    printQRInTerminal: false,
    browser: ['Ghumakkars', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n[INFO] Scan QR code with WhatsApp (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      connected = true;
      console.log('\n✅ Connected Successfully\n');
      // Resolve admin phone numbers to LIDs (newer WhatsApp uses @lid JIDs)
      for (const num of adminNumbers) {
        try {
          const results = await sock.onWhatsApp(num);
          if (!results?.length) continue;
          const { jid, lid } = results[0];
          if (jid && !ADMIN_JIDS.includes(jid)) ADMIN_JIDS.push(jid);
          if (lid && !ADMIN_JIDS.includes(lid)) ADMIN_JIDS.push(lid);
        } catch (e) { /* non-fatal */ }
      }
      console.log('[INFO] Admin JIDs:', ADMIN_JIDS);
    }
    if (connection === 'close') {
      connected = false;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`\n❌ WhatsApp Disconnected (code ${reason})`);
      if (reason !== DisconnectReason.loggedOut) {
        console.log('[INFO] Reconnecting in 5s...');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('[INFO] Logged out. Delete auth_info/ and restart to re-link.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      try { await handleMessage(msg); }
      catch (err) { console.error('[ERROR] handleMessage:', err.message); }
    }
  });
}

/* ============================================================
 * 10. MESSAGE HANDLER
 * ============================================================ */

const processedIds  = new Set();
const replyLocks    = new Set();
const lastAiReply   = new Map();   // jid → timestamp of last AI call
const AI_COOLDOWN   = 4000;        // ms between AI replies per user (prevents rapid-fire)

async function handleMessage(msg) {
  if (!msg?.key?.remoteJid) return;

  const jid    = msg.key.remoteJid;
  const fromMe = msg.key.fromMe;

  if (isJidGroup(jid))                 return;
  if (isJidBroadcast(jid))             return;
  if (jid === 'status@broadcast')      return;

  // Extract text
  const m       = msg.message;
  const rawText =
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption || '';

  // De-duplicate
  const msgId = msg.key.id;
  if (msgId) {
    if (processedIds.has(msgId)) return;
    processedIds.add(msgId);
    if (processedIds.size > 2000) processedIds.delete(processedIds.values().next().value);
  }

  const text    = rawText.trim();
  // Support both @s.whatsapp.net and @lid JID formats for admin check
  const jidNorm = jid.replace('@lid', '@s.whatsapp.net');
  const isAdmin = ADMIN_JIDS.includes(jid) || ADMIN_JIDS.includes(jidNorm);

  // Admin commands — check BEFORE fromMe guard so commands sent from admin's
  // own phone (fromMe=true) are still processed
  if (isAdmin && text.startsWith('/')) {
    const handled = await handleAdminCommand(jid, text);
    if (handled) return;
  }

  // Auto-detect unknown @lid senders trying to use commands — help admin find their LID
  if (!isAdmin && jid.endsWith('@lid') && text.startsWith('/')) {
    const lid = jid.replace('@lid', '');
    console.log(`[ADMIN LID DETECTED] Someone sent a command from @lid: ${lid}`);
    console.log(`[ADMIN LID DETECTED] Add to config.json: "adminLids": ["${lid}"]`);
    return;
  }

  // Track outgoing (bot/admin) messages — after command check
  if (fromMe) {
    const state = getChatState(jid);
    state.lastAdminReplyTs = Date.now();
    if (rawText) pushHistory(jid, 'admin', rawText);
    return;
  }

  if (isAdmin) return; // never auto-reply to admin chat

  // Media without caption
  const displayText = text || (m && !m.conversation ? '[media message]' : '');
  if (!displayText) return;

  const state         = getChatState(jid);
  const isFirstMsg    = state.history.length === 0 && !state.welcomed;
  const lead          = state.lead;

  pushHistory(jid, 'user', displayText);

  if (!config.botEnabled) return;

  // Don't interrupt active human conversation
  const sinceAdmin = Date.now() - (state.lastAdminReplyTs || 0);
  if (state.lastAdminReplyTs && sinceAdmin < AUTO_REPLY_MS) {
    console.log(`[SKIP] ${jid}: admin replied ${Math.round(sinceAdmin / 60000)}m ago`);
    return;
  }

  if (replyLocks.has(jid)) return;
  replyLocks.add(jid);

  try {
    // ── CODE-LEVEL INTENT DETECTION ──────────────────────────
    // Priority: latest message > current topic > history

    const intent = isFirstMsg ? 'WELCOME' : detectIntent(displayText);

    // 1. WELCOME (first ever message)
    if (intent === 'WELCOME') {
      state.welcomed = true;
      const reply =
        `Hi! Welcome to Ghumakkars 👋\n\n` +
        `We run group trips every Friday.\n` +
        `Next batch: *Manali + Kasol | 19 Jun – 24 Jun*\n` +
        `💰 ₹6,499/person (was ₹10,000)\n\n` +
        `Kisi bhi trip ke baare mein poochh sakte hain 😊`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 2. GREET — state reset, fresh start, no old context
    if (intent === 'GREET') {
      softReset(state);
      const reply = `Hi 👋 Kaise help kar sakta hoon?`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 3. BYE / NOT INTERESTED — graceful exit, leave door open
    if (intent === 'BYE') {
      const reply = await generateReply(jid, displayText) ||
        `No worries at all. Whenever you plan a trip, we're here. Take care!`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 4. ACK ("ok", "cool", "thanks") — don't repeat info, let AI move forward or wrap up
    if (intent === 'ACK') {
      const reply = await generateReply(jid, displayText);
      if (reply) {
        pushHistory(jid, 'assistant', reply);
        await sock.sendMessage(jid, { text: reply });
      }
      // If AI has nothing to add, stay silent — conversation is done
      return;
    }

    // 5. ABUSE — ignore insult, stay helpful
    if (intent === 'ABUSE') {
      const reply = `Koi trip sawaal ho toh bataiye`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 5b. GROUP SIZE DETECTION — high-priority lead
    const groupSize = extractGroupSize(displayText);
    if (groupSize && groupSize >= 8 && !lead.groupEscalated) {
      lead.travellers    = groupSize;
      lead.groupEscalated = true;
      lead.stage         = 'hot_lead';
      saveMemory();
      await notifyAdmins(
        `🔥 *GROUP LEAD — ${groupSize} TRAVELLERS*\n\n` +
        `📱 ${jid.replace('@s.whatsapp.net','').replace('@lid','')}\n` +
        `👥 Group size: ${groupSize}\n` +
        `📊 Needs immediate follow-up!`
      );
      const reply = await generateReply(jid, displayText) ||
        `Wow, ${groupSize} log — that's a solid group! For groups this size we can discuss special arrangements. Can I know if this is a friends group, college trip, or office outing?`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 4. DESTINATION — only send canned intro if this is first trip mention, else let AI handle contextually
    if (intent === 'DESTINATION') {
      const dest = displayText.match(DEST_REGEX)?.[0] || 'Manali';
      const isOurTrip = /manali|kasol/i.test(dest);
      const alreadyDiscussed = state.history.length > 2;
      if (isOurTrip && !alreadyDiscussed) {
        // First mention — give quick intro, then let AI continue
        const reply =
          `Great choice! Manali + Kasol trip chal rahi hai 😊\n` +
          `📅 19 Jun – 24 Jun | 💰 ₹6,499/person\n\n` +
          `Details: ${TRIP_LINK}\n\nKoi sawaal ho toh poochho!`;
        lead.destination = 'Manali + Kasol';
        saveMemory();
        pushHistory(jid, 'assistant', reply);
        await sock.sendMessage(jid, { text: reply });
        return;
      } else if (!isOurTrip && !alreadyDiscussed) {
        const reply =
          `${dest} ke liye abhi batch nahi hai.\n` +
          `Hamare paas Manali + Kasol trip hai — 19 Jun, ₹6,499/person.\n` +
          `Interested ho toh bataiye 😊`;
        saveMemory();
        pushHistory(jid, 'assistant', reply);
        await sock.sendMessage(jid, { text: reply });
        return;
      }
      // Already in conversation — fall through to AI for contextual reply
    }

    // 5. BOOKING — human handoff, no payment discussion
    if (intent === 'BOOK' || lead.bookingStep) {
      const handled = await handleBookingFlow(jid, displayText);
      if (handled) return;
    }

    // 6. HUMAN_HANDOFF — still in handoff state
    if (lead.stage === 'human_handoff') {
      // Pure acks ("ok", "thanks", "👍") → swallow silently, no loop
      if (intent === 'ACK') return;

      const tripQ = PRICE_REGEX.test(displayText) || ITIN_REGEX.test(displayText) || CANCEL_REGEX.test(displayText);
      if (!tripQ) {
        // Real follow-up message — notify admin once per 10 min
        const phone = jid.replace('@s.whatsapp.net','').replace('@lid','');
        await notifyAdmins(`💬 *Handoff follow-up*\n📱 ${phone}\n"${displayText.slice(0,200)}"`);
        const last = lead.lastHandoffReplyTs || 0;
        if (Date.now() - last > 10 * 60 * 1000) {
          lead.lastHandoffReplyTs = Date.now();
          saveMemory();
          await sock.sendMessage(jid, { text: `Team shortly connect karegi. Direct: 📞 ${TEAM_NUMBERS}` });
        }
        return;
      }
    }

    // 7. PRICE — instant answer, no AI needed
    if (intent === 'PRICE') {
      const reply =
        `*Manali + Kasol | 19 Jun – 24 Jun*\n\n` +
        `💰 ₹6,499/person (was ₹10,000)\n` +
        `🔒 Booking amount: ₹1,500 to lock seat\n\n` +
        `Full details 👉 ${TRIP_LINK}`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      lead.stage = 'price_shared';
      saveMemory();
      return;
    }

    // 8. ITINERARY — link + 6-line summary
    if (intent === 'ITINERARY') {
      const reply =
        `Full itinerary here 👇\n${TRIP_LINK}\n\n` +
        `*Quick Overview:*\n` +
        `Day 1 – Depart Delhi/Mathura (overnight bus)\n` +
        `Day 2 – Manali: Hadimba Temple, Mall Road\n` +
        `Day 3 – Solang Valley, Atal Tunnel, Koksar\n` +
        `Day 4 – Kullu sightseeing → transfer to Kasol\n` +
        `Day 5 – Kasol: cafés, riverside, return journey\n` +
        `Day 6 – Arrive home\n\n` +
        `Koi specific question?`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      lead.stage = 'itinerary_sent';
      saveMemory();
      return;
    }

    // 9. CANCELLATION
    if (intent === 'CANCEL') {
      const reply =
        `Cancellation policy 👇\n${CANCEL_LINK}\n\n` +
        `For specific cases: 📞 ${TEAM_NUMBERS}`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 10. GENERAL — AI with compact knowledge
    // Per-user cooldown to prevent rapid token burn
    const lastCall = lastAiReply.get(jid) || 0;
    if (Date.now() - lastCall < AI_COOLDOWN) {
      console.log(`[SKIP] ${jid}: AI cooldown active`);
      return;
    }
    lastAiReply.set(jid, Date.now());

    const reply = await generateReply(jid, displayText);
    if (!reply) {
      console.error(`[ERROR] No AI reply for ${jid}`);
      return;
    }
    pushHistory(jid, 'assistant', reply);
    await sock.sendMessage(jid, { text: reply });
    console.log(`[REPLY] → ${jid}: ${reply.slice(0, 80).replace(/\n/g, ' ')}...`);

    // Update lead stage in background
    updateLeadStage(jid, displayText).catch(e => console.error('[ERROR] Lead update:', e.message));

  } finally {
    replyLocks.delete(jid);
  }
}

/* ============================================================
 * 11. LEAD STAGE UPDATE (background, low priority)
 * ============================================================ */

async function updateLeadStage(jid, latestMsg) {
  const state = getChatState(jid);
  const lead  = state.lead;

  // Don't overwrite booking stages
  if (['booking_started','payment_pending','confirmed'].includes(lead.stage)) return;

  const convo = state.history.slice(-8)
    .map(m => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.text}`)
    .join('\n');

  const result = await groqChat([
    {
      role: 'system',
      content: 'Extract from this WhatsApp conversation (respond ONLY with raw JSON, no markdown):\n' +
        '{"destination":string|null,"travellers":string|null,"departureCity":string|null,' +
        '"stage":"new"|"interested"|"price_shared"|"itinerary_sent"|"hot_lead"|"booking_intent"}\n' +
        'Stage: hot_lead=asked about price or booking, booking_intent=said they want to book. Use null if not clear.',
    },
    { role: 'user', content: convo },
  ]);

  if (!result) return;
  try {
    const data = JSON.parse(result.replace(/```json|```/g, '').trim());
    if (data.destination)   lead.destination   = String(data.destination);
    if (data.travellers)    lead.travellers    = String(data.travellers);
    if (data.departureCity) lead.departureCity = String(data.departureCity);
    if (data.stage && !['booking_started','payment_pending','confirmed'].includes(lead.stage))
      lead.stage = data.stage;
    lead.qualified = Boolean(lead.destination && lead.departureCity);

    if (data.stage === 'hot_lead' || data.stage === 'booking_intent') {
      console.log(`[LEAD] 🔥 Hot: ${jid}`, JSON.stringify(lead));
      await notifyAdmins(buildHotLeadAlert(jid, lead));
    }
    saveMemory();
  } catch { /* non-JSON, skip */ }
}

/* ============================================================
 * 12. STARTUP
 * ============================================================ */

process.on('unhandledRejection', err => console.error('[ERROR] Unhandled rejection:', err?.message || err));
process.on('uncaughtException',  err => console.error('[ERROR] Uncaught exception:',  err?.message || err));

console.log('[INFO] Starting Ghumakkars WhatsApp Bot...');
connectToWhatsApp();
