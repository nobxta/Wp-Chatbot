/**
 * ============================================================
 *  WhatsApp AI Travel Sales Assistant — Ghumakkars
 *  Built on @whiskeysockets/baileys (no Chrome/Puppeteer)
 * ============================================================
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

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
const ADMIN_JIDS    = adminNumbers.map(n => `${String(n).replace(/\D/g, '')}@s.whatsapp.net`);
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

function detectIntent(text) {
  const t = text.toLowerCase().trim();
  if (ABUSE_WORDS.some(w => t.includes(w))) return 'ABUSE';
  if (GREET_REGEX.test(t))  return 'GREET';
  if (BOOK_REGEX.test(t))   return 'BOOK';
  if (PRICE_REGEX.test(t))  return 'PRICE';
  if (ITIN_REGEX.test(t))   return 'ITINERARY';
  if (CANCEL_REGEX.test(t)) return 'CANCEL';
  if (DEST_REGEX.test(t))   return 'DESTINATION';
  return 'GENERAL';
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
 * 5. GROQ AI
 * ============================================================ */

const groq           = new Groq({ apiKey: config.groqApiKey });
const PRIMARY_MODEL  = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

function buildSystemPrompt(lead) {
  return `You are the WhatsApp assistant for Ghumakkars — a real human travel consultant.

LANGUAGE: Mirror the customer's language exactly every reply.
Hindi script → Hindi | Hinglish → Hinglish | English → English. Never switch first.

TONE: Friendly, professional, simple. WhatsApp style — 2–3 lines max, 1 emoji max.
Never use "Arre bhai" or repeat the same opener. Match user energy.

ANSWER FIRST, ASK AFTER:
Answer the user's question directly before asking anything.
Price asked → give price. Dates asked → give dates. Itinerary asked → send link.
Only ask questions that help understand their travel need.

NEVER INVENT OR ASSUME:
• Never assume city, pickup, number of travellers, booking or payment status.
• Only use facts from TRIP KNOWLEDGE below. If unsure → "Mujhe exact confirmation nahi hai. Team se verify kar ke batata hoon."
• Never mention discounts, offers or deals not present in the knowledge.

SOLO TRAVELLERS:
If user says solo / alone / "koi nahi mere saath" → "Solo travelers are welcome in our group trips 😊"
Do NOT discuss discounts unless explicitly in the data.

OBJECTIONS:
• Rafting nahi karni → "No problem, rafting is completely optional."
• Mehnga hai → "It's our best offer — ₹6,499 down from ₹10,000."
• Sochna hai → "Sure, take your time. Let me know if you have questions."

ABUSE / RUDE MESSAGES:
Do NOT argue. Do NOT mention respect. Do NOT defend yourself.
Simply ignore the insult and continue helping.
Example: User says "teri aukat nahi" → Reply: "Trip ke baare mein koi sawaal ho toh bataiye 😊"

FRESH START:
If user says "hi" or "hello" after anything → always reply fresh: "Hi 👋 Kaise help kar sakta hoon?"
Never reference previous messages negatively.

FORBIDDEN:
• "Booking complete ho gayi" • "Seat confirm ho gayi" • "Payment receive ho gaya"
• Generating or sharing payment links • Confirming any transaction
• Anything not in TRIP KNOWLEDGE

ESCALATE TO TEAM (📞 ${TEAM_NUMBERS}) for:
Complaints, refunds, payment issues, medical, special requests, anything complex.

Customer known info: ${JSON.stringify(lead)}

TRIP KNOWLEDGE:
${tripCompact}`;
}

async function groqChat(messages) {
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const res = await groq.chat.completions.create({ model, messages, temperature: 0.4, max_tokens: 200 });
      const text = res.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (err) {
      console.error(`[ERROR] Groq (${model}):`, err.message);
    }
  }
  return null;
}

