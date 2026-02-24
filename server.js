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

// ─── Env Validation ──────────────────────────────────────────────────────────
const {
    PORT = 3000,
    OPENAI_API_KEY,
    OPENAI_MODEL = "gpt-4o-mini",
    WHAPI_API_KEY,
    WHAPI_API_URL = "https://gate.whapi.cloud",
    RATE_LIMIT_MAX = "5",          // max messages per window per user
    RATE_LIMIT_WINDOW_MS = "60000", // window size in ms (default: 1 minute)
} = process.env;

if (!OPENAI_API_KEY) {
    console.error("[FATAL] OPENAI_API_KEY is not set in environment variables.");
    process.exit(1);
}

if (!WHAPI_API_KEY) {
    console.error("[FATAL] WHAPI_API_KEY is not set in environment variables.");
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
// Stores { role, content }[] keyed by phone number.
// Trimmed to MAX_HISTORY turn-pairs to keep token usage bounded.
const conversationHistory = new Map();
const MAX_HISTORY = 20;

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
    // ── Guard 1: Ignore own messages ─────────────────────────────────────────
    if (message.from_me === true) {
        log("info", "Handler", "Skipping own outgoing message");
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

    // ── Guard 4: Rate limit check ─────────────────────────────────────────────
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

    // Append incoming user message
    history.push({ role: "user", content: messageText });
    log("info", "Handler", `History length for ${senderPhone}: ${history.length} messages`);

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

    // Persist assistant reply in history
    history.push({ role: "assistant", content: aiReply });

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
    const systemPrompt = {
        role: "system",
        content: `You are a friendly and professional sales assistant for an IGNOU assignment solution service. Your name is Priya.

Your goal is to guide the customer toward placing an order. Follow this conversation flow:

1. GREET — Warmly welcome the customer on their first message.
   Example: "Hello! 👋 Welcome to our IGNOU Assignment Help service. I'm Priya, here to assist you!"

2. COLLECT COURSE — If the customer has not mentioned their IGNOU programme (e.g. BCA, MCA, BA, MCOM, MEG, MPS), ask for it politely before moving forward.

3. COLLECT SUBJECT — Once the course is known, ask for the subject or paper code if not already provided (e.g. MCS-011, BEGC-131, ECO-01). Handle one subject at a time.

4. SHARE PRICING — Once course and subject are known:
   - Handwritten assignments: ₹100–₹150 per assignment
   - Typed / PDF assignments: ₹80–₹120 per assignment
   - Full session combo (all subjects): special discounted rates
   Mention that exact price depends on the number of questions/pages.

5. OFFER SAMPLE — Offer to send a free sample page for quality check before ordering.

6. CLOSE THE SALE — Ask: "Shall I confirm your order? I'll send payment details right away. 😊"
   If customer confirms, ask for their full name and WhatsApp number for records.

Strict rules:
- Replies must be SHORT — max 3 to 4 lines only. This is WhatsApp, not email.
- Add 1–2 emojis per reply to stay friendly and approachable.
- NEVER reveal you are an AI. Always respond as Priya, a human assistant.
- Delivery time: "Within 24–48 hours after payment confirmation. ⏱️"
- Payment methods: "UPI, GPay, PhonePe, and Paytm. 💳"
- If the conversation goes off-topic, gently steer back to assignments.
- Do NOT write or invent actual assignment answers.`,
    };

    const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
            model: OPENAI_MODEL,
            messages: [systemPrompt, ...history],
            max_tokens: 200,
            temperature: 0.65,
        },
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
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
        `${WHAPI_API_URL}/messages/text`,
        {
            to: toJid,
            body: text,
        },
        {
            headers: {
                Authorization: `Bearer ${WHAPI_API_KEY}`,
                "Content-Type": "application/json",
            },
            timeout: 15000,
        }
    );
}

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    log("info", "Server", `WhatsApp AI Bot listening on port ${PORT}`);
    log("info", "Server", `Webhook URL: http://localhost:${PORT}/webhook`);
    log("info", "Server", `OpenAI Model: ${OPENAI_MODEL}`);
    log("info", "Server", `Rate limit: ${RATE_MAX} messages per ${RATE_WINDOW / 1000}s per user`);
});
