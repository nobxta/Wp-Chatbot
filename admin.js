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

const BOOK_REGEX    = /\b(book|booking|seat|advance|pay|payment|confirm|register|enroll|lena hai|le lena|le lu|buk|le loon|book kar)\b/i;
const PRICE_REGEX   = /\b(price|kitna|cost|amount|fees|charge|rate|paisa|rupee|rs\b|₹|kitne ka|kitni|lagega|lagta)\b/i;
const ITIN_REGEX    = /\b(itinerary|schedule|plan|details|day|programme|batao|bata|kya kya|kahan kahan|places|poora|pura|full)\b/i;
const CANCEL_REGEX  = /\b(cancel|refund|return|wapas|nahi aana|drop|policy)\b/i;
const ABUSE_WORDS   = ['aukat','gali','bc ','mc ','chutiya','bhen','madarch','harami','bkl','bsdk','randi','gaand','bhench','teri maa'];

function detectIntent(text) {
  const t = text.toLowerCase();
  if (ABUSE_WORDS.some(w => t.includes(w))) return 'ABUSE';
  if (BOOK_REGEX.test(t))   return 'BOOK';
  if (PRICE_REGEX.test(t))  return 'PRICE';
  if (ITIN_REGEX.test(t))   return 'ITINERARY';
  if (CANCEL_REGEX.test(t)) return 'CANCEL';
  return 'GENERAL';
}

/* ============================================================
 * 5. GROQ AI
 * ============================================================ */

const groq           = new Groq({ apiKey: config.groqApiKey });
const PRIMARY_MODEL  = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