async function generateReply(jid, customerMessage) {
  const state    = getChatState(jid);
  const messages = [{ role: 'system', content: buildSystemPrompt(state.lead) }];
  for (const m of state.history.slice(-HISTORY_LIMIT))
    messages.push({ role: m.role === 'assistant' || m.role === 'admin' ? 'assistant' : 'user', content: m.text });
  messages.push({ role: 'user', content: customerMessage });
  return groqChat(messages);
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
  if (cmd === '/help') {
    await sock.sendMessage(jid, {
      text: '🛠 *Admin Commands*\n\n/ai on — enable AI\n/ai off — disable AI\n/status — stats\n/leads — hot leads list\n/help — this menu',
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

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
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

const processedIds = new Set();
const replyLocks   = new Set();

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

  // Track outgoing (admin) messages
  if (fromMe) {
    const state = getChatState(jid);
    state.lastAdminReplyTs = Date.now();
    if (rawText) pushHistory(jid, 'admin', rawText);
    return;
  }

  // De-duplicate
  const msgId = msg.key.id;
  if (msgId) {
    if (processedIds.has(msgId)) return;
    processedIds.add(msgId);
    if (processedIds.size > 2000) processedIds.delete(processedIds.values().next().value);
  }

  const text    = rawText.trim();
  const isAdmin = ADMIN_JIDS.includes(jid);

  // Admin commands
  if (isAdmin && text.startsWith('/')) {
    const handled = await handleAdminCommand(jid, text);
    if (handled) return;
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

    // 3. ABUSE — ignore insult, stay helpful
    if (intent === 'ABUSE') {
      const reply = `Trip ke baare mein koi sawaal ho toh bataiye 😊`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 4. DESTINATION — immediate trip info, no questions first
    if (intent === 'DESTINATION') {
      const dest = displayText.match(DEST_REGEX)?.[0] || 'Manali';
      const isOurTrip = /manali|kasol/i.test(dest);
      let reply;
      if (isOurTrip) {
        reply =
          `Great 😊\n\n` +
          `*Manali + Kasol Trip*\n` +
          `📅 19 Jun – 24 Jun\n` +
          `💰 ₹6,499/person\n\n` +
          `📄 Full details: ${TRIP_LINK}\n\n` +
          `Koi specific question ho toh bataiye.`;
        lead.destination = 'Manali + Kasol';
      } else {
        reply =
          `${dest} ke liye abhi scheduled batch nahi hai.\n\n` +
          `Hamare paas *Manali + Kasol* trip hai — 19 Jun, ₹6,499/person.\n` +
          `Interested ho toh bataiye, ya custom trip ke liye: 📞 ${TEAM_NUMBERS}`;
      }
      saveMemory();
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 5. BOOKING — human handoff, no payment discussion
    if (intent === 'BOOK' || lead.bookingStep) {
      const handled = await handleBookingFlow(jid, displayText);
      if (handled) return;
    }

    // 6. HUMAN_HANDOFF — still in handoff state, allow trip Qs only
    if (lead.stage === 'human_handoff') {
      // If it's a trip question, answer it — otherwise redirect
      const tripQ = PRICE_REGEX.test(displayText) || ITIN_REGEX.test(displayText) || CANCEL_REGEX.test(displayText);
      if (!tripQ) {
        const phone = jid.replace('@s.whatsapp.net','').replace('@lid','');
        await notifyAdmins(`💬 *Handoff follow-up*\n📱 ${phone}\n"${displayText.slice(0,200)}"`);
        const last = lead.lastHandoffReplyTs || 0;
        if (Date.now() - last > 10 * 60 * 1000) {
          lead.lastHandoffReplyTs = Date.now();
          saveMemory();
          await sock.sendMessage(jid, { text: `Team aapko shortly connect karegi 😊\nDirect: 📞 ${TEAM_NUMBERS}` });
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

    // 10. GENERAL — AI with compact knowledge, no history injection of old topics
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
