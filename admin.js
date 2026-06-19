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
const HISTORY_LIMIT = config.historyMessages || 20;

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
        name: null,
        destination: null,
        travellers: null,
        departureCity: null,
        travelDate: null,
        groupType: null,
        qualified: false,
        bookingStep: null,      // name | age | gender | city | done
        booking: {},            // collected booking details
        abuseCount: 0,
        followUpSent: false,    // track if 24h follow-up was sent
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

// Test results (2026-06-16):
// StepFun 3.7 Flash — reasoning model, answer in content, thinking in reasoning_content. Fast. ✅
// GPT OSS 120B      — reasoning model, answer in content, needs max_tokens>=600 for long prompts. ✅
// Kimi K2.6         — 500 without thinking param, garbage output with it. UNRELIABLE ❌
// GLM 5.1           — 128k context, clean replies, fastest. Best NVIDIA option. ✅
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
    name: 'NVIDIA — StepFun 3.7 Flash (reasoning)',
    provider: 'nvidia',
    model: 'stepfun-ai/step-3.7-flash',
    apiKey: () => config.nvidiaApiKey1,
    maxTokens: 800,  // reasoning model needs headroom for thinking + answer
  },
  {
    id: 4,
    name: 'NVIDIA — GPT OSS 120B (reasoning)',
    provider: 'nvidia',
    model: 'openai/gpt-oss-120b',
    apiKey: () => config.nvidiaApiKey2,
    maxTokens: 800,
  },
  {
    id: 5,
    name: 'NVIDIA — GLM 5.1 (128k ctx) ⭐',
    provider: 'nvidia',
    model: 'z-ai/glm-5.1',
    apiKey: () => config.nvidiaApiKey4,
    maxTokens: 600,
  },
  {
    id: 6,
    name: 'NVIDIA — Kimi K2.6 [unreliable]',
    provider: 'nvidia',
    model: 'moonshotai/kimi-k2.6',
    apiKey: () => config.nvidiaApiKey3,
    maxTokens: 600,
    // thinking param causes garbage output; without it causes 500 — avoid
  },
  {
    id: 7,
    name: 'NVIDIA — LLaMA 4 Maverick 17B',
    provider: 'nvidia',
    model: 'meta/llama-4-maverick-17b-128e-instruct',
    apiKey: () => config.nvidiaApiKey5,
    maxTokens: 512,
  },
  {
    id: 8,
    name: 'NVIDIA — Nemotron-3 Ultra 550B',
    provider: 'nvidia',
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    apiKey: () => config.nvidiaApiKey6,
    maxTokens: 4096,
    extraBody: {
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 4096
    }
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
  // Calculate upcoming Friday batches from today
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 5=Fri
  const daysToFriday = dayOfWeek <= 5 ? 5 - dayOfWeek : 6;
  const nextFriday = new Date(today); nextFriday.setDate(today.getDate() + (daysToFriday === 0 ? 7 : daysToFriday));
  const fridayAfter = new Date(nextFriday); fridayAfter.setDate(nextFriday.getDate() + 7);
  const fmt = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
  const upcomingBatches = `${fmt(nextFriday)} (nearest), ${fmt(fridayAfter)}, then every Friday after`;

  return `You are a travel guy at Ghumakkars chatting on WhatsApp with a traveler.
Not a bot. Not customer support. Not a brochure. A real person.

TODAY: ${today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
UPCOMING BATCHES: ${upcomingBatches}
Trips depart every Friday. Use this to answer date questions — don't ask the user to check.

━━━ RULE 0: READ THE CONVERSATION FIRST ━━━
The conversation history above contains everything the user has already said.
Read it before every reply.
Never say "I don't have access to previous chats" — you do. They are right above.
Never ask for information the user already gave in this chat.

If user asks about a previous booking or earlier discussion:
→ Summarize what you know from the history.
Example: "Haan, aapne 10 log ke liye 19 June Manali-Kasol batch ke baare mein baat ki thi, Delhi departure. Maine team ko mark kar diya tha. Kya team ne contact kiya?"

━━━ RULE 1: QUALIFY BEFORE YOU PRESENT ━━━
When someone says "share details" / "interested" / "tell me more" — DO NOT dump the itinerary, price, inclusions, or offers immediately. Talk according to the package details only.

Your main motive is to qualify the customer and confirm a solid lead by collecting these 4 details one-by-one:
  1. Name (ask naturally: "Naam kya hai aapka?")
  2. Dates (check dates according to the plan — batch departs every Friday, refer to UPCOMING BATCHES)
  3. Members count (how many people/friends are traveling)
  4. Pickup location (explain: "We mainly start from Delhi, but pickup is also available from Chandigarh." and ask which one they prefer)

Ask for these details ONE by ONE, in a natural conversation. Do not ask for multiple details in a single message.
Before sharing the full details, you can tell them: "For better info, I need your details." or "Aapki help ke liye mujhe thodi details chahiye."

Once you have collected the details, summarize and share them back to the user to confirm they are correct before moving forward.

━━━ RULE 2: RELEVANCE FILTER ━━━
Answer exactly what was asked. Nothing else first.

"Discount milega?" → talk about discount only. Not meals, not itinerary.
"What happened to my booking?" → give booking status from history.
"Hello" → greeting back. Not pricing. Not itinerary.
"Kitna time lagta hai?" → answer that specific question only.

If you're tempted to mention price or itinerary — pause. Did they ask for it? If no, don't.

━━━ RULE 3: MESSAGE PRIORITY ━━━
Step 1: Reply to what the user actually said. (NEVER skip this)
Step 2: Ask the next qualifying question OR continue the conversation.
Step 3: Present trip details only after understanding their situation.

"Hello sir" → "Hello 👋" — not a trip pitch.
"How do I book?" → explain the process simply.
"Nice" → "Glad you like it 😄"

━━━ RULE 4: STOP REDIRECTING TO THE TRIP ━━━
You are NOT a tour guide stuck in a loop.
If the user says something casual, reply casually.
Do not drag every conversation back to the trip.
The trip comes up when THEY bring it up.

━━━ RULE 5: NEVER ASK TWICE ━━━
Before asking ANY question, check the conversation history above.
If the user already answered it — DO NOT ask again. Ever.

Known info to track from history:
- Travel date → if mentioned, never ask again
- Group size / Members count → if mentioned, never ask again
- Departure city / Pickup location → if mentioned, never ask again
- Name → if mentioned, use it, never ask again
- Group type (friends/couple/solo) → if mentioned, never ask again

If user seems to repeat something (says "3 July" again after already saying it) — acknowledge you already have it, don't ask a follow-up question about it.

ANTI-PATTERN:
User: "3 July"
Bot: "Haan bhai, kaunsa batch dekh rahe ho?" ← WRONG. You already know it's 3 July.

RIGHT:
User: "3 July"  → already in history → move to next missing piece or confirm what you have.

━━━ RULE 6: SALES PROGRESSION ━━━
Once you have the details (Name, travel date, group size/members, and pickup location), confirm them back to the user to verify the lead:
"Perfect — Name: *[Name]*, Date: *[Date]*, Travelers: *[Count]*, Pickup: *[Delhi/Chandigarh]*. details share kar raha hoon, bas confirm karo."

After verifying, share the natural conversational trip summary.

Jokes and banter: one exchange is fine, then steer back. Don't keep riffing when the goal is booking.
"Ek bauna hai" → laugh once → "Toh 2 log count karta hu, aur date kya prefer karoge?"

━━━ RULE 7: RELATIONSHIP MEMORY ━━━
This is NOT a new conversation every message. Read the history above.
The user has been talking to you. You know them.

If the conversation has history, act like it:
- Don't restart qualification questions already answered
- Reference previous points naturally

After 5+ messages, never open with "How can I help you?"
Use: "Haan bhai" / "batao" / "kya hua" — based on context.

Enthusiasm signals ("yes yes yes", "haha", "nice", "done") = mood is good.
Respond to the mood first. Then move forward.
"yes yes yes" → "Haha chalo 😄 kitne log hain?" — not "How many travelers?"

━━━ RULE 8: CONTEXT RECALL ━━━
When user asks "what happened before?" or "what did I say?" or "previous chat mein kya hua?":
Summarize from the conversation history above. Be specific.
"Aapne 10 log ke liye 19 June Manali-Kasol discuss ki thi, Delhi departure. Booking process poocha tha."
NEVER say "I don't have access to previous messages." You do. They are above.
NEVER ask for a booking reference ID when the conversation has all the info.

━━━ RULE 9: MULTIPLE CONVERSATION ENDINGS ━━━
You are NOT an NPC with one dialogue tree.
The conversation can end many ways:
- Details collected → "Noted 👍 I'll check with the team and update you." then wait.
- Just chatting → match their energy, end when they end
- Enthusiasm shown → keep the momentum, guide them one step forward
- Uncertain → ask one soft question, then wait

NEVER end every conversation with "Team will contact you soon."
That is not an ending. That is an ejection.

If you just collected all info → say it back naturally and stop.
"Perfect — 2 log, Delhi, 19 June. Main details share kar deta hoon, bas confirm karo."

━━━ RULE 10: NATURAL LANGUAGE — READ INTENT, NOT WORDS ━━━
Humans don't speak like forms. Interpret what they MEAN, not what they literally typed.
Never ask for clarification if the meaning is reasonably obvious from context.

DATE / BATCH REFERENCES:
"15 June" while discussing trips → they want to travel 15 June. Check if it's a Friday. If not, tell them the nearest batch.
"next friday" → the upcoming Friday batch. Give the date.
"iske baad wala friday" / "next friday ke baad wala" / "wala baad wala" → the Friday after next. Give the date.
"us wali date" / "same date" / "us din" → last date mentioned in the conversation.
"next batch" / "agle wala" → batch after the one currently being discussed.

DESTINATION REFERENCES:
"manali wala" / "us trip" / "same trip" / "wo trip" → the Manali-Kasol trip currently being discussed.
"us jagah" → last destination mentioned.

QUANTITY / PEOPLE:
"hum log" without a number → ask how many, once.
"hum 4 log" / "4 friends" → group of 4.
"akela" / "solo" / "sirf main" → 1 person.

CONFIRMATION SIGNALS:
"le chlo" / "book kar do" / "confirm" / "haan kar do" → user wants to proceed. Move to next step.
"sahi hai" / "theek hai" / "ok bhai" → agreement. Move forward.

IF STILL UNCLEAR: ask ONE short question. Never say "Samajh nahi aaya" — that ends conversations.
Better: "Aap 26 June wale batch ki baat kar rahe ho?" (confirm your interpretation, don't demand re-explanation).

━━━ RULE 11: INTENT ━━━
"Kya hai?" → casual intro, one question back
"Interested nahi" → light, no pressure, maybe one soft question
"Next Friday" after disinterest → interest returned, respond warmly
"yes yes yes" / "haha" → enthusiasm — match it, move forward gently
"What to do now?" / "How do I book?" → explain next steps naturally
"Bye" → one warm line, then stop

━━━ STYLE & LANGUAGE ━━━
Write like you're texting a friend on WhatsApp. Short. Real. Conversational.
Language: Always chat in the user's preferred language. If they message in Hindi/Hinglish, reply only in Hindi/Hinglish. If they message in English, reply only in English. Sticking to the customer's language builds trust.
Emoji: 1 per 4–5 messages max. Not every reply.
Tone: Mirror theirs — bro/casual/formal. Never spam or send redundant follow-ups.

FORMATTING — USE SPARINGLY, LIKE A HUMAN:
WhatsApp markdown is allowed but only when it adds clarity.

BOLD (*text*): only for key numbers/names that deserve attention.
  GOOD: "Price *₹6,499*/person" or "next batch *19 June*"
  BAD:  "*Price:* ₹6,499" — don't bold the label, bold the value

NO structured label blocks. Never write "Price: / Stay: / Meals:" as separate lines.
Write in natural sentences. Use a line break only between genuinely separate thoughts.

When sharing full trip info, write it conversationally with key values bolded:
"Manali-Kasol trip hai — *₹6,499*/person (originally 10k). Delhi Akshardham se Thursday night bus, Chandigarh route. Triple/quad sharing stay, 3 breakfasts + 3 dinners included. Solang Valley, Atal Tunnel, Kasol sab cover hota hai. Pehle 10 bookings mein free river rafting bhi 😄
Next batch *19 June*, phir *26 June*.
Kitne log ho?"

No bullet points. No dashes as list items. No "---" dividers. No headers.

BANNED words/phrases:
"Great!" "Awesome!" "Certainly!" "Perfect!" "Safe travels!" "You're welcome!" "I understand."
"Team ko forward kar diya" (say once, never repeat)

USE occasionally: "Acha" / "Sahi hai" / "Nice" / "Badiya"

ONE QUESTION PER MESSAGE. Always.

━━━ NAME COLLECTION ━━━
Before or during booking intent, ask name naturally — once, not every message.
"Naam kya hai aapka?" or "By the way, naam bata do" — casual, not formal.
Once collected, use it. Don't ask again.

━━━ HARD RULES & GENERAL CONDUCT ━━━
Never say "booking confirmed / seat booked / payment received."
Never share a payment link.
Never invent facts — use only TRIP KNOWLEDGE below. Talk strictly according to the package details.
Never spam the customer or send repeated messages.
Unsure → "Let me check with the team."
For booking → continue conversation naturally, team is being notified in background.

Customer info: ${JSON.stringify(lead)}

TRIP KNOWLEDGE — use only what's relevant, never dump everything:
${tripCompact}`;
}

