# WhatsApp Multi-Automation API

> **A self-hosted WhatsApp Business API alternative** - Manage multiple WhatsApp accounts, automate messages with AI-powered chatbots, and integrate with any system via webhooks. Runs 100% free on Render + Supabase.

## 📱 What is this?

This is a **lightweight WhatsApp automation platform** that lets you:

- **Connect multiple WhatsApp accounts** - Manage all your business numbers from one dashboard
- **AI-Powered Chatbots** - Automatic replies using Claude, GPT-4, Gemini, or Groq with conversation memory
- **Webhook Integrations** - Send incoming messages to your CRM, ticketing system, or any API
- **Send Messages via API** - Integrate WhatsApp messaging into your apps and workflows
- **No Browser Required** - Uses Baileys (WebSocket) instead of Puppeteer, runs on 512MB RAM

### 💡 Use Cases

| Industry | Use Case |
|----------|----------|
| **E-commerce** | Order confirmations, shipping updates, abandoned cart recovery |
| **Customer Support** | AI chatbot for FAQs, ticket creation via webhook |
| **Marketing** | Broadcast campaigns, lead capture bots |
| **Healthcare** | Appointment reminders, patient follow-ups |
| **Education** | Class notifications, assignment reminders |

### 🆚 vs Official WhatsApp Business API

| Feature | Official API | This Platform |
|---------|-------------|---------------|
| Cost | $50-200+/month | **$0/month** |
| Setup | Meta approval process | Scan QR, done |
| Messages | Pay per conversation | Unlimited |
| AI Chatbot | Not included | ✅ Built-in |
| Self-hosted | No | ✅ Yes |

---

## 🚀 Quick Deploy (Free)

### Prerequisites
- Node.js 18+
- PostgreSQL database (or Supabase free tier)

### Option 1: Deploy to Render (Recommended)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Click the button above
2. Connect your GitHub repository
3. Add environment variables
4. Deploy!

### Option 2: Local Development

```bash
# Clone the repository
git clone https://github.com/your-username/whatsapp-multi-automation.git
cd whatsapp-multi-automation

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your configuration
# Then run:
npm run dev
```

---

## ⚙️ Configuration

### Required Environment Variables

```env
# Database (Supabase)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Authentication
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
SESSION_SECRET=random-32-character-string

# Server
PORT=3000
NODE_ENV=production
```

### Optional Environment Variables

```env
# AI Providers (add the ones you need)
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
GEMINI_API_KEY=xxx
GROQ_API_KEY=xxx
OPENROUTER_API_KEY=xxx

# Behavior
TYPING_DELAY_MS=1500

# For Render free tier (prevents sleeping)
KEEPALIVE_URL=https://your-app.onrender.com/ping
```

---

## 📡 API Usage

> **Authentication:** Every API call requires an `api_key` — found on the dashboard for each connected account.

> **Phone Number Format:** Use the **full phone number with country code**, no `+` prefix, no dashes/spaces.  
> Example: India `+91 98765 43210` → `919876543210` | US `+1 (555) 123-4567` → `15551234567`

---

### Send Text Message

```bash
curl -X POST https://your-app.onrender.com/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-account-api-key",
    "to": "919876543210",
    "message": "Hello from the API!"
  }'
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `api_key` | string | Yes | 64-char API key from dashboard |
| `to` | string | Yes | Phone number with country code (e.g. `919876543210`) or group JID (e.g. `120363123456@g.us`) |
| `message` | string | Yes | Message text (max 4096 chars) |

**Response:**

```json
{
  "success": true,
  "messageId": "ABCD1234567890",
  "to": "919876543210@s.whatsapp.net",
  "phone": "919876543210",
  "timestamp": 1706889600000
}
```

---

### Supported Media Types

| `mediaType` | Caption | Common Formats | Notes |
|-------------|---------|----------------|-------|
| `image` | ✅ Yes | JPEG, PNG, WebP, GIF | Auto-detected mimetype. GIFs play inline. |
| `video` | ✅ Yes | MP4, 3GP, MKV | WhatsApp may transcode large files. |
| `audio` | ❌ No | MP3, OGG, AAC, M4A, WAV | Sent as voice/audio. Caption is ignored. |
| `document` | ✅ Yes | PDF, DOCX, XLSX, ZIP, any file | Filename preserved. Falls back to `document` if `mediaType` is omitted. |

> **Max file size: 25 MB** (both upload and URL/base64).  
> **Caption** works on `image`, `video`, and `document`. For `audio`, any caption value is silently ignored.

---

### Send Media (File Upload)

Upload a file directly using `multipart/form-data`.

**Send an image with caption:**
```bash
curl -X POST https://your-app.onrender.com/api/send-media \
  -F "api_key=your-account-api-key" \
  -F "to=919876543210" \
  -F "mediaType=image" \
  -F "caption=Check this out!" \
  -F "media=@photo.jpg"
