# 🚀 Complete Setup Guide

**Welcome!** This guide will walk you through setting up your own FREE WhatsApp automation system.

---

## 📋 Table of Contents

1. [Prerequisites](#-prerequisites)
2. [Create Supabase Database](#-step-1-create-supabase-database)
3. [Deploy to Render](#-step-2-deploy-to-render)
4. [Configure Environment Variables](#-step-3-configure-environment-variables)
5. [Setup Database Schema](#-step-4-setup-database-schema)
6. [Connect WhatsApp](#-step-5-connect-whatsapp)
7. [Optional: AI Setup](#-step-6-optional-ai-setup)
8. [Optional: Keep Alive](#-step-7-optional-keep-alive)
9. [Troubleshooting](#-troubleshooting)

---

## 🛠️ Prerequisites

- A computer with internet access
- A smartphone with WhatsApp installed
- An email address for creating accounts
- 20-30 minutes of time

**No credit card required!**

---

## 📦 Step 1: Create Supabase Database

1. Go to [supabase.com](https://supabase.com) and sign up (use GitHub for easy login)

2. Click **"New Project"**

3. Fill in:
   - **Name**: whatsapp-automation
   - **Database Password**: Generate a strong password (save this!)
   - **Region**: Choose closest to you
   
4. Click **"Create new project"** and wait 2 minutes

5. Go to **Settings → API** and copy:
   - **Project URL** (starts with https://)
   - **service_role key** (secret, starts with eyJ...)

---

## 🚀 Step 2: Deploy to Render

1. Go to [render.com](https://render.com) and sign up (use GitHub)

2. Click **"New +"** → **"Web Service"**

3. Connect your GitHub repository (or use a template)

4. Configure:
   - **Name**: whatsapp-automation
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

5. Click **"Create Web Service"**

---

## ⚙️ Step 3: Configure Environment Variables

In Render, go to your service → **Environment** tab. Add these variables:

### Required

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service_role key |
| `ADMIN_USERNAME` | admin (or your preferred username) |
| `ADMIN_PASSWORD` | Create a strong password |
| `SESSION_SECRET` | Click "Generate" for random string |
| `NODE_ENV` | production |
| `PORT` | 3000 |

### Optional

| Variable | Value |
|----------|-------|
| `TYPING_DELAY_MS` | 1500 (typing indicator delay) |
| `SESSION_COOKIE_SECURE` | true |

Click **"Save Changes"** and wait for deployment.

---

## 🗄️ Step 4: Setup Database Schema

1. Go to your Supabase project

2. Click **SQL Editor** in the sidebar

3. Click **"New Query"**

4. Copy the entire contents of `schema.sql` and paste it

5. Click **"Run"**

You should see: "Success. No rows returned"

---

## 📱 Step 5: Connect WhatsApp

1. Open your Render app URL (something like `https://whatsapp-automation.onrender.com`)

2. Log in with your admin credentials

3. Click **"New Account"**

4. Enter a name for your WhatsApp account

5. A QR code will appear

6. On your phone:
   - Open WhatsApp
   - Go to **Settings** → **Linked Devices**
   - Tap **"Link a Device"**
   - Scan the QR code

7. Wait for "Connected" status

🎉 **Congratulations!** Your WhatsApp is now connected!

---

## 🤖 Step 6: Optional - AI Setup

To enable AI auto-replies:

1. Get an API key from one of:
   - [OpenAI](https://platform.openai.com/api-keys) - GPT-4
   - [Anthropic](https://console.anthropic.com/) - Claude
   - [Google AI](https://makersuite.google.com/app/apikey) - Gemini
   - [Groq](https://console.groq.com/keys) - Fast & Free

2. In the dashboard, click the 🤖 icon on your account

3. Configure:
   - **Provider**: Select your AI provider
   - **API Key**: Paste your key
   - **Model**: e.g., `gpt-4`, `claude-3-sonnet`, `gemini-pro`
   - **System Prompt**: Describe how the AI should respond

4. Enable and save!

---

## ⏰ Step 7: Optional - Keep Alive

Render free tier sleeps after 15 minutes of inactivity. To prevent this:

1. Go to [uptimerobot.com](https://uptimerobot.com) and sign up

2. Click **"Add New Monitor"**

3. Configure:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: WhatsApp Bot
   - **URL**: `https://your-app.onrender.com/ping`
   - **Monitoring Interval**: 5 minutes

4. Click **"Create Monitor"**

Now your bot stays online 24/7!

---

## 🔧 Troubleshooting

### QR Code won't scan
- Make sure you're using the latest WhatsApp version
- Try refreshing the page and scanning again
- Clear browser cache

### "Account disconnected" error
- Click the reconnect button
- Scan the QR code again
- Check if you logged out from your phone

### Messages not sending
- Verify the phone number format (country code + number, no + symbol)
- Check that the account is "Connected"
- Look at the Render logs for errors

### AI not responding
- Verify your API key is correct
- Check that AI is enabled for the account
- Ensure your API key has credits

### Database errors
- Make sure you ran the schema.sql
- Check Supabase is not paused (free tier pauses after 7 days of inactivity)

---

## 📞 Getting Help

- Check the [README](README.md) for API documentation
- Review the [PDR](PDR.md) for technical details
- Check Render logs for error messages

---

## 🎉 You're Done!

Your WhatsApp automation is now running! You can:

1. Send messages via API using your account's API key
2. Receive webhooks when messages arrive
3. Let AI handle conversations automatically

Happy automating! 🚀
