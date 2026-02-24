/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║           WhatsApp AI Sales Bot — server.js                         ║
 * ║           Powered by OpenAI + Whapi Cloud                           ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  CLOUD DEPLOYMENT (Render / Railway)                                 ║
 * ║  ─────────────────────────────────────────────────────────────────  ║
 * ║  1. Push this project to a GitHub repository.                        ║
 * ║  2. Create a new Web Service on Render or Railway.                   ║
 * ║     - Build Command : npm install                                    ║
 * ║     - Start Command : npm start   (runs: node server.js)            ║
 * ║  3. Add the following Environment Variables in the dashboard:        ║
 * ║     - OPENAI_API_KEY      → your OpenAI secret key                  ║
 * ║     - WHAPI_API_KEY       → your Whapi Cloud channel token          ║
 * ║     - OPENAI_MODEL        → e.g. gpt-4o-mini  (optional)            ║
 * ║     - WHAPI_API_URL       → https://gate.whapi.cloud  (optional)    ║
 * ║     - RATE_LIMIT_MAX      → e.g. 5  (optional, default: 5)          ║
 * ║     - RATE_LIMIT_WINDOW_MS→ e.g. 60000  (optional, default: 60000) ║
 * ║     NOTE: PORT is set automatically by Render/Railway — do NOT set  ║
 * ║     it manually; the server reads process.env.PORT at runtime.      ║
 * ║  4. After deploy, copy your public URL, e.g.:                        ║
 * ║        https://whatsapp-ai-bot.onrender.com                         ║
 * ║  5. In Whapi Cloud dashboard → Channel Settings → Webhook URL:       ║
 * ║        https://whatsapp-ai-bot.onrender.com/webhook                 ║
 * ║  6. Health check endpoint (used by Render/Railway keep-alive):       ║
 * ║        GET /   → returns { status: "ok" }                           ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

"use strict";

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─── Knowledge Base Loader ────────────────────────────────────────────────────
// knowledge.json is loaded ONCE at startup.
// To update bot behaviour, edit knowledge.json and restart the server.
let KB = {};
try {
    const kbPath = path.join(__dirname, "knowledge.json");
    KB = JSON.parse(fs.readFileSync(kbPath, "utf-8"));
    console.log("[Knowledge] knowledge.json loaded successfully ✓");
} catch (err) {
    console.warn("[Knowledge] WARNING: knowledge.json not found or invalid — using empty KB:", err.message);
}

// ─── Env Validation ──────────────────────────────────────────────────────────
const {
    PORT = 3000,
    OPENAI_KEY,          // Render env var name
    OPENAI_MODEL = "gpt-4o-mini",
    WHATAPI_TOKEN,       // Render env var name
    WHAPI_API_URL = "https://gate.whapi.cloud",
    RATE_LIMIT_MAX = "5",
    RATE_LIMIT_WINDOW_MS = "60000",
} = process.env;

// Internal aliases — rest of code uses these
const OPENAI_API_KEY = OPENAI_KEY;
const WHAPI_API_KEY = WHATAPI_TOKEN;

if (!OPENAI_API_KEY) {
    console.error("[FATAL] OPENAI_KEY is not set in Render environment variables.");
    process.exit(1);
}

if (!WHAPI_API_KEY) {
    console.error("[FATAL] WHATAPI_TOKEN is not set in Render environment variables.");
    process.exit(1);
}

// ─── Timestamped Logger ───────────────────────────────────────────────────────
function log(level, tag, ...args) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
    if (level === "error") {
        console.error(prefix, ...args);
    } else {
        console.log(prefix, ...args);
    }
}

// ─── In-Memory Rate Limiter ───────────────────────────────────────────────────
// Tracks message count per phone number within a rolling time window.
// Prevents spam and runaway OpenAI costs.
const rateLimitStore = new Map(); // phone -> { count, windowStart }
const RATE_MAX = parseInt(RATE_LIMIT_MAX, 10);
const RATE_WINDOW = parseInt(RATE_LIMIT_WINDOW_MS, 10);