```

**Send a PDF document:**
```bash
curl -X POST https://your-app.onrender.com/api/send-media \
  -F "api_key=your-account-api-key" \
  -F "to=919876543210" \
  -F "mediaType=document" \
  -F "caption=Invoice for March" \
  -F "media=@invoice.pdf"
```

**Send a video with caption:**
```bash
curl -X POST https://your-app.onrender.com/api/send-media \
  -F "api_key=your-account-api-key" \
  -F "to=919876543210" \
  -F "mediaType=video" \
  -F "caption=Watch this!" \
  -F "media=@clip.mp4"
```

**Send an audio file (no caption):**
```bash
curl -X POST https://your-app.onrender.com/api/send-media \
  -F "api_key=your-account-api-key" \
  -F "to=919876543210" \
  -F "mediaType=audio" \
  -F "media=@voice.mp3"
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `api_key` | string | Yes | 64-char API key from dashboard |
| `to` | string | Yes | Phone with country code (e.g. `919876543210`) or group JID |
| `mediaType` | string | No | `image`, `video`, `audio`, or `document`. Defaults to `document` if omitted. |
| `caption` | string | No | Caption text (supported on image, video, document — ignored for audio) |
| `media` | file | Yes | The media file to send (max 25 MB) |

---

### Send Media (URL or Base64)

Send media from a public URL or base64-encoded string. Useful for automation (n8n, Make, Zapier).

**Image from URL with caption:**
```bash
curl -X POST https://your-app.onrender.com/api/send-media-url \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-account-api-key",
    "to": "919876543210",
    "mediaType": "image",
    "mediaUrl": "https://example.com/photo.jpg",
    "caption": "Sent via URL!"
  }'
```

**Document from URL with caption and filename:**
```bash
curl -X POST https://your-app.onrender.com/api/send-media-url \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-account-api-key",
    "to": "919876543210",
    "mediaType": "document",
    "mediaUrl": "https://example.com/report.pdf",
    "caption": "Here is the report",
    "filename": "report-march-2026.pdf"
  }'
```

