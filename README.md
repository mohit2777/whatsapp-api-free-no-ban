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

### Send Text Message

```bash
curl -X POST https://your-app.onrender.com/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-account-api-key",
    "phone": "918005780278",
    "message": "Hello from the API!"
  }'
```

### Send Media

```bash
curl -X POST https://your-app.onrender.com/api/send-media \
  -F "api_key=your-account-api-key" \
  -F "phone=918005780278" \
  -F "mediaType=image" \
  -F "caption=Check this out!" \
  -F "media=@image.jpg"
```

### Response

```json
{
  "success": true,
  "messageId": "ABCD1234567890",
  "timestamp": 1706889600000
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

Webhooks send incoming messages to your specified URL.

### Webhook Payload

```json
{
  "event": "message",
  "timestamp": "2024-02-02T12:00:00.000Z",
  "account_id": "uuid",
  "data": {
    "messageId": "ABC123",
    "from": "918005780278",
    "message": "Hello!",
    "messageType": "text",
    "isGroup": false,
    "pushName": "John"
  }
}
```

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
