# Ban Prevention Audit & Fixes — 2026-03-31

## Diagnosis Summary

Full codebase audit against ban-proof rules after account ban incident.
Root cause: combination of **7 ban-triggering issues** identified across session management,
rate limiting, connection handling, and behavioral fingerprinting.

---

## CRITICAL Issues Found & Fixed

### 1. Connection Order NOT Randomized (BAN TRIGGER)
**File:** `utils/whatsappManager.js` → `initializeAccounts()`
**Problem:** Accounts were connected in `created_at DESC` order on every restart. WhatsApp
detects identical connection sequences from the same IP as automation.
**Fix:** Added Fisher-Yates shuffle before connecting accounts.

### 2. HTTP Rate Limiter Mismatch — 30/min vs 20/min (BAN TRIGGER)
**File:** `utils/rateLimiter.js`
**Problem:** Express `messageLimiter` allowed 30 requests/min but WhatsApp-level limit was
20/min. The 10 excess requests passed HTTP but failed at WA level, causing confusing errors
that led API consumers to retry aggressively.
**Fix:** Lowered `messageLimiter.max` from 30 → 20 to match the WhatsApp internal limit.

### 3. `getMessage` Bug in Poll Vote Handler (RUNTIME ERROR)
**File:** `utils/whatsappManager.js` → `handleIncomingMessage()` poll_vote section
**Problem:** Code called `getMessage(pollMsgKey)` — a function that doesn't exist in that
scope. The correct function is `getStoredMessage()`. This caused `ReferenceError` on every
poll vote, silently breaking poll decryption and logging errors.
**Fix:** Changed to `getStoredMessage(pollMsgKey)`.

### 4. Health Monitor Bypassed `maxReconnectAttempts` (BAN TRIGGER)
**File:** `utils/whatsappManager.js` → `_startHealthMonitor()`
**Problem:** Health monitor (Case 3) could re-trigger reconnects every 10 minutes for
accounts in 'error' state, even AFTER `maxReconnectAttempts` was reached in the normal
connection handler. The counter was set to `attempts + 1` locally but could cycle from
0→3 repeatedly, creating a persistent reconnection pattern that WhatsApp detects.
**Fix:** Added explicit check that total attempts (including health monitor) stay under
limit. Added log message when limit is reached. Increased health monitor reconnect
delays to 60-120s (was 30-60s).

### 5. Read Receipts Had Detectable Fixed Pattern (BAN TRIGGER)
**File:** `utils/whatsappManager.js` → `handleIncomingMessage()`
**Problem:** Read receipts sent at exactly 70% probability with 3-15s delay range. This
is a detectable statistical fingerprint — real users show much more variance.
**Fix:**
- Variable probability: 40-65% per message (randomized each time)
- Much wider delay: 3-45s for most reads
- 10% chance of "late read" at 30-120s (mimics reading notifications later)

### 6. Session Save Debounce Window Too Wide (DATA LOSS → CIPHERTEXT → BAN)
**File:** `utils/whatsappManager.js`
**Problem:** 5-second debounce + 60-second periodic save = up to 65 seconds of Signal
key changes that could be lost if the process crashes on an ephemeral filesystem (Render).
Lost Signal keys → CIPHERTEXT errors for every contact → rapid session resets → ban.
**Fix:** Reduced debounce from 5s → 3s to narrow the data loss window.

### 7. Memory Leaks Causing OOM → Reconnection Storms (BAN TRIGGER)
**File:** `utils/whatsappManager.js`
**Problem:** Multiple `Map` objects grew unbounded over time:
- `lastMessagePerJid` — never cleaned, grows per contact
- `messageSendTimestamps` / `messageSendTimestampsHourly` — stale account entries
- `onWhatsAppCache` — only cleaned on >5000 entries
- `aiReplyTracker` — expired windows never evicted
- `recentMessageHashes` — only cleaned on >5000 entries
- `lastSendTimestamp` — entries for disconnected accounts

On long-running instances this causes OOM → container kill → all accounts reconnect
simultaneously from same IP → ban.
**Fix:** Added `_startMemoryCleanup()` method that runs every 5 minutes and evicts
stale entries from all Maps. Cleanup interval is stopped on shutdown.

---

## SECONDARY Issues Found & Fixed

### 8. `/api/send-media-url` Missing Input Validation (SECURITY)
**File:** `index.js`
**Problem:** Endpoint had no Joi validation middleware and only partial manual checks.
Missing: api_key format validation, `to` length validation, `mediaType` whitelist,
`caption` length limit.
**Fix:** Added comprehensive input validation at the top of the handler.

### 9. Poll Vote `pollEncKey` Lookup Had Wrong Property Path
**File:** `utils/whatsappManager.js`
**Problem:** `pollCreationMsg.messageContextInfo?.messageSecret` — but `messageContextInfo`
might be nested under `.message` depending on how the message was stored.
**Fix:** Added fallback: `pollCreationMsg.messageContextInfo || pollCreationMsg.message?.messageContextInfo`.

---

## Files Modified
- `utils/whatsappManager.js` — 7 changes (connection order, read receipts, health monitor, memory cleanup, debounce, poll bugs)
- `utils/rateLimiter.js` — 1 change (30→20 rate limit)
- `index.js` — 1 change (send-media-url validation)

---

## What Was Already Correct (Positive Audit Findings)
- Signal key persistence via `keys.set()` wrapper → debounced DB save ✓
- `saveSession()` uses SHA-256 hash-before-write to skip unchanged sessions ✓
- Session restore validates ALL identity keys before writing ✓
- `_safeOnWhatsApp()` rate limits at 8/60s with 24h cache ✓
- No raw `sock.onWhatsApp()` calls anywhere ✓
- All 4 send methods use `_enqueueSend()` serialization ✓
- All 4 send methods check `_checkSendRateLimit()` before sending ✓
- Human-like presence: available → composing → paused → send → deferred unavailable ✓
- Active conversation tracking skips global 'available' for in-convo messages ✓
- Deferred unavailable only fires if no newer message sent ✓
- `typingDelay()` scales with message length ✓
- AI auto-reply loop guard (3 per 5min, reset on human message) ✓
- AI auto-reply blocked for group chats ✓
- No bulk/batch/broadcast endpoints ✓
- Browser fingerprint uses Baileys `Browsers.*` helpers only ✓
- Deterministic per-account browser profile (MD5 hash selection) ✓
- Platform proto patch: WEB → MACOS (required since Feb 2026) ✓
- `markOnlineOnConnect: false` ✓
- Keep-alive interval has jitter (20-30s) ✓
- `shouldIgnoreJid` skips broadcast, newsletter, status, bot JIDs ✓
- Message retry skip Phase 1 (PDO) → direct Phase 2 (receipt-with-keys) ✓
- `getMessage()` callback returns `proto.IMessage` correctly ✓
- Pre-key upload on connection open ✓
- Staggered account initialization (8-15s / 25-45s) ✓
- 120s minimum between reconnections ✓
- Max 3 reconnect attempts ✓
- Max 3 session conflicts (440 errors) ✓
- Graceful shutdown flushes all pending session saves ✓
- SSRF protection on media URL endpoint ✓
- Duplicate message detection (SHA-256 + 60s window) ✓