async function callAI(messages) {
  const model = getActiveModel();
  try {
    if (model.provider === 'groq') {
      const modelsToTry = [model.model, model.fallback].filter(Boolean);
      for (const m of modelsToTry) {
        try {
          const res = await groq.chat.completions.create({ model: m, messages, temperature: 0.4, max_tokens: 400 });
          const text = res.choices?.[0]?.message?.content?.trim();
          if (!text) {
            console.warn(`[WARN] Groq (${m}) returned empty content. finish_reason: ${res.choices?.[0]?.finish_reason}`);
          }
          if (text) return text;
        } catch (err) {
          console.error(`[ERROR] Groq (${m}):`, err.message);
        }
      }
    } else if (model.provider === 'nvidia') {
      const client = getNvidiaClient(model.apiKey());
      const params = { model: model.model, messages, temperature: 0.4, max_tokens: model.maxTokens || 600 };
      if (model.extraBody) params.extra_body = model.extraBody;
      try {
        const res = await client.chat.completions.create(params);
        const msg = res.choices?.[0]?.message;
        const showReasoning = config.showReasoning === true;
        let text = (msg?.content || '').trim();
        if (showReasoning && msg?.reasoning_content) {
          const reasoning = msg.reasoning_content.trim();
          if (reasoning) {
            text = text ? `*🧠 Thinking Process:*\n${reasoning}\n\n*Response:*\n${text}` : reasoning;
          }
        }
        if (!text) console.warn(`[WARN] NVIDIA (${model.model}) returned empty. finish_reason: ${res.choices?.[0]?.finish_reason}`);
        if (text) return text;
      } catch (err) {
        console.error(`[ERROR] AI (${model.name}):`, err.message);
        // Rate limited or NVIDIA down — fall back to Groq automatically
        console.warn(`[FALLBACK] NVIDIA failed, switching to Groq llama-3.3-70b`);
        const modelsToTry = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
        for (const m of modelsToTry) {
          try {
            const res = await groq.chat.completions.create({ model: m, messages, temperature: 0.4, max_tokens: 400 });
            const text = res.choices?.[0]?.message?.content?.trim();
            if (text) return text;
          } catch (e) {
            console.error(`[ERROR] Groq fallback (${m}):`, e.message);
          }
        }
      }
      return null;
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

function buildLeadCard(jid, lead, state) {
  const rawId    = jid.replace('@s.whatsapp.net','').replace('@lid','');
  const isLid    = jid.endsWith('@lid');
  const phone    = isLid ? `${rawId} (WhatsApp LID — tap contact to call)` : `+${rawId}`;
  const name     = lead.name || lead.booking?.name || 'Not collected';
  const trip     = lead.destination   || 'Manali + Kasol';
  const city     = lead.departureCity || 'Not confirmed';
  const date     = lead.travelDate    || 'Not confirmed';
  const pax      = lead.travellers    || 'Unknown';
  const groupType = lead.groupType    || 'Not collected';

  // Build bullet summary from history
  const history  = (state?.history || []).slice(-12);
  const facts    = [];
  if (lead.destination)    facts.push(`Trip interest: ${trip}`);
  if (lead.travellers)     facts.push(`Travellers confirmed: ${pax}`);
  if (lead.departureCity)  facts.push(`Departure city: ${city}`);
  if (lead.travelDate)     facts.push(`Travel date: ${date}`);
  if (lead.groupType)      facts.push(`Group type: ${groupType}`);
  if (lead.name)           facts.push(`Name shared: ${name}`);

  const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.text || '';

  return (
    `🔥 *HOT LEAD — DETAILS COLLECTED*\n\n` +
    `📱 WhatsApp: +${phone}\n` +
    `👤 Name: ${name}\n` +
    `🏔️ Trip: ${trip}\n` +
    `📅 Travel Date: ${date}\n` +
    `🚌 Pickup: ${city}\n` +
    `👥 Travellers: ${pax}\n` +
    `👥 Group type: ${groupType}\n` +
    `📊 Status: Lead details verified\n\n` +
    (facts.length ? `📋 *Conversation summary:*\n${facts.map(f => `• ${f}`).join('\n')}\n\n` : '') +
    `💬 *Latest message:* "${lastUserMsg.slice(0,120)}"\n\n` +
    `⚡ *Action: Call or message immediately. High-conversion lead.*`
  );
}

function buildFollowUpAlert(jid, lead, message) {
  const rawId      = jid.replace('@s.whatsapp.net','').replace('@lid','');
  const phone      = jid.endsWith('@lid') ? `${rawId} (LID)` : `+${rawId}`;
  const name       = lead.name || lead.booking?.name || 'Not collected';
  const trip       = lead.destination   || 'Manali + Kasol';
  const pax        = lead.travellers    || 'Unknown';
  const city       = lead.departureCity || 'Unknown';
  const date       = lead.travelDate    || 'Unknown';
  const minsSince  = lead.handoffTs
    ? Math.round((Date.now() - lead.handoffTs) / 60000)
    : null;

  return (
    `💬 *LEAD REPLIED (ADDITIONAL INFO)*\n\n` +
    `📱 +${phone} | 👤 ${name}\n` +
    `🏔️ ${trip} | 📅 Date: ${date} | 👥 ${pax} travellers | 🚌 Pickup: ${city}\n\n` +
    `💬 Message: "${message.slice(0,200)}"\n` +
    (minsSince !== null ? `⏰ ${minsSince}m since handoff\n` : '') +
    `📌 Status: Review and respond.`
  );
}

/* ============================================================
 * 7. BOOKING FLOW  (code-controlled, not AI)
 * ============================================================ */

async function handleBookingFlow(jid, text) {
  const state = getChatState(jid);
  const lead  = state.lead;

  // Migrate legacy human_handoff stage so old memory doesn't break
  if (lead.stage === 'human_handoff') {
    lead.stage         = 'booking_intent';
    lead.adminNotified = lead.adminNotified || true;
    saveMemory();
  }

  if (!lead.adminNotified) {
    // First booking signal — notify admin once, keep chatting normally
    lead.adminNotified = true;
    lead.handoffTs     = Date.now();
    lead.stage         = 'booking_intent';
    lead.qualified     = true;
    saveMemory();
    await notifyAdmins(buildLeadCard(jid, lead, state));
    console.log(`[HOT LEAD] 🔥 ${jid} — booking intent, admin notified`);
  }

  // Let AI answer naturally — prompt prevents fake confirmations
  return false;
}

async function notifyFollowUp(jid, lead, message) {
  const t = message.trim();
  // Skip acks, greetings, and noise
  if (ACK_REGEX.test(t))   return;
  if (GREET_REGEX.test(t)) return;
  if (t.length < 3)        return;

  // 5-min cooldown to avoid rapid messaging spam
  const last = lead.lastFollowUpTs || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;

  lead.lastFollowUpTs = Date.now();
  saveMemory();
  await notifyAdmins(buildFollowUpAlert(jid, lead, message));
}

/* ============================================================
 * 7.5. AUTOMATED 24-HOUR FOLLOW-UP
 * ============================================================ */

let followUpJobStarted = false;

function parseFollowUpReply(text) {
  const t = text.trim();
  if (/^(1|1️⃣|one|yes|interested|proceed|haan|haa|yes interested)\b/i.test(t)) return 1;
  if (/^(2|2️⃣|two|maybe|need details|details|details chahie|batao|bata)\b/i.test(t)) return 2;
  if (/^(3|3️⃣|three|future|update me|future trips|baad me|next time)\b/i.test(t)) return 3;
  if (/^(4|4️⃣|four|not interested|no|nhi|nahi|no thanks|nahi chahiye)\b/i.test(t)) return 4;
  return null;
}

function startFollowUpJob() {
  console.log('[INFO] Background 24-Hour Follow-Up Job initialized.');
  setInterval(async () => {
    if (!connected || !sock) return;
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    for (const jid of Object.keys(memory)) {
      // Do not follow up with admin JIDs
      const jidNorm = jid.replace('@lid', '@s.whatsapp.net');
      if (ADMIN_JIDS.includes(jid) || ADMIN_JIDS.includes(jidNorm)) continue;

      const state = memory[jid];
      const lead = state.lead;
      if (!state.history || state.history.length === 0) continue;

      // Check if the last message in history was from us (assistant or admin)
      const lastMsg = state.history[state.history.length - 1];
      if (lastMsg.role === 'assistant' || lastMsg.role === 'admin') {
        const timePassed = now - lastMsg.ts;
        // If more than 24 hours have passed and we haven't sent the follow-up yet
        if (timePassed > twentyFourHours && !lead.followUpSent) {
          // If the lead stage is 'ignored' or 'not_interested', do not send
          if (['ignored', 'not_interested'].includes(lead.stage)) continue;

          // Prepare the follow-up message
          const followUpMsg = `Hey 👋\n\n` +
            `Since I haven't heard back from you in a while, I just wanted to get a quick update.\n\n` +
            `Please reply with the number that best matches your situation:\n\n` +
            `1️⃣ Yes, I'm interested and would like to proceed\n\n` +
            `2️⃣ Maybe, I need some more details\n\n` +
            `3️⃣ Not for this trip, but keep me updated about future trips\n\n` +
            `4️⃣ Not interested\n\n` +
            `Just send the number, and I'll update things from my side accordingly. 😊`;

          try {
            lead.followUpSent = true;
            saveMemory();
            pushHistory(jid, 'assistant', followUpMsg);
            await sock.sendMessage(jid, { text: followUpMsg });
            console.log(`[FOLLOW-UP SENT] → ${jid}`);
          } catch (e) {
            console.error(`[ERROR] Sending follow-up to ${jid}:`, e.message);
          }
        }
      }
    }
  }, 10 * 60 * 1000); // Check every 10 minutes
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
      if (!followUpJobStarted) {
        followUpJobStarted = true;
        startFollowUpJob();
      }
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

const processedIds   = new Set();
const replyLocks     = new Set();
const lastAiReply    = new Map();

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

  // Ignore pure gibberish (only symbols/spaces, no alphanumeric content)
  if (/^[^a-zA-Z0-9ऀ-ॿ]+$/.test(displayText) && displayText.length < 5) {
    console.log(`[SKIP] ${jid}: gibberish ignored: "${displayText}"`);
    return;
  }

  pushHistory(jid, 'user', displayText);

  // Check if we were waiting for a follow-up reply
  const wasFollowUpWaiting = lead.followUpSent;
  lead.followUpSent = false; // Reset follow-up flag since they replied
  saveMemory();

  if (wasFollowUpWaiting) {
    const choice = parseFollowUpReply(displayText);
    if (choice !== null) {
      const phone = jid.replace('@s.whatsapp.net','').replace('@lid','');
      let replyText = '';

      if (choice === 1) {
        lead.stage = 'booking_intent';
        replyText = `Acha sahi hai! Let's proceed. For better info, mujhe aapki details chahiye. Please tell me your name, group size/members count, and pickup location (mainly Delhi or Chandigarh)?`;
        await notifyAdmins(
          `📱 *FOLLOW-UP CHOICE*\n` +
          `📱 +${phone} | 👤 ${lead.name || 'Unknown'}\n` +
          `✅ Selected: *Option 1* (Interested & wants to proceed)\n` +
          `⚡ Action: AI is asking for details. Monitor or take over.`
        );
      } else if (choice === 2) {
        replyText = `Sure! Aapko kya details chahiye? stay, itinerary, ya pricing?`;
        await notifyAdmins(
          `📱 *FOLLOW-UP CHOICE*\n` +
          `📱 +${phone} | 👤 ${lead.name || 'Unknown'}\n` +
          `✅ Selected: *Option 2* (Needs more details)\n` +
          `⚡ Action: AI is answering details.`
        );
      } else if (choice === 3) {
        replyText = `Noted! Maine register kar liya hai. Future trips ki updates aate rahenge. Thank you! 😊`;
        await notifyAdmins(
          `📱 *FOLLOW-UP CHOICE*\n` +
          `📱 +${phone} | 👤 ${lead.name || 'Unknown'}\n` +
          `✅ Selected: *Option 3* (Keep updated on future trips)`
        );
      } else if (choice === 4) {
        lead.stage = 'ignored';
        replyText = `Koi baat nahi, thank you batane ke liye! Have a great day ahead! 😊`;
        await notifyAdmins(
          `📱 *FOLLOW-UP CHOICE*\n` +
          `📱 +${phone} | 👤 ${lead.name || 'Unknown'}\n` +
          `❌ Selected: *Option 4* (Not interested)\n` +
          `📌 Status: Lead marked as ignored.`
        );
      }

      pushHistory(jid, 'assistant', replyText);
      await sock.sendMessage(jid, { text: replyText });
      return; // Stop execution here, don't let AI reply
    }
  }

  if (!config.botEnabled) return;

  // Don't interrupt active human conversation
  const sinceAdmin = Date.now() - (state.lastAdminReplyTs || 0);
  if (state.lastAdminReplyTs && sinceAdmin < AUTO_REPLY_MS) {
    console.log(`[SKIP] ${jid}: admin replied ${Math.round(sinceAdmin / 60000)}m ago`);
    return;
  }

  // If bot is already processing a reply for this user, buffer this message and exit.
  // The current in-flight AI call will already have prior history; the next message
  // will trigger a fresh reply with full updated history.
  if (replyLocks.has(jid)) {
    console.log(`[BUFFER] ${jid}: queued while reply in progress: "${displayText.slice(0,40)}"`);
    return;
  }
  replyLocks.add(jid);

  try {
    // ── CODE-LEVEL INTENT DETECTION ──────────────────────────
    // Priority: latest message > current topic > history

    const intent = isFirstMsg ? 'WELCOME' : detectIntent(displayText);

    // ABUSE — short deflect, no AI token wasted
    if (intent === 'ABUSE') {
      const reply = `Koi trip sawaal ho toh bataiye`;
      pushHistory(jid, 'assistant', reply);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // GROUP SIZE ≥ 8 — silently notify admin, then let AI reply naturally
    const groupSize = extractGroupSize(displayText);
    if (groupSize && groupSize >= 8 && !lead.groupEscalated) {
      lead.travellers     = groupSize;
      lead.groupEscalated = true;
      lead.stage          = 'hot_lead';
      saveMemory();
      await notifyAdmins(
        `🔥 *GROUP LEAD — ${groupSize} TRAVELLERS*\n\n` +
        `📱 ${jid.replace('@s.whatsapp.net','').replace('@lid','')}\n` +
        `👥 Group size: ${groupSize}`
      );
    }

    // BOOKING INTENT — notify admin once in background, AI keeps replying
    if (intent === 'BOOK' || lead.bookingStep) {
      await handleBookingFlow(jid, displayText);
    }

    // BOOKING LEAD — rich follow-up alert to admin (10-min cooldown, only actionable msgs)
    if (lead.adminNotified) {
      await notifyFollowUp(jid, lead, displayText);
    }

    // FRESH GREET with no history — light reset so AI doesn't carry stale state
    if (intent === 'GREET' && state.history.length <= 1) {
      softReset(state);
      pushHistory(jid, 'user', displayText); // re-add after reset
    }

    // ALL INTENTS → AI
    // Small delay so rapid follow-up messages land in history before AI reads it
    await new Promise(r => setTimeout(r, 800));

    lastAiReply.set(jid, Date.now());

    // Mark welcomed so next message doesn't repeat intro logic
    if (intent === 'WELCOME') state.welcomed = true;

    const combinedText = displayText;

    let reply = await generateReply(jid, combinedText);
    if (!reply) {
      console.error(`[ERROR] No AI reply for ${jid} | msg: "${displayText.slice(0, 60)}"`);
      reply = `Haan bhai, ek second — kuch technical issue tha. Dobara batao kya poochna tha?`;
    }
    pushHistory(jid, 'assistant', reply);
    await sock.sendMessage(jid, { text: reply });
    console.log(`[REPLY] → ${jid}: ${reply.slice(0, 80).replace(/\n/g, ' ')}...`);

    // Update lead stage in background (use combined text so buffered msgs are scanned)
    updateLeadStage(jid, combinedText).catch(e => console.error('[ERROR] Lead update:', e.message));

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

  if (['booking_started','payment_pending','confirmed'].includes(lead.stage)) return;

  const result = await callAI([
    {
      role: 'system',
      content:
        'You are a CRM field extractor. Respond ONLY with raw JSON, no markdown, no explanation.\n' +
        'Schema: {"name":string|null,"destination":string|null,"travellers":string|null,"departureCity":string|null,"travelDate":string|null,"groupType":string|null,"stage":"new"|"interested"|"price_shared"|"hot_lead"|"booking_intent"|null}\n\n' +
        'STRICT RULES:\n' +
        '1. Extract ONLY from the single customer message provided. Do NOT infer from context.\n' +
        '2. A field must be null unless the customer EXPLICITLY states it in this exact message.\n' +
        '3. Complaints, greetings, abuse, prices, random questions → all fields null except possibly stage.\n' +
        '4. travellers: only if customer states a count of people ("hum 4 log", "2 friends"). null otherwise.\n' +
        '5. departureCity: only if customer explicitly names their departure city. null otherwise.\n' +
        '6. destination: only if customer asks about or mentions a trip destination. null otherwise.\n' +
        '7. stage: hot_lead ONLY if customer asks price/availability. booking_intent ONLY if customer says they want to book. null for everything else.\n' +
        '8. name: only if customer introduces themselves by name in this exact message.\n' +
        '9. travelDate: only if customer specifies their preferred travel date or batch (e.g. "19 June", "next Friday"). null otherwise.',
    },
    { role: 'user', content: `Customer message: "${latestMsg}"` },
  ]);

  if (!result) return;
  try {
    const data = JSON.parse(result.replace(/```json|```/g, '').trim());

    // Snapshot key fields before update (for change-detection)
    const prevTravellers = lead.travellers;
    const prevCity       = lead.departureCity;
    const prevDest       = lead.destination;
    const prevTravelDate = lead.travelDate;

    if (data.name && !lead.name)              lead.name          = String(data.name);
    if (data.destination)                     lead.destination   = String(data.destination);
    if (data.travellers)                      lead.travellers    = String(data.travellers);
    if (data.departureCity)                   lead.departureCity = String(data.departureCity);
    if (data.travelDate)                      lead.travelDate    = String(data.travelDate);
    if (data.groupType)                       lead.groupType     = String(data.groupType);
    if (data.stage && !['booking_started','payment_pending','confirmed'].includes(lead.stage))
      lead.stage = data.stage;
    lead.qualified = Boolean(lead.destination || lead.travellers);
    saveMemory();

    // HOT LEAD — fire once only (adminNotified flag is the lock)
    const hasKeyDetails = Boolean(lead.name && lead.travellers && lead.departureCity);
    if ((data.stage === 'hot_lead' || data.stage === 'booking_intent' || hasKeyDetails) && !lead.adminNotified) {
      lead.adminNotified = true;
      lead.handoffTs     = Date.now();
      saveMemory();
      await notifyAdmins(buildLeadCard(jid, lead, state));
      console.log(`[HOT LEAD] 🔥 ${jid}`);
      return;
    }

    // KEY FIELD UPDATE — notify admin only if travellers/city/destination/date changed
    if (lead.adminNotified) {
      const changed = [];
      if (data.travellers && data.travellers !== prevTravellers) changed.push(`Travellers: ${prevTravellers || '?'} → ${data.travellers}`);
      if (data.departureCity && data.departureCity !== prevCity)   changed.push(`City: ${prevCity || '?'} → ${data.departureCity}`);
      if (data.destination && data.destination !== prevDest)       changed.push(`Trip: ${prevDest || '?'} → ${data.destination}`);
      if (data.travelDate && data.travelDate !== prevTravelDate)   changed.push(`Travel Date: ${prevTravelDate || '?'} → ${data.travelDate}`);
      if (changed.length) {
        const phone = jid.replace('@s.whatsapp.net','').replace('@lid','');
        await notifyAdmins(
          `📝 *LEAD UPDATE*\n📱 ${phone} | 👤 ${lead.name || 'Unknown'}\n\n` +
          changed.map(c => `• ${c}`).join('\n') + `\n\n💬 "${latestMsg?.slice(0,100)}"`
        );
      }
    }
  } catch { /* non-JSON, skip */ }
}

/* ============================================================
 * 12. STARTUP
 * ============================================================ */

process.on('unhandledRejection', err => console.error('[ERROR] Unhandled rejection:', err?.message || err));
process.on('uncaughtException',  err => console.error('[ERROR] Uncaught exception:',  err?.message || err));

console.log('[INFO] Starting Ghumakkars WhatsApp Bot...');
connectToWhatsApp();
