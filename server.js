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

// ─── Spam Protection Tracker ─────────────────────────────────────────────────
// Tracks last reply timing and text to enforce strict interval and duplicate rules.
// Also manages debouncing (queuing) for rapid-fire messages.
const spamTracker = new Map(); // phone -> { lastReplyAt, lastReplyText, debounceTimer, messageQueue: [] }
const SPAM_INTERVAL_MS = 60000; // 60 seconds strict between bot replies
const DEBOUNCE_WAIT_MS = 4000;  // Wait 4s for user to stop typing

/**
 * Checks if the bot is allowed to reply based on the 60s interval rule.
 * Also checks if the new AI reply is a duplicate of the last one.
 */
function isRateLimited(phone, newReplyText = null) {
    const entry = spamTracker.get(phone);
    if (!entry) return false;

    const intentEntry = leadStore.get(phone);
    const intent = intentEntry ? intentEntry.intent : "COLD";

    // Dynamic interval: HOT leads get 5s (priority), others 60s
    const currentInterval = intent === "HOT" ? 5000 : SPAM_INTERVAL_MS;

    const now = Date.now();

    // Rule: Dynamic interval between bot replies
    if (now - entry.lastReplyAt < currentInterval) {
        const remaining = Math.ceil((currentInterval - (now - entry.lastReplyAt)) / 1000);
        log("info", "Spam", `${phone} - ${intent} interval rule active - ${remaining}s remaining`);
        return true;
    }

    // Rule: Do not repeat same message twice
    if (newReplyText && entry.lastReplyText === newReplyText) {
        log("info", "Spam", `${phone} - duplicate message detected - blocking`);
        return true;
    }

    return false;
}

/**
 * Updates the tracker after a successful reply.
 */
function updateLastReply(phone, text) {
    const entry = spamTracker.get(phone) || { messageQueue: [] };
    entry.lastReplyAt = Date.now();
    entry.lastReplyText = text;
    spamTracker.set(phone, entry);
}

// ─── Conversation History (in-memory, per sender) ────────────────────────────
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ─── SAFE MODE & Lead Persistence ─────────────────────────────────────────────
// We store lead intent and message counts in memory.json so they survive restarts.
const MEMORY_FILE = path.join(__dirname, "memory.json");
const safeModeTracker = new Map();
const leadStore = new Map(); // phone → { intent: "HOT"|"WARM"|"COLD", updatedAt }

function saveMemory() {
    try {
        const data = {
            safeMode: Object.fromEntries(safeModeTracker),
            leads: Object.fromEntries(leadStore),
        };
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        log("error", "Memory", "Failed to save memory.json:", err.message);
    }
}

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
            if (data.safeMode) {
                Object.entries(data.safeMode).forEach(([k, v]) => safeModeTracker.set(k, v));
            }
            if (data.leads) {
                Object.entries(data.leads).forEach(([k, v]) => leadStore.set(k, v));
            }
            log("info", "Memory", `Loaded ${safeModeTracker.size} users and ${leadStore.size} leads from memory.json`);
        }
    } catch (err) {
        log("error", "Memory", "Failed to load memory.json:", err.message);
    }
}

// Initial load at startup
loadMemory();

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

// HOT — clear buying signals: ready to order / asking final details
const HOT_KEYWORDS = [
    // Order intent
    "bhej do", "bhejdo", "kar do", "kardo", "bej do", "order", "confirm", "book",
    "le loon", "le lunga", "le lenge", "lena hai", "chahiye", "de do",
    // Payment signals
    "payment", "pay", "upi", "gpay", "google pay", "phonepay", "phonepe",
    "paytm", "account number", "account no", "number bhejo", "details bhejo",
    // Delivery urgency
    "kab milega", "kab ayega", "kitne din", "kab milegi", "kab tak",
    "delivery time", "kab bhejoge", "jaldi chahiye", "urgent",
    // Positive confirmation
    "haan kar do", "ok kar do", "theek hai kar do", "done", "finalize",
];

