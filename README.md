# 🤖 WhatsApp AI Sales Bot

A production-ready Node.js + Express server that acts as an **IGNOU assignment sales assistant** ("Priya") on WhatsApp — powered by **OpenAI** and **Whapi Cloud**.

---

## 📋 Features

- ✅ Receives WhatsApp messages via Whapi Cloud webhook
- ✅ Replies using OpenAI GPT (fully configurable model)
- ✅ Conversational memory per customer (no context loss)
- ✅ Sales flow: greet → course → subject → pricing → sample → order
- ✅ Rate limiting (5 msg/min per number, configurable)
- ✅ Ignores own messages, non-text, and empty messages
- ✅ Timestamped structured console logs
- ✅ Immediate 200 response to webhook (never blocks Whapi)
- ✅ Health check endpoint for cloud platform keep-alive

---

## 📁 Project Structure

```
whatsapp-ai-bot/
├── server.js        ← Main Express app + all bot logic
├── package.json     ← Dependencies & scripts
├── .env.example     ← Template for environment variables
└── .gitignore       ← Excludes .env and node_modules
```

---

## ⚡ Quick Start (Local)

**1. Install dependencies**
```bash
npm install
```

**2. Set up environment variables**
```bash
copy .env.example .env
```
Open `.env` and fill in your real API keys.

**3. Start the server**
```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

**4. Expose local server to the internet (for webhook testing)**

Install [ngrok](https://ngrok.com/), then:
```bash
ngrok http 3000
```
Copy the `https://xxxx.ngrok.io` URL and set it as your Whapi webhook:
```
https://xxxx.ngrok.io/webhook
```

---

## 🌐 Cloud Deployment

### Option A — Render (recommended free tier)

1. Push this project to a **GitHub repository**

2. Go to [render.com](https://render.com) → **New → Web Service**

3. Connect your GitHub repo

4. Set the following in Render settings:

   | Field | Value |
   |---|---|
   | **Runtime** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |

5. Under **Environment → Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `OPENAI_API_KEY` | `sk-...` |
   | `WHAPI_API_KEY` | Your Whapi channel token |
   | `OPENAI_MODEL` | `gpt-4o-mini` *(optional)* |
   | `WHAPI_API_URL` | `https://gate.whapi.cloud` *(optional)* |
   | `RATE_LIMIT_MAX` | `5` *(optional)* |
   | `RATE_LIMIT_WINDOW_MS` | `60000` *(optional)* |

   > ⚠️ **Do NOT set `PORT`** — Render assigns it automatically and injects it as `process.env.PORT`.

6. Click **Deploy**. Once live, your URL will look like:
   ```
   https://whatsapp-ai-bot.onrender.com
   ```

7. In **Whapi Cloud Dashboard → Your Channel → Settings → Webhook URL**, set:
   ```
   https://whatsapp-ai-bot.onrender.com/webhook
   ```

8. For Render free tier, enable the **Health Check** path as `/` to prevent spin-down.

---

### Option B — Railway

1. Push this project to a **GitHub repository**

2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**

3. Select your repo — Railway auto-detects Node.js and runs `npm start`

4. Go to your service → **Variables** tab, add:

   | Key | Value |
   |---|---|
   | `OPENAI_API_KEY` | `sk-...` |
   | `WHAPI_API_KEY` | Your Whapi channel token |
   | `OPENAI_MODEL` | `gpt-4o-mini` *(optional)* |
   | `WHAPI_API_URL` | `https://gate.whapi.cloud` *(optional)* |
   | `RATE_LIMIT_MAX` | `5` *(optional)* |
   | `RATE_LIMIT_WINDOW_MS` | `60000` *(optional)* |

   > ⚠️ **Do NOT set `PORT`** — Railway injects it automatically.

5. On the **Settings** tab, find your public domain (e.g. `whatsapp-ai-bot.up.railway.app`)

6. Set Whapi webhook URL to:
   ```
   https://whatsapp-ai-bot.up.railway.app/webhook
   ```

---

## 🔑 Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ Yes | — | OpenAI secret key |
| `WHAPI_API_KEY` | ✅ Yes | — | Whapi Cloud channel token |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | OpenAI model to use |
| `WHAPI_API_URL` | No | `https://gate.whapi.cloud` | Whapi base URL |
| `PORT` | No | `3000` | Auto-set by Render/Railway |
| `RATE_LIMIT_MAX` | No | `5` | Max messages per window per user |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window in milliseconds |

---

## 🔌 API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check — returns `{ status: "ok" }` |
| `POST` | `/webhook` | Receives incoming WhatsApp messages from Whapi |

---

## 🛡️ Rate Limiting

Each WhatsApp number is limited to **5 messages per 60 seconds** by default.

- Adjust via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` env vars
- Numbers exceeding the limit are silently dropped (no reply sent)
- The window resets automatically — no cleanup required

---

## 🗣️ Sales Conversation Flow

```
Customer Message
      │
      ▼
  👋 Greet warmly (first message only)
      │
      ▼
  ❓ Ask for IGNOU Course (BCA / MCA / BA / etc.)
      │
      ▼
  ❓ Ask for Subject / Paper Code
      │
      ▼
  💰 Share pricing
      ├── Handwritten: ₹100–₹150
      └── Typed/PDF  : ₹80–₹120
      │
      ▼
  📄 Offer free sample page
      │
      ▼
  ✅ Confirm order → collect name & number
```

---

## 📦 Scripts

```bash
npm start      # Start production server
npm run dev    # Start with nodemon (auto-restart)
```