function buildSystemPrompt(lead, useDetailed = false) {
  const knowledge = useDetailed ? tripDetailed : tripCompact;
  return `You are a professional travel consultant at Ghumakkars, chatting on WhatsApp. You are a real human.

LANGUAGE: Detect and strictly match the customer's language every reply.
• Hindi (देवनागरी) → pure Hindi
• Hinglish (roman mix) → Hinglish
• English → English
Never switch unless they do first.

TONE: Professional, warm, helpful. WhatsApp style — 2–3 short lines max, 1 emoji max.
Never start with "Arre", "Bhai", or the same opener twice.
Short user message = short reply. Match energy.

CONVERSATION RULES:
• Answer the question FIRST. Ask one follow-up AFTER.
• When user shows trip interest → give trip summary immediately (date, price, duration).
• Never assume pickup city — always ask if not confirmed.
• "Pata nahi" / "not sure" → move on, don't push.

WHAT YOU MUST NEVER DO:
• NEVER say "booking complete", "seat confirmed", "payment received" — you don't handle payments.
• NEVER invent prices, inclusions, dates, or hotels not in the knowledge.
• NEVER offer discounts, negotiate price, or promise anything not in the data.
• NEVER assume the user is from Delhi or any city without them saying so.
• If asked for something not in the package → "That's not included in this package. For special requests contact: 📞 ${TEAM_NUMBERS}"

OBJECTIONS:
• "Rafting nahi karni" → "No problem at all, rafting is completely optional. The trip has plenty of other highlights."
• "Mehnga hai" → "This is our best offer — ₹6,499 down from ₹10,000. Seat locks for just ₹1,500."
• "Sochta hoon" → "Sure, take your time. 19 Jun batch is filling up — let me know if you have questions."

ABUSE: If user is rude or disrespectful → respond once professionally: "I'm here to help with trip information. Please keep the conversation respectful." Then stop engaging with the abuse.

COMPLEX/PAYMENT/COMPLAINTS: Redirect to team: 📞 ${TEAM_NUMBERS}

Customer known info: ${JSON.stringify(lead)}

TRIP KNOWLEDGE:
${knowledge}`;
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

async function generateReply(jid, customerMessage, useDetailed = false) {
  const state    = getChatState(jid);
  const messages = [{ role: 'system', content: buildSystemPrompt(state.lead, useDetailed) }];
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
  const step  = lead.bookingStep;

  // First time hitting booking intent
  if (!step || step === 'start') {
    lead.bookingStep = 'name';
    lead.stage       = 'booking_started';
    lead.booking     = {};
    saveMemory();

    const msg = lead.history?.some(m => m.role === 'user' && /hindi|hinglish/i.test(m.text))
      ? `Bilkul! Seat confirm karne ke liye kuch details chahiye 📋\n\nApna *pura naam* share karein:`
      : `Sure! To confirm your seat, I need a few details 📋\n\nPlease share your *Full Name*:`;

    await sock.sendMessage(jid, { text: msg });
    await notifyAdmins(`🔔 *Booking Started*\nWhatsApp: ${jid.replace('@s.whatsapp.net','').replace('@lid','')}`);
    return true;
  }

  if (step === 'name') {
    if (text.trim().split(' ').length < 1 || text.trim().length < 2) {
      await sock.sendMessage(jid, { text: 'Please share your full name:' });
      return true;
    }
    lead.booking.name = text.trim();
    lead.bookingStep  = 'age';
    saveMemory();
    await sock.sendMessage(jid, { text: `Got it, ${lead.booking.name}! 👍\n\nNow please share your *Age*:` });
    return true;
  }

  if (step === 'age') {
    lead.booking.age = text.trim();
    lead.bookingStep = 'gender';
    saveMemory();
    await sock.sendMessage(jid, { text: 'And your *Gender* (Male / Female / Other):' });
    return true;
  }

  if (step === 'gender') {
    lead.booking.gender = text.trim();
    lead.bookingStep    = 'city';
    saveMemory();
    await sock.sendMessage(jid, { text: 'Last one! Pickup city — *Delhi* or *Mathura*?' });
    return true;
  }

  if (step === 'city') {
    const t = text.toLowerCase();
    if (!t.includes('delhi') && !t.includes('mathura')) {
      await sock.sendMessage(jid, { text: 'Pickup is only available from *Delhi* or *Mathura*. Which one works for you?' });
      return true;
    }
    lead.booking.city   = t.includes('delhi') ? 'Delhi' : 'Mathura';
    lead.departureCity  = lead.booking.city;
    lead.bookingStep    = 'payment';
    lead.stage          = 'payment_pending';
    lead.qualified      = true;
    saveMemory();

    const summary =
      `✅ *Booking Details*\n\n` +
      `👤 Name: ${lead.booking.name}\n` +
      `🎂 Age: ${lead.booking.age}\n` +
      `⚧ Gender: ${lead.booking.gender}\n` +
      `🚌 Pickup: ${lead.booking.city}\n` +
      `🏔️ Trip: Manali + Kasol | 19 Jun – 24 Jun\n\n` +
      `To confirm your seat, pay *₹1,500* booking amount:\n\n` +
      `💳 *Payment Link:*\n${PAYMENT_LINK}\n\n` +
      `After payment, share the screenshot here. Our team will confirm your seat within 2 hours. 🙂`;

    await sock.sendMessage(jid, { text: summary });

    // Alert admins with full details
    await notifyAdmins(
      `🔥 *PAYMENT PENDING — HOT LEAD*\n\n` +
      `📱 WhatsApp: ${jid.replace('@s.whatsapp.net','').replace('@lid','')}\n` +
      `👤 ${lead.booking.name} | Age: ${lead.booking.age} | ${lead.booking.gender}\n` +
      `🚌 Pickup: ${lead.booking.city}\n` +
      `🏔️ Manali + Kasol | 19 Jun\n\n` +
      `💳 Payment link shared. Awaiting payment screenshot.\n` +
      `⚡ Follow up NOW!`
    );
    console.log(`[BOOKING] 💳 Payment link sent to ${jid}`);
    return true;
  }

  // After payment step — user likely sent payment screenshot or message
  if (step === 'payment') {
    await sock.sendMessage(jid, {
      text: `Thank you! 🙏 Our team will verify and confirm your seat shortly.\n\nFor any queries: 📞 ${TEAM_NUMBERS}`,
    });
    // Notify admin that user responded after payment link
    await notifyAdmins(
      `📸 *Payment Response Received*\n` +
      `📱 ${jid.replace('@s.whatsapp.net','').replace('@lid','')}\n` +
      `👤 ${lead.booking.name || 'Unknown'}\n` +
      `Message: "${text.slice(0, 100)}"\n\n⚡ Check and confirm manually!`
    );
    return true;
  }

  return false;
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

    const intent = isFirstMsg ? 'WELCOME' : detectIntent(displayText);

    // 1. WELCOME
    if (intent === 'WELCOME') {
      const reply =
        `Hi! Welcome to Ghumakkars 👋\n\n` +
        `We run group trips every Friday.\n` +
        `Next batch: *Manali + Kasol | 19 Jun – 24 Jun*\n` +
        `Price: *₹6,499/person* (was ₹10,000)\n\n` +
        `Which city are you travelling from?`;
      state.welcomed = true;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 2. ABUSE
    if (intent === 'ABUSE') {
      lead.abuseCount = (lead.abuseCount || 0) + 1;
      saveMemory();
      const reply = lead.abuseCount <= 2
        ? `I'm here to help with trip information. Please keep the conversation respectful.`
        : `For further assistance, please contact our team directly: 📞 ${TEAM_NUMBERS}`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 3. BOOKING FLOW (code-controlled)
    if (intent === 'BOOK' || lead.bookingStep) {
      const handled = await handleBookingFlow(jid, displayText);
      if (handled) return;
    }

    // 4. PRICE — quick hardcoded answer (saves tokens)
    if (intent === 'PRICE') {
      const reply =
        `*Manali + Kasol | 19 Jun – 24 Jun*\n\n` +
        `💰 Price: *₹6,499/person* (was ₹10,000)\n` +
        `🔒 Booking amount: *₹1,500* to lock your seat\n\n` +
        `Trip details 👉 ${TRIP_LINK}\n\n` +
        `Ready to book?`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      lead.stage = 'price_shared';
      saveMemory();
      return;
    }

    // 5. ITINERARY — send link + brief summary, not wall of text
    if (intent === 'ITINERARY') {
      const reply =
        `Here's the full itinerary 👇\n${TRIP_LINK}\n\n` +
        `Quick summary:\n` +
        `Day 1 – Depart Delhi/Mathura (overnight bus)\n` +
        `Day 2 – Arrive Manali, Hadimba Temple, Mall Road\n` +
        `Day 3 – Solang Valley, Atal Tunnel, Koksar\n` +
        `Day 4 – Kullu sightseeing → Kasol\n` +
        `Day 5 – Kasol cafés, riverside, return journey\n` +
        `Day 6 – Back home\n\n` +
        `Any questions about a specific day?`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      lead.stage = 'itinerary_sent';
      saveMemory();
      return;
    }

    // 6. CANCELLATION — send link
    if (intent === 'CANCEL') {
      const reply =
        `Our cancellation policy 👇\n${CANCEL_LINK}\n\n` +
        `Bookings are generally non-refundable. For special cases, contact team: 📞 ${TEAM_NUMBERS}`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // 7. GENERAL — send to AI with compact knowledge
    const reply = await generateReply(jid, displayText, false);
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