// WARM — interested but not yet committed
const WARM_KEYWORDS = [
    // Inquiry
    "price", "rate", "cost", "kitna", "kitne", "fees", "charges", "kitna hai",
    "detail", "details", "info", "information", "bata do", "batao",
    "assignment", "project", "solve", "solution", "help",
    "sample", "demo", "example", "quality",
    "kya hai", "kaise", "how", "what", "which",
    // Greeting / first contact
    "hello", "hi", "hey", "helo", "namaste", "hii", "heyy",
];

// Detects and stores lead intent for a phone number
// Returns "HOT" | "WARM" | "COLD"
function detectLeadIntent(phone, messageText) {
    const text = messageText.toLowerCase();

    // Check HOT first (higher priority)
    const isHot = HOT_KEYWORDS.some((kw) => text.includes(kw));
    const isWarm = WARM_KEYWORDS.some((kw) => text.includes(kw));

    let intent;
    if (isHot) intent = "HOT";
    else if (isWarm) intent = "WARM";
    else intent = "COLD";

    // Only upgrade intent — never downgrade (HOT stays HOT)
    const existing = leadStore.get(phone);
    const RANK = { HOT: 3, WARM: 2, COLD: 1 };
    if (!existing || RANK[intent] > RANK[existing.intent]) {
        leadStore.set(phone, { intent, updatedAt: Date.now() });
        saveMemory();
        log("info", "Lead", `${phone} → intent: ${intent}`);
    } else {
        intent = existing.intent; // keep the higher intent
    }

    return intent;
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

// ─── Escalation & Closing System ──────────────────────────────────────────────
// Triggered when: customer asks for discount, seems confused, or reaches
// order-ready stage (address / payment submitted).
// Bot sends a handoff message then stays silent (20 min for help, 24h for orders).
const escalationStore = new Map(); // phone → { silencedUntil: timestamp }
const ESCALATION_MS = 20 * 60 * 1000; // 20 minutes (for confusion/discount)
const CLOSING_MS = 24 * 60 * 60 * 1000; // 24 hours (for orders — "stop" auto replies)

const ESCALATION_MSG = "Main details note kar raha hu 🙂\nTeam abhi confirm karke aapko guide kar degi.";
const CLOSING_MSG = "Perfect 🙂\nMain details note kar raha hu.\nTeam abhi payment aur dispatch guide kar degi.";

// Keywords that trigger escalation
const ESCALATION_DISCOUNT_KW = [
    "discount", "kam karo", "thoda kam", "kam ho sakta", "aur kam",
    "cheaper", "reduce", "negotiate", "less price", "extra discount",
    "chhod do", "maaf karo", "free karo", "free kar do",
];
const ESCALATION_CONFUSION_KW = [
    "samajh nahi", "samajh nahi aaya", "kya matlab", "nahi samjha",
    "confused", "confuse", "what do you mean", "don't understand",
    "pata nahi", "mujhe nahi pata", "clear nahi", "ye kya hai",
];
const ESCALATION_ORDER_KW = [
    // Address / contact submitted — order is ready to process
    "pin code", "pincode", "near", "opposite", "mohalla", "gali",
    "village", "ward no", "plot no", "house no", "flat no",
    // Payment done
    "kar diya", "kar diya payment", "paid", "payment ho gaya",
    "bhej diya", "screenshot bhej", "transfer kar diya", "payment kar di",
];

/**
 * Checks for triggers and sets the bot to silent mode.
 * Returns the specific message to be sent, or null if no trigger hit.
 */
function checkAndSetEscalation(phone, messageText) {
    const text = messageText.toLowerCase();

    // Check for Order Confirmation (High Priority)
    const orderHit = ESCALATION_ORDER_KW.some((kw) => text.includes(kw));
    if (orderHit) {
        const silencedUntil = Date.now() + CLOSING_MS;
        escalationStore.set(phone, { silencedUntil });
        log("info", "Closing", `ORDER CONFIRMED for ${phone} — bot stopped (24h)`);
        return CLOSING_MSG;
    }

    // Check for general Escalation (Discount/Confusion)
    const escalationHit =
        ESCALATION_DISCOUNT_KW.some((kw) => text.includes(kw)) ||
        ESCALATION_CONFUSION_KW.some((kw) => text.includes(kw));

    if (escalationHit) {
        const silencedUntil = Date.now() + ESCALATION_MS;
        escalationStore.set(phone, { silencedUntil });
        log("info", "Escalation", `ESCALATED for ${phone} — bot silent (20 min)`);
        return ESCALATION_MSG;
    }

    return null;
}

// Returns true if escalation silence is still active
function isEscalationActive(phone) {
    const entry = escalationStore.get(phone);
    if (!entry) return false;
    if (Date.now() < entry.silencedUntil) {
        const remaining = Math.ceil((entry.silencedUntil - Date.now()) / 1000 / 60);
        log("info", "Escalation", `${phone} — escalation ACTIVE (${remaining} min remaining)`);
        return true;
    }
    escalationStore.delete(phone);
    log("info", "Escalation", `${phone} — escalation EXPIRED — bot resumed`);
    return false;
}

// ─── Follow-Up System ──────────────────────────────────────────────────────────────
// If a customer stops replying, we send up to 2 nudges:
// 1. After 30 minutes
// 2. After 6 hours
const followUpStore = new Map(); // phone → { timerId, count }
const FOLLOWUP_T1_MS = 30 * 60 * 1000; // 30 minutes
const FOLLOWUP_T2_MS = 6 * 60 * 60 * 1000; // 6 hours

const FOLLOWUP_MSG_1 = "Aapko assignment chahiye tha na 🙂\nCourse bata do to main exact guide kar du.";
const FOLLOWUP_MSG_2 = "Aaj kaam karwa denge to submission tension khatam 🙂\nBata do help chahiye?";

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

// Schedule a follow-up (resets cycle on any interaction)
function scheduleFollowUp(phone, senderJid, stage = 1) {
    let entry = followUpStore.get(phone);
    if (!entry) {
        entry = { timerId: null, count: 0 };
        followUpStore.set(phone, entry);
    }

    // Cancel any existing timer
    if (entry.timerId) {
        clearTimeout(entry.timerId);
        entry.timerId = null;
    }

    // If stage is 1, it means a fresh interaction happened — reset count
    if (stage === 1) {
        entry.count = 0;
    }

    // Don't follow up if we already sent 2 or if human override is active
    if (entry.count >= 2 || isHumanOverrideActive(phone)) {
        return;
    }

    const delay = stage === 1 ? FOLLOWUP_T1_MS : (FOLLOWUP_T2_MS - FOLLOWUP_T1_MS);
    const msg = stage === 1 ? FOLLOWUP_MSG_1 : FOLLOWUP_MSG_2;

    entry.timerId = setTimeout(async () => {
        try {
            // Check if user replied in the meantime or override activated
            if (isHumanOverrideActive(phone)) return;

            await sendWhatsAppMessage(senderJid, msg);
            entry.count++;
            log("info", "FollowUp", `${phone} — Sent Stage ${entry.count} nudge`);

            // If we just sent Stage 1, schedule Stage 2
            if (entry.count === 1) {
                scheduleFollowUp(phone, senderJid, 2);
            }
        } catch (err) {
            log("error", "FollowUp", `${phone} — failed to nudge:`, err.message);
        }
    }, delay);
}

// Cancel a pending follow-up (called when team manually replies)
function cancelFollowUp(phone) {
    const entry = followUpStore.get(phone);
    if (entry?.timerId) {
        clearTimeout(entry.timerId);
        entry.timerId = null;
        log("info", "FollowUp", `${phone} — follow-up timer PAUSED (team/human active)`);
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
app.get("/webhook", (req, res) => {
    const challenge = req.query.challenge || req.query["hub.challenge"];
    if (challenge) {
        log("info", "Webhook", "Verification challenge received and returned");
        return res.status(200).send(challenge);
    }
    res.status(403).send("No challenge provided");
});

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
            saveMemory();

            // Set HUMAN OVERRIDE — bot silent for 15 minutes
            setHumanOverride(customerPhone);

            // Schedule follow-up — if user doesn't reply to team, bot will nudge
            scheduleFollowUp(customerPhone, customerJid);
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

    // ── Spam Protection: Debouncing ──────────────────────────────────────────
    // If user sends many messages quickly, we wait 4s after the LAST one before replying.
    let entry = spamTracker.get(senderPhone);
    if (!entry) {
        entry = { lastReplyAt: 0, lastReplyText: "", debounceTimer: null, messageQueue: [] };
        spamTracker.set(senderPhone, entry);
    }

    // Accumulate the message
    entry.messageQueue.push(messageText);

    // Reset the debounce timer
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);

    entry.debounceTimer = setTimeout(async () => {
        // Core logic now runs inside the debounce callback
        try {
            await executeMainLogic(senderPhone, senderJid);
        } catch (err) {
            log("error", "Spam", `Error in debounced processing for ${senderPhone}:`, err.message);
        }
    }, DEBOUNCE_WAIT_MS);
}

/**
 * The actual intelligence logic, executed after debouncing multiple messages.
 */
async function executeMainLogic(senderPhone, senderJid) {
    const entry = spamTracker.get(senderPhone);
    if (!entry || entry.messageQueue.length === 0) return;

    // Join all messages sent during the debounce window
    const combinedText = entry.messageQueue.join(" ");
    entry.messageQueue = []; // Clear for next round

    log("info", "Spam", `${senderPhone} - processing combined text: "${combinedText}"`);

    // Schedule follow-up
    scheduleFollowUp(senderPhone, senderJid);

    // ── Guard 4: Human Override check
    if (isHumanOverrideActive(senderPhone)) return;

    // ── Guard 4.5: Escalation Active check
    if (isEscalationActive(senderPhone)) return;

    // ── Guard 5: SAFE MODE
    if (!shouldAutoReply(senderPhone, combinedText)) return;

    // ── Guard 6: Interval rule (Once per 60s)
    if (isRateLimited(senderPhone)) {
        log("warn", "Spam", `${senderPhone} - interval rule blocked the reply`);
        return;
    }

    // ── Build / retrieve conversation history
    const isNewSession = !conversationHistory.has(senderPhone);
    const hasPastHistory = safeModeTracker.has(senderPhone);
    const restartingContext = isNewSession && hasPastHistory;

    if (isNewSession) {
        conversationHistory.set(senderPhone, []);
    }
    const history = conversationHistory.get(senderPhone);

    // Append combined user message + increment safe mode counter
    history.push({ role: "user", content: combinedText });
    const smTracker = safeModeTracker.get(senderPhone) || { userMsgCount: 0, lastSenderWasUs: false };
    smTracker.userMsgCount += 1;
    smTracker.lastSenderWasUs = false;
    safeModeTracker.set(senderPhone, smTracker);
    saveMemory();

    // Detect intent
    const leadIntent = detectLeadIntent(senderPhone, combinedText);

    // ── Escalation/Closing trigger (discount / confusion / order-ready) ──────
    const handoffMsg = checkAndSetEscalation(senderPhone, combinedText);
    if (handoffMsg) {
        try {
            await sendWhatsAppMessage(senderJid, handoffMsg);
            updateLastReply(senderPhone, handoffMsg);
            log("info", "Handoff", `Handoff/Closing message sent to ${senderPhone}`);
        } catch (err) {
            log("error", "Handoff", `Failed to send handoff message to ${senderPhone}:`, err.message);
        }
        return; // do NOT call OpenAI
    }

    // ── Step 1: Get AI reply
    let aiReply;
    try {
        log("info", "OpenAI", `Sending request for ${senderPhone} (HOT/WARM/COLD: ${leadIntent}${restartingContext ? " | RESTARTING" : ""})`);
        aiReply = await getOpenAIReply(history, leadIntent, restartingContext);

        // EXTRA RULE: Do not repeat same message twice
        if (isRateLimited(senderPhone, aiReply)) {
            log("info", "Spam", `${senderPhone} - blocked duplicate AI reply`);
            return;
        }

        log("info", "OpenAI", `Reply for ${senderPhone}: "${aiReply}"`);
    } catch (err) {
        log("error", "OpenAI", `Request failed for ${senderPhone}:`, err.message);
        history.pop();
        return;
    }

    // Persist assistant reply
    history.push({ role: "assistant", content: aiReply });
    const smTracker2 = safeModeTracker.get(senderPhone) || { userMsgCount: 0, lastSenderWasUs: false };
    smTracker2.lastSenderWasUs = true;
    safeModeTracker.set(senderPhone, smTracker2);

    // Trim history
    if (history.length > MAX_HISTORY * 2) {
        history.splice(0, history.length - MAX_HISTORY * 2);
    }

    // ── Step 2: Send reply via Whapi
    try {
        await sendWhatsAppMessage(senderJid, aiReply);
        updateLastReply(senderPhone, aiReply); // Track last sent
        log("info", "Whapi", `Reply delivered to ${senderPhone} ✓`);
    } catch (err) {
        log("error", "Whapi", `Failed to send message to ${senderPhone}:`, err.message);
    }
}

// ─── OpenAI Integration ──────────────────────────────────────────────────────
// history: { role: "user"|"assistant", content: string }[]
// intent:  "HOT" | "WARM" | "COLD"
async function getOpenAIReply(history, intent = "WARM", restarting = false) {
    // ── Build system prompt dynamically from knowledge.json ──────────────────
    const K = KB;  // shorthand
    const systemPrompt = {
        role: "system",
        content: `Tu ${K.business?.assistant_name ?? "Priya"} hai — *${K.business?.name ?? "Guru Nanak Photostate"}*, ${K.business?.location ?? "Fatehabad, Haryana"} ki WhatsApp sales assistant.
Tu ek real human ki tarah baat karta hai — koi AI vibe nahi, sirf natural Hinglish conversation.

${restarting ? "## RESTART SAFETY:\nUser se pehle baat hui thi par long break ke baad message aaya hai. Pehle line mein yeh politeness context check zaroor bolo: 'Last time aap assignment ke bare me pooch rahe the na? 🙂'\n\n" : ""}

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
7. Topic se bhatak jaaye → "Main IGNOU assignments ke liye hoon 😊 Kaunsa course chahiye?"

## 🔥 CURRENT LEAD STATUS: ${intent}
${intent === "HOT"
                ? "CUSTOMER HOT LEAD HAI — order confirmation flow shuru karo.\n" +
                "Conversation history dekho aur sirf NEXT missing info poochho — ek baar mein sirf EK cheez:\n\n" +
                "STEP A: COURSE + SUBJECT confirm hai?\n" +
                "  → Nahi: 'Konsa course aur subject hai? 😊'\n\n" +
                "STEP B: HANDWRITTEN ya PDF?\n" +
                "  → Nahi: 'Handwritten chahiye ya PDF? 📄'\n\n" +
                "STEP C: DELIVERY confirm?\n" +
                "  → Handwritten: 'Courier se bhejenge — address chahiye 😊'\n" +
                "  → PDF: 'WhatsApp pe turant bhej denge ✅'\n\n" +
                "STEP D: CONTACT INFO:\n" +
                "  → Handwritten: 'Poora delivery address bata do 😊'\n" +
                "  → PDF: 'Bas naam confirm karo!'\n\n" +
                "STEP E: SAB DONE? Payment bhejo:\n" +
                "  → 'Perfect! UPI details bhej rahi hoon — abhi kar do 😊'\n\n" +
                "RULES: Jo already confirm hai woh mat poochho. Ek message = ek question only. Max 2 lines."
                : intent === "WARM"
                    ? "CUSTOMER INTERESTED HAI — conversation chalu rakho aur sawaal poochho:\n" +
                    "→ Course/type missing hai to poocho\n" +
                    "→ Price batao specifically unke liye\n" +
                    "→ Goal: Inhe HOT lead banana hai sawaal pooch kar"
                    : "CUSTOMER COLD HAI — sirf initial greeting bhej ke ruk jao:\n" +
                    "→ Agar first message hai: Simple greeting do\n" +
                    "→ Uske baad: Zyada effort mat lagao, wait karo\n" +
                    "→ Jab tak keyword na mile, deep sales pitch mat karo"
            }`,
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
