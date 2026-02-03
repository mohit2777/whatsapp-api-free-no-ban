# Product Design Requirements (PDR)
## WhatsApp Multi-Automation API Platform

**Version:** 4.0.0  
**Document Date:** February 2, 2026  
**Status:** Final Specification

---

## 1. Executive Summary

### 1.1 Product Overview
A self-hosted, lightweight WhatsApp Business API alternative that enables users to manage multiple WhatsApp accounts, automate messages with AI-powered chatbots, and integrate with external systems via webhooks. The platform runs entirely free on cloud infrastructure (Render + Supabase).

### 1.2 Core Value Proposition
- **Zero Cost**: 100% free hosting using free-tier cloud services
- **No Browser Required**: Uses Baileys WebSocket instead of Puppeteer/Chromium
- **Low Memory Footprint**: ~15-25MB RAM per connected account
- **Self-Hosted Privacy**: Full control over data and infrastructure
- **Multi-Provider AI**: Supports OpenAI, Anthropic, Gemini, Groq, OpenRouter

### 1.3 Target Use Cases
| Industry | Use Case |
|----------|----------|
| E-commerce | Order confirmations, shipping updates, abandoned cart recovery |
| Customer Support | AI chatbot for FAQs, ticket creation via webhook |
| Marketing | Broadcast campaigns, lead capture bots |
| Healthcare | Appointment reminders, patient follow-ups |
| Education | Class notifications, assignment reminders |

---

## 2. System Architecture

### 2.1 Technology Stack
| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 18+ | Server runtime |
| Framework | Express.js | HTTP server & REST API |
| WhatsApp | @whiskeysockets/baileys | WhatsApp Web connection via WebSocket |
| Database | PostgreSQL (Supabase) | Persistent storage |
| Real-time | Socket.IO | Live updates to dashboard |
| AI Providers | OpenAI, Anthropic, Gemini, Groq, OpenRouter | AI auto-reply generation |
| Caching | node-cache | In-memory caching |
| Logging | Winston + Pino | Structured logging |
| Security | Helmet, bcryptjs, express-rate-limit | Security middleware |

### 2.2 System Components
```
┌─────────────────────────────────────────────────────────────────────────┐
│                           WhatsApp Multi-Automation                      │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Express   │  │  Socket.IO  │  │   Baileys   │  │  AI Service │     │
│  │   Server    │  │   Server    │  │   Manager   │  │   Manager   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘     │
│         │               │                │                │              │
│         ▼               ▼                ▼                ▼              │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                     Database Layer (Supabase)                   │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │     │
│  │  │ Accounts │ │ Webhooks │ │ Sessions │ │ AI Configs       │   │     │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │     │
│  └────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Directory Structure
```
project/
├── index.js                 # Main application entry point
├── package.json             # Dependencies and scripts
├── schema.sql               # Database schema
├── render.yaml              # Render deployment config
├── .env.example             # Environment variables template
├── README.md                # Documentation
├── SETUP-GUIDE.md           # Step-by-step setup guide
├── config/
│   └── database.js          # Database connection & helpers
├── middleware/
│   └── auth.js              # Authentication middleware
├── utils/
│   ├── logger.js            # Logging utility
│   ├── validator.js         # Input validation with Joi
│   ├── rateLimiter.js       # Rate limiting configuration
│   ├── whatsappManager.js   # WhatsApp connection manager
│   ├── webhookDeliveryService.js  # Webhook queue & delivery
│   ├── aiAutoReply.js       # AI provider integrations
│   └── authSystem.js        # Anti-ban protection system
├── views/
│   ├── login.html           # Login page
│   └── dashboard.html       # Main dashboard
└── public/
    ├── css/
    │   └── dashboard.css    # Dashboard styles
    └── js/
        └── dashboard.js     # Dashboard client-side logic