function isRateLimited(phone) {
    const now = Date.now();
    const entry = rateLimitStore.get(phone);

    if (!entry || now - entry.windowStart > RATE_WINDOW) {
        // First message or window expired — reset
        rateLimitStore.set(phone, { count: 1, windowStart: now });
        return false;
    }

    if (entry.count >= RATE_MAX) {
        log("warn", "RateLimit", `${phone} exceeded ${RATE_MAX} messages / ${RATE_WINDOW / 1000}s window`);
        return true;
    }

    entry.count += 1;
    return false;
}

// ─── Conversation History (in-memory, per sender) ────────────────────────────
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ─── SAFE MODE ────────────────────────────────────────────────────────────────
// Tracker per phone: { userMsgCount, lastSenderWasUs }
// lastSenderWasUs = true  → bot OR team replied last → suppress auto-reply
//                  false → customer sent last message without reply
const safeModeTracker = new Map();

// Keywords that ALWAYS trigger an auto-reply (even after we replied last)
const TRIGGER_KEYWORDS = [
    "price", "rate", "cost", "fees", "charges", "kitna", "kitne",
    "assignment", "project", "solve", "solution", "solved",
    "detail", "details", "info", "information",
    "sample", "demo", "example",
    "delivery", "time", "kab", "when",
    "payment", "pay", "upi", "gpay",
    "order", "confirm", "book",
];

// Returns true if the bot should auto-reply in SAFE MODE
function shouldAutoReply(phone, messageText) {
    const tracker = safeModeTracker.get(phone) || { userMsgCount: 0, lastSenderWasUs: false };
    const text = messageText.toLowerCase();

    // Rule 1: ALWAYS reply to the very first message
    if (tracker.userMsgCount === 0) {
        log("info", "SafeMode", `${phone} → first message — auto-reply ALLOWED`);
        return true;
    }

    // Rule 3: If our team/bot replied last, only continue if keyword matched
    if (tracker.lastSenderWasUs) {
        const matched = TRIGGER_KEYWORDS.find((kw) => text.includes(kw));
        if (!matched) {
            log("info", "SafeMode", `${phone} → team replied last + no keyword — SUPPRESSED`);
            return false;
        }
        log("info", "SafeMode", `${phone} → keyword "${matched}" matched — auto-reply ALLOWED`);
        return true;
    }

    // Rule 2: Customer sent last (no reply yet) + keyword triggered
    const matched = TRIGGER_KEYWORDS.find((kw) => text.includes(kw));
    if (matched) {
        log("info", "SafeMode", `${phone} → keyword "${matched}" — auto-reply ALLOWED`);
        return true;
    }

    log("info", "SafeMode", `${phone} → no keyword match — SUPPRESSED`);
    return false;
}

// ─── Human Override Protection ────────────────────────────────────────────────────
// When a team member manually replies to a customer, the bot stays silent
// for HUMAN_OVERRIDE_MS milliseconds (default: 15 minutes).
// This prevents the bot from interrupting an ongoing human conversation.
const humanOverrideStore = new Map(); // phone → { silencedUntil: timestamp }
const HUMAN_OVERRIDE_MS = 15 * 60 * 1000; // 15 minutes in ms

// Set override: bot will be silent for this phone for 15 minutes
function setHumanOverride(phone) {
    const silencedUntil = Date.now() + HUMAN_OVERRIDE_MS;
    humanOverrideStore.set(phone, { silencedUntil });
    const expiresAt = new Date(silencedUntil).toISOString();
    log("info", "Override", `Human override SET for ${phone} — bot silent until ${expiresAt}`);
}

// Returns true if override is still active (within cooldown window)
function isHumanOverrideActive(phone) {
    const entry = humanOverrideStore.get(phone);
    if (!entry) return false;
    if (Date.now() < entry.silencedUntil) {
        const remaining = Math.ceil((entry.silencedUntil - Date.now()) / 1000 / 60);
        log("info", "Override", `${phone} — human override ACTIVE (${remaining} min remaining) — bot SUPPRESSED`);
        return true;
    }
    // Override expired — clean up
    humanOverrideStore.delete(phone);
    log("info", "Override", `${phone} — human override EXPIRED — bot resumed`);
    return false;
}