**Video from base64 with caption:**
```bash
curl -X POST https://your-app.onrender.com/api/send-media-url \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-account-api-key",
    "to": "919876543210",
    "mediaType": "video",
    "mediaBase64": "data:video/mp4;base64,AAAAIGZ0eXBpc29t...",
    "caption": "Check this video"
  }'
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `api_key` | string | Yes | 64-char API key |
| `to` | string | Yes | Phone with country code or group JID |
| `mediaType` | string | Yes | `image`, `video`, `audio`, or `document` |
| `mediaUrl` | string | One of | Public URL to fetch media from (max 25 MB) |
| `mediaBase64` | string | One of | Base64-encoded data (with or without `data:` prefix) |
| `caption` | string | No | Caption text (supported on image, video, document — ignored for audio) |
| `mimetype` | string | No | MIME type override (auto-detected from URL/data prefix if omitted) |
| `filename` | string | No | Filename for document type (e.g. `report.pdf`) |

**Response (both endpoints):**

```json
{
  "success": true,
  "messageId": "ABCD1234567890",
  "to": "919876543210@s.whatsapp.net",
  "phone": "919876543210",
  "timestamp": 1741521600000
}
```

---

## 🤖 AI Auto-Reply Setup

1. Go to Dashboard → Accounts
2. Click the robot icon on a connected account
3. Configure:
   - **Provider**: OpenAI, Anthropic, Gemini, Groq, or OpenRouter
   - **API Key**: Your provider API key
   - **Model**: gpt-4, claude-3-sonnet, gemini-pro, etc.
   - **System Prompt**: Instructions for the AI
4. Enable and save!

---

## 🔗 Webhook Configuration

Webhooks send real-time events to your specified URL. Configure via dashboard or API.

### Supported Events

| Event | Description |
|-------|-------------|
| `message` | Incoming message (text, image, video, audio, document, sticker, location) |
| `message.status` | Message delivery status updates (sent, delivered, read) |
| `connection` | Account connection/disconnection events |
| `*` | Subscribe to all events |

---

### Webhook: Incoming Message (`message`)

```json
{
  "event": "message",
  "timestamp": "2026-03-09T12:00:00.000Z",
  "account_id": "uuid",
  "data": {
    "messageId": "ABC123",
    "from": "919876543210",
    "phone": "919876543210",
    "message": "Hello!",
    "messageType": "text",
    "isGroup": false,
    "timestamp": 1741521600,
    "pushName": "John",
    "replyTo": "919876543210"
  }
}
```

**For group messages**, additional fields are included:

```json
{
  "event": "message",
  "timestamp": "2026-03-09T12:00:00.000Z",
  "account_id": "uuid",
  "data": {
    "messageId": "ABC123",
    "from": "919876543210",
    "phone": "919876543210",
    "message": "Hello group!",
    "messageType": "text",
    "isGroup": true,
    "timestamp": 1741521600,
    "pushName": "John",
    "replyTo": "120363123456@g.us",
    "groupJid": "120363123456@g.us",
    "participant": "919876543210@s.whatsapp.net",
    "participantPhone": "919876543210"
  }
}
```

**For media messages**, a `media` object is included:

```json
{
  "data": {
    "messageType": "image",
    "message": "Photo caption here",
    "media": {
      "mimetype": "image/jpeg",
      "filename": null,
      "fileSize": 54321,
      "data": "<base64-encoded-data>",
      "thumbnail": "<base64-thumbnail>"
    }
  }
}
```

**Key fields:**

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Sender phone number with country code |
| `phone` | string | Resolved phone number (null if unavailable) |
| `replyTo` | string | Use this value as `to` in `/api/send` to reply |
| `messageType` | string | `text`, `image`, `video`, `audio`, `document`, `sticker`, `location`, `ptt` |
| `pushName` | string | Sender's WhatsApp display name |
| `isGroup` | boolean | Whether the message is from a group chat |

---

### Webhook: Message Status (`message.status`)

```json
{
  "event": "message.status",
  "timestamp": "2026-03-09T12:00:00.000Z",
  "account_id": "uuid",
  "data": {
    "messageId": "ABC123",
    "status": 3,
    "statusLabel": "delivered",
    "phone": "919876543210",
    "timestamp": "2026-03-09T12:00:01.000Z"
  }
}
```

**Status codes:** `1` = pending, `2` = sent (server), `3` = delivered, `4` = read, `5` = played (audio/video)

---

### Webhook: Connection (`connection`)

```json
{
  "event": "connection",
  "timestamp": "2026-03-09T12:00:00.000Z",
  "account_id": "uuid",
  "data": {
    "status": "connected",
    "phoneNumber": "919876543210"
  }
}
```

---

### Using `replyTo` for Auto-Replies (n8n / Make / Zapier)

When you receive a webhook, use the `replyTo` field to send a reply:

```bash
# Reply to the sender
curl -X POST https://your-app.onrender.com/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-api-key",
    "to": "<replyTo from webhook>",
    "message": "Thanks for your message!"
  }'
```

---

### Webhook Signature

If you set a webhook secret, verify the signature:

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return signature === expected;
}
```

---

## 🗄️ Database Setup

Run `schema.sql` in your Supabase SQL Editor to create all required tables.

---

## 📊 Features

- ✅ Multiple WhatsApp accounts
- ✅ No browser/Chromium needed (uses Baileys WebSocket)
- ✅ Low memory usage (~15-25MB per account)
- ✅ QR code authentication
- ✅ Webhook notifications for incoming messages
- ✅ AI Chatbot integration (OpenAI, Anthropic, Gemini, Groq, OpenRouter)
- ✅ Session persistence in PostgreSQL
- ✅ Real-time updates via Socket.IO
- ✅ Typing indicator before sending messages
- ✅ Rate limiting and security headers
- ✅ Mobile-responsive dashboard

---

## 📝 License

MIT License - feel free to use for personal or commercial projects.

---

## ⚠️ Disclaimer

This project is not affiliated with WhatsApp or Meta. Use at your own risk and comply with WhatsApp's Terms of Service.