```

---

## 3. Functional Requirements

### 3.1 Authentication System
| ID | Requirement | Priority |
|----|-------------|----------|
| AUTH-01 | Admin login with username/password | High |
| AUTH-02 | Secure session management with PostgreSQL store | High |
| AUTH-03 | Session timeout and auto-logout | Medium |
| AUTH-04 | bcrypt password hashing | High |
| AUTH-05 | Rate limiting on login attempts | High |

### 3.2 WhatsApp Account Management
| ID | Requirement | Priority |
|----|-------------|----------|
| WA-01 | Create new WhatsApp account connections | High |
| WA-02 | QR code authentication display | High |
| WA-03 | Session persistence in database | High |
| WA-04 | Account reconnection on server restart | High |
| WA-05 | Account status tracking (initializing, qr_ready, ready, disconnected, error) | High |
| WA-06 | Multiple concurrent account support | High |
| WA-07 | Per-account API key generation | High |
| WA-08 | Account deletion with cleanup | Medium |
| WA-09 | Anti-ban protection (human behavior simulation) | High |

### 3.3 Messaging API
| ID | Requirement | Priority |
|----|-------------|----------|
| MSG-01 | Send text messages via REST API | High |
| MSG-02 | Send media messages (images, documents) | Medium |
| MSG-03 | Receive incoming messages | High |
| MSG-04 | Typing indicator simulation | Medium |
| MSG-05 | Message delivery status tracking | Medium |
| MSG-06 | Duplicate message prevention | High |
| MSG-07 | Rate limiting per account | High |

### 3.4 Webhook System
| ID | Requirement | Priority |
|----|-------------|----------|
| WH-01 | Configure webhooks per account | High |
| WH-02 | Webhook secret for signature verification | High |
| WH-03 | Event type filtering (message, status, presence) | Medium |
| WH-04 | Retry queue with exponential backoff | High |
| WH-05 | Dead letter queue for failed deliveries | Medium |
| WH-06 | Webhook health monitoring | Medium |

### 3.5 AI Auto-Reply System
| ID | Requirement | Priority |
|----|-------------|----------|
| AI-01 | Multi-provider support (OpenAI, Anthropic, Gemini, Groq, OpenRouter) | High |
| AI-02 | Per-account AI configuration | High |
| AI-03 | Custom system prompts | High |
| AI-04 | Conversation history context | High |
| AI-05 | Temperature/model configuration | Medium |
| AI-06 | Enable/disable per account | High |

### 3.6 Dashboard UI
| ID | Requirement | Priority |
|----|-------------|----------|
| UI-01 | Account overview with status indicators | High |
| UI-02 | QR code display for pairing | High |
| UI-03 | Real-time status updates via Socket.IO | High |
| UI-04 | Webhook management interface | High |
| UI-05 | AI configuration interface | High |
| UI-06 | System health monitoring | Medium |
| UI-07 | API documentation viewer | Medium |
| UI-08 | Dark/light theme toggle | Low |
| UI-09 | Mobile responsive design | Medium |

---

## 4. Non-Functional Requirements

### 4.1 Performance
| ID | Requirement | Target |
|----|-------------|--------|
| PERF-01 | Memory per account | < 25MB |
| PERF-02 | Total server memory | < 512MB (free tier compatible) |
| PERF-03 | API response time | < 200ms |
| PERF-04 | WebSocket latency | < 100ms |
| PERF-05 | Concurrent accounts | 10-20 accounts |

### 4.2 Security
| ID | Requirement | Priority |
|----|-------------|----------|
| SEC-01 | Helmet.js security headers | High |
| SEC-02 | CORS configuration | High |
| SEC-03 | Rate limiting on all endpoints | High |
| SEC-04 | Input validation with Joi | High |
| SEC-05 | API key authentication for messaging | High |
| SEC-06 | Content Security Policy | High |
| SEC-07 | Secure cookie configuration | High |

### 4.3 Reliability
| ID | Requirement | Target |
|----|-------------|--------|
| REL-01 | Automatic reconnection on disconnect | Required |
| REL-02 | Session recovery on restart | Required |
| REL-03 | Graceful error handling | Required |
| REL-04 | Database retry with exponential backoff | Required |
| REL-05 | Health check endpoint | Required |

### 4.4 Scalability
| ID | Requirement | Notes |
|----|-------------|-------|
| SCALE-01 | Horizontal scaling support | Single instance optimized |
| SCALE-02 | Connection pooling | PostgreSQL pool management |
| SCALE-03 | Cache layer | In-memory with TTL |

---

## 5. API Specification

### 5.1 Authentication Endpoints
```
POST /api/auth/login     - Admin login
POST /api/auth/logout    - Logout
GET  /api/auth/user      - Get current user
```

### 5.2 Account Endpoints
```
GET    /api/accounts              - List all accounts
POST   /api/accounts              - Create new account
GET    /api/accounts/:id          - Get account details
DELETE /api/accounts/:id          - Delete account
POST   /api/accounts/:id/reconnect - Reconnect account
GET    /api/accounts/:id/qr       - Get QR code
POST   /api/accounts/:id/regenerate-api-key - Regenerate API key
```

### 5.3 Messaging Endpoints
```
POST /api/send           - Send message (API key auth)
POST /api/send-media     - Send media message (API key auth)
```

### 5.4 Webhook Endpoints
```
GET    /api/accounts/:id/webhooks     - List webhooks
POST   /api/accounts/:id/webhooks     - Create webhook
PUT    /api/webhooks/:id              - Update webhook
DELETE /api/webhooks/:id              - Delete webhook
POST   /api/webhooks/:id/test         - Test webhook
```

### 5.5 AI Configuration Endpoints
```
GET    /api/accounts/:id/ai-config    - Get AI config
POST   /api/accounts/:id/ai-config    - Save AI config
DELETE /api/accounts/:id/ai-config    - Delete AI config
```

### 5.6 System Endpoints
```
GET /api/health    - Health check with metrics
GET /ping          - Simple ping for uptime monitors
```

---

## 6. Database Schema

### 6.1 Tables
| Table | Purpose |
|-------|---------|
| whatsapp_accounts | Account info, session data, API keys |
| webhooks | Webhook configurations |
| webhook_delivery_queue | Retry queue for failed webhooks |
| ai_configs | AI auto-reply settings per account |
| conversation_history | Message history for AI context |
| session | Express session storage |

### 6.2 Key Relationships
- webhooks → whatsapp_accounts (many-to-one)
- ai_configs → whatsapp_accounts (one-to-one)
- conversation_history → whatsapp_accounts (many-to-one)
- webhook_delivery_queue → webhooks (many-to-one)

---

## 7. Environment Configuration

### 7.1 Required Variables
```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname
# OR
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key