// ─── Follow-Up System ──────────────────────────────────────────────────────────────
// If a customer sends a message and no HUMAN replies within 10 minutes,
// the bot sends ONE short info reply using knowledge.json.
// Only one follow-up per conversation lifetime (followUpSent flag).
const followUpStore = new Map(); // phone → { timerId, followUpSent }
const FOLLOWUP_DELAY_MS = 10 * 60 * 1000; // 10 minutes

// Builds a short, WhatsApp-friendly follow-up message from KB
function buildFollowUpMessage() {
    const K = KB;
    const shop = K.business?.name ?? "Guru Nanak Photostate";
    const hwPrice = K.handwritten_assignments?.price_display ?? "₹300 per assignment";
    const pdfPrice = K.pdf_assignments?.price_display ?? "₹30 per assignment";
    const delivery = K.handwritten_assignments?.delivery ?? "5–7 days";
    return (
        `Hi! 👋 This is *${shop}* — still here to help with your IGNOU assignments.\n` +
        `Handwritten: ${hwPrice} | PDF: ${pdfPrice} (instant) 📄\n` +
        `Just reply with your course name to get started! �`
    );
}

// Schedule a follow-up for this phone (resets timer if already pending)
function scheduleFollowUp(phone, senderJid) {
    const existing = followUpStore.get(phone) || { timerId: null, followUpSent: false };

    // Only one follow-up per conversation lifetime
    if (existing.followUpSent) {
        log("info", "FollowUp", `${phone} — follow-up already sent, skipping schedule`);
        return;
    }

    // Cancel any pending timer before setting a new one
    if (existing.timerId) {
        clearTimeout(existing.timerId);
        log("info", "FollowUp", `${phone} — existing follow-up timer reset`);
    }

    const timerId = setTimeout(async () => {
        const entry = followUpStore.get(phone);
        if (!entry || entry.followUpSent) return; // already sent or cancelled

        // Don't send if team took over during the wait
        if (isHumanOverrideActive(phone)) {
            log("info", "FollowUp", `${phone} — human override active, follow-up SKIPPED`);
            return;
        }

        log("info", "FollowUp", `${phone} — 10 min elapsed, no human reply — sending follow-up`);
        const msg = buildFollowUpMessage();
        try {
            await sendWhatsAppMessage(senderJid, msg);
            entry.followUpSent = true; // mark as sent — never send again
            log("info", "FollowUp", `${phone} — follow-up delivered ✓`);
        } catch (err) {
            log("error", "FollowUp", `${phone} — failed to send follow-up:`, err.message);
        }
    }, FOLLOWUP_DELAY_MS);

    followUpStore.set(phone, { timerId, followUpSent: false });
    log("info", "FollowUp", `${phone} — follow-up scheduled in ${FOLLOWUP_DELAY_MS / 60000} min`);
}

// Cancel a pending follow-up (called when team manually replies)
function cancelFollowUp(phone) {
    const entry = followUpStore.get(phone);
    if (entry?.timerId) {
        clearTimeout(entry.timerId);
        followUpStore.set(phone, { timerId: null, followUpSent: entry.followUpSent });
        log("info", "FollowUp", `${phone} — follow-up timer CANCELLED (team replied)`);
    }
}

// ─── Express Setup ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── Health Check ────────────────────────────────────────────────────────────
// Render pings GET / to confirm the service is alive.
// Must return HTTP 200 — plain text "Server running" is the standard response.
app.get("/", (_req, res) => {
    log("info", "Health", "Health check ping received");
    res.status(200).send("Server running");
});

// ─── Webhook Endpoint ────────────────────────────────────────────────────────
/**
 * POST /webhook
 *
 * Whapi Cloud sends incoming message events as JSON payloads.
 * We respond 200 IMMEDIATELY before any async work so Whapi never retries.
 *
 * Payload shape (simplified):
 * {
 *   "messages": [
 *     {
 *       "id": "...",
 *       "from": "919876543210@s.whatsapp.net",
 *       "type": "text",
 *       "text": { "body": "Hello!" },
 *       "from_me": false
 *     }
 *   ]
 * }
 */
app.post("/webhook", (req, res) => {
    // ✅ Respond 200 immediately — never block Whapi waiting for AI
    res.sendStatus(200);

    const { messages } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        log("info", "Webhook", "Payload has no messages — skipping");
        return;
    }

    log("info", "Webhook", `Received ${messages.length} message(s)`);

    // Process each message independently; one failure won't block others
    for (const message of messages) {
        handleMessage(message).catch((err) => {
            log("error", "Webhook", "Unhandled error in handleMessage:", err.message);
        });
    }
});

// ─── Core Message Handler ────────────────────────────────────────────────────
async function handleMessage(message) {
    // ── Guard 1: Track team's manual outgoing messages (from_me) ─────────────
    // When our team manually replies on WhatsApp, Whapi sends a from_me=true
    // event. We record this so SAFE MODE knows the team is handling that chat.
    if (message.from_me === true) {
        // 'to' field holds the customer's JID on outgoing messages
        const customerJid = message.to || "";
        const customerPhone = customerJid.split("@")[0];
        if (customerPhone) {
            // Update SAFE MODE tracker
            const tracker = safeModeTracker.get(customerPhone) || { userMsgCount: 0, lastSenderWasUs: false };
            tracker.lastSenderWasUs = true;
            safeModeTracker.set(customerPhone, tracker);

            // Set HUMAN OVERRIDE — bot silent for 15 minutes
            setHumanOverride(customerPhone);

            // Cancel follow-up timer — team is handling this chat
            cancelFollowUp(customerPhone);
        }
        return;
    }

    // ── Guard 2: Ignore non-text messages ────────────────────────────────────
    if (message.type !== "text") {
        log("info", "Handler", `Skipping unsupported message type: "${message.type}"`);
        return;
    }

    // ── Guard 3: Ensure sender JID and body are present ──────────────────────
    const senderJid = message.from;
    const messageText = message.text?.body?.trim();

    if (!senderJid) {
        log("warn", "Handler", "Message missing 'from' field — skipping");
        return;
    }

    if (!messageText) {
        log("warn", "Handler", `Empty or missing text body from ${senderJid} — skipping`);
        return;
    }

    const senderPhone = senderJid.split("@")[0];
    log("info", "Handler", `Message from ${senderPhone}: "${messageText}"`);

    // Schedule follow-up: if no human replies in 10 min, bot sends one info message
    // This runs regardless of whether bot auto-replies below
    scheduleFollowUp(senderPhone, senderJid);

    // ── Guard 4: Human Override check (team replied → 15 min silence) ──────────
    if (isHumanOverrideActive(senderPhone)) {
        return;
    }

    // ── Guard 5: SAFE MODE keyword/first-message check ────────────────────────
    if (!shouldAutoReply(senderPhone, messageText)) {
        return;
    }

    // ── Guard 6: Rate limit check ─────────────────────────────────────────────
    if (isRateLimited(senderPhone)) {
        log("warn", "Handler", `Rate limit hit for ${senderPhone} — no reply sent`);
        return;
    }

    // ── Build / retrieve conversation history ─────────────────────────────────
    if (!conversationHistory.has(senderPhone)) {
        conversationHistory.set(senderPhone, []);
        log("info", "Handler", `New conversation started for ${senderPhone}`);
    }
    const history = conversationHistory.get(senderPhone);

    // Append incoming user message + increment safe mode counter
    history.push({ role: "user", content: messageText });
    const smTracker = safeModeTracker.get(senderPhone) || { userMsgCount: 0, lastSenderWasUs: false };
    smTracker.userMsgCount += 1;
    smTracker.lastSenderWasUs = false;
    safeModeTracker.set(senderPhone, smTracker);
    log("info", "Handler", `History length for ${senderPhone}: ${history.length} | SafeMode msgCount: ${smTracker.userMsgCount}`);

    // ── Step 1: Get AI reply ──────────────────────────────────────────────────
    let aiReply;
    try {
        log("info", "OpenAI", `Sending request for ${senderPhone} (model: ${OPENAI_MODEL})`);
        aiReply = await getOpenAIReply(history);
        log("info", "OpenAI", `Reply for ${senderPhone}: "${aiReply}"`);
    } catch (err) {
        log("error", "OpenAI", `Request failed for ${senderPhone}:`, err.message);
        if (err.response) {
            log("error", "OpenAI", `Status: ${err.response.status}`, JSON.stringify(err.response.data));
        }
        // Remove the user message we just pushed so history stays clean
        history.pop();
        return;
    }

    // Persist assistant reply in history + mark "we replied last" in safe mode
    history.push({ role: "assistant", content: aiReply });
    const smTracker2 = safeModeTracker.get(senderPhone) || { userMsgCount: 0, lastSenderWasUs: false };
    smTracker2.lastSenderWasUs = true;
    safeModeTracker.set(senderPhone, smTracker2);

    // Trim to last MAX_HISTORY turn-pairs
    if (history.length > MAX_HISTORY * 2) {
        history.splice(0, history.length - MAX_HISTORY * 2);
        log("info", "Handler", `Trimmed history for ${senderPhone} to ${MAX_HISTORY * 2} messages`);
    }

    // ── Step 2: Send reply via Whapi ──────────────────────────────────────────
    try {
        log("info", "Whapi", `Sending reply to ${senderPhone}`);
        await sendWhatsAppMessage(senderJid, aiReply);
        log("info", "Whapi", `Reply delivered to ${senderPhone} ✓`);
    } catch (err) {
        log("error", "Whapi", `Failed to send message to ${senderPhone}:`, err.message);
        if (err.response) {
            log("error", "Whapi", `Status: ${err.response.status}`, JSON.stringify(err.response.data));
        }
    }
}