# Authentication
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
SESSION_SECRET=random-secret

# Server
PORT=3000
NODE_ENV=production
```

### 7.2 Optional Variables
```env
# AI Providers
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
GEMINI_API_KEY=xxx
GROQ_API_KEY=xxx
OPENROUTER_API_KEY=xxx

# Behavior
TYPING_DELAY_MS=1500
KEEPALIVE_URL=https://your-app.onrender.com/ping
KEEPALIVE_INTERVAL_MINUTES=14

# Advanced
SESSION_COOKIE_SECURE=true
QUERY_CACHE_SIZE=1000
CACHE_TTL=300000
```

---

## 8. Deployment Requirements

### 8.1 Render Configuration
- Web Service type
- Node.js 18 runtime
- 512MB RAM (free tier)
- Auto-deploy from Git

### 8.2 Supabase Configuration
- Free tier PostgreSQL
- Connection pooling enabled
- RLS policies for security

### 8.3 Uptime Monitoring
- UptimeRobot or similar
- Ping interval: 5-14 minutes
- Alert on downtime

---

## 9. Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Project setup and dependencies
- [ ] Database configuration
- [ ] Logging system
- [ ] Authentication middleware

### Phase 2: WhatsApp Integration
- [ ] Baileys manager implementation
- [ ] Session persistence
- [ ] QR code generation
- [ ] Reconnection logic

### Phase 3: API Development
- [ ] Account CRUD endpoints
- [ ] Messaging API
- [ ] Webhook system
- [ ] Rate limiting

### Phase 4: AI Integration
- [ ] Multi-provider AI service
- [ ] Conversation history
- [ ] Auto-reply logic

### Phase 5: Frontend
- [ ] Login page
- [ ] Dashboard UI
- [ ] Real-time updates
- [ ] Responsive design

### Phase 6: Production Hardening
- [ ] Security audit
- [ ] Performance optimization
- [ ] Documentation
- [ ] Deployment scripts

---

## 10. Success Metrics

| Metric | Target |
|--------|--------|
| Memory usage | < 400MB with 10 accounts |
| API uptime | > 99% |
| Message delivery | > 99% success rate |
| QR scan to connected | < 30 seconds |
| AI response time | < 5 seconds |

---

## 11. Appendix

### 11.1 Baileys Connection States
- `initializing` - Starting connection
- `qr_ready` - QR code available for scanning
- `ready` - Connected and authenticated
- `disconnected` - Connection lost
- `auth_failed` - Authentication error
- `error` - General error state

### 11.2 Webhook Event Types
- `message` - Incoming message
- `message.status` - Delivery status update
- `presence` - Online/offline/typing status
- `connection` - Account connection changes

### 11.3 Supported AI Models
- OpenAI: gpt-4, gpt-4-turbo, gpt-3.5-turbo
- Anthropic: claude-3-opus, claude-3-sonnet, claude-3-haiku
- Gemini: gemini-pro, gemini-1.5-pro
- Groq: llama-3.1-70b, mixtral-8x7b
- OpenRouter: Various models via unified API