// ─── OpenAI Integration ──────────────────────────────────────────────────────
// history: { role: "user"|"assistant", content: string }[]
async function getOpenAIReply(history) {
    // ── Build system prompt dynamically from knowledge.json ──────────────────
    const K = KB;  // shorthand
    const systemPrompt = {
        role: "system",
        content: `Tu ${K.business?.assistant_name ?? "Priya"} hai — *${K.business?.name ?? "Guru Nanak Photostate"}*, ${K.business?.location ?? "Fatehabad, Haryana"} ki WhatsApp sales assistant.
Tu ek real human ki tarah baat karta hai — koi AI vibe nahi, sirf natural Hinglish conversation.

## LANGUAGE MIRRORING — sabse important rule:
- Customer Hindi/Hinglish mein likhe → tu bhi Hinglish mein reply kar
  Example: "bhai assignment chahiye" → "Haan bhai! 😊 Kaunsa programme hai tera?"
- Customer English mein likhe → tu bhi simple casual English mein reply kar
  Example: "I need assignment help" → "Sure! 😊 Which IGNOU programme are you in?"
- Language automatically detect kar — kabhi galat language mat use karna
- Har case mein: friendly, warm, human — robotic ya formal bilkul nahi

## TONE RULES:
- Friendly aur real lagna chahiye — jaise koi dost WhatsApp pe baat kar raha ho
- Confident reh — desperate mat lag, over-explain mat kar
- Kabhi bhi long paragraph mat bhej — sirf 1-2 chhoti lines max

## PEHLI BAAR GREETING (exactly yahi use kar):
"${K.greeting?.message ?? "Hello! 👋 Kaise help kar sakti hoon aapki? 😊"}"

## CONVERSATION FLOW — ek ek step, jump mat karna:
STEP 1 → Greet karo
STEP 2 → Poocho: "Aap kaunsa IGNOU programme kar rahe ho? jaise BCA, BA, MA, DECE etc 😊"
STEP 3 → Poocho: "Handwritten chahiye ya PDF? Dono available hai 📚"
STEP 4 → Poocho subject/codes (MA mein codes count poochho)
STEP 5 → Sirf unke course ka price batao — sara list mat batao kabhi
STEP 6 → Sample offer karo: "Ek sample page bhej doon quality check ke liye? 📄"
STEP 7 → Close karo: "Confirm kar loon order? Payment details bhej deta hoon abhi! 😊"
STEP 8 → Name + address lo (handwritten ke liye) ya sirf name (PDF ke liye)

## PRICING — sirf relevant info batao, poori list kabhi nahi:

HANDWRITTEN:
- ${K.handwritten_assignments?.price_display ?? "₹300 per assignment"}
- Courier: ${K.handwritten_assignments?.courier?.display ?? "₹100 fixed"} extra
- Delivery: ${K.handwritten_assignments?.delivery ?? "5-7 din"}

PDF:
- ${K.pdf_assignments?.price_display ?? "₹30 per assignment"}
- Delivery: ${K.pdf_assignments?.delivery ?? "Turant WhatsApp pe"}

DECE:
- Teeno assignments: ${K.special_courses?.DECE?.assignments?.bundle_display ?? "₹1000 sabke liye"}
- Project: ${K.special_courses?.DECE?.project?.price_display ?? "₹2000"}
- Minimum: ₹${K.negotiation_guide?.dece_minimum ?? 1800} se neeche kabhi nahi

MA COURSES:
- ${(K.special_courses?.MA?.pricing_by_codes?.tiers ?? []).map(t => t.display).join(" | ")}
- Pehle codes ki count poochho, phir price batao

## NEGOTIATION — jab customer bole "bahut mehnga hai" ya "kam karo":

STEP 1 — Pehle justify karo (discount mat do abhi):
  → "Yaar handwritten hota hai, IGNOU format mein, time lagta hai — quality ekdum sahi milti hai 👌"
  → "Hum khud likhte hain, printed copies nahi deta — isliye price thodi zyada hai"

STEP 2 — Agar phir bhi insist kare:
  → Assignments ke liye: courier waive kar do (₹100 chhod do)
  → "Theek hai, courier charge chhod deta hoon — bas assignment ka price rahega 😊"

STEP 3 — Project negotiation (sirf project ke liye, step by step):
  → Start: ₹2000
  → Ek baar: "₹1900 kar deta hoon"
  → Final: "₹1800 se aage possible nahi — yahi final hai bhai 🙏"
  → ₹1800 se neeche KABHI nahi jaana

## AGAR JAWAB NAHI PATA (price, course details, ya koi bhi uncertain info):
YEHI EXACT REPLY BHEJO — kuch bhi guess mat karo:
"Iske exact details ke liye team call karke guide kar degi 🙂
Aap preferred time bata do."

## PAYMENT:
- Methods: ${(K.payment_info?.methods ?? ["UPI", "GPay", "PhonePe", "Paytm"]).join(", ")} 💳
- ${K.payment_info?.advance ?? "Pehle payment, phir delivery"}
- ${K.payment_info?.after_payment ?? "Payment ka screenshot bhej dena confirmation ke liye"}

## HARD RULES — kabhi mat todna:
1. MAX 1-2 CHHOTI LINES — kabhi paragraph mat likhna
2. Ek message mein sirf ek sawal ya ek point
3. Poori price list ek saath kabhi mat batao
4. AI hoon yeh kabhi mat batao — tu Priya hai, ek real insaan
5. Assignment content ya answers kabhi mat likhna
6. Koi bhi price, course ya detail ke baare mein unsure ho → SIRF yeh bol:
   "Iske exact details ke liye team call karke guide kar degi 🙂 Aap preferred time bata do."
   NEVER guess. NEVER invent.
7. Topic se bhatak jaaye → "Main IGNOU assignments ke liye hoon 😊 Kaunsa course chahiye?"`
    };

    const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
            model: OPENAI_MODEL,
            messages: [systemPrompt, ...history],
            max_tokens: 100,
            temperature: 0.75,
        },
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY} `,
                "Content-Type": "application/json",
            },
            timeout: 30000,
        }
    );

    return response.data.choices[0].message.content.trim();
}

// ─── Whapi Cloud Integration ─────────────────────────────────────────────────
async function sendWhatsAppMessage(toJid, text) {
    await axios.post(
        `${WHAPI_API_URL} /messages/text`,
        {
            to: toJid,
            body: text,
        },
        {
            headers: {
                Authorization: `Bearer ${WHAPI_API_KEY} `,
                "Content-Type": "application/json",
            },
            timeout: 15000,
        }
    );
}

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    log("info", "Server", `WhatsApp AI Bot listening on port ${PORT} `);
    log("info", "Server", `Webhook URL: http://localhost:${PORT}/webhook`);
    log("info", "Server", `OpenAI Model: ${OPENAI_MODEL}`);
    log("info", "Server", `Rate limit: ${RATE_MAX} messages per ${RATE_WINDOW / 1000}s per user`);
});
