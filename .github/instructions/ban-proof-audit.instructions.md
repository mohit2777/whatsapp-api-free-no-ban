---
description: "Use when writing, reviewing, or modifying WhatsApp API code — especially session management, message sending, connection handling, onWhatsApp() calls, AI auto-reply, reconnection logic, or any feature that interacts with WhatsApp servers. Enforces ban-prevention rules."
applyTo: ["utils/whatsappManager.js", "utils/aiAutoReply.js", "utils/webhookDeliveryService.js", "utils/rateLimiter.js", "index.js"]
---

# WhatsApp Ban-Proof Audit Rules

These rules prevent WhatsApp account bans. Every code change touching WhatsApp server interactions MUST comply.

## Session Management

- **Signal key persistence is mandatory.** Any code that modifies Signal keys (`keys.set()`, `creds.update`) MUST trigger a debounced database save. Signal key loss = CIPHERTEXT errors = rapid session resets = ban.
- **Never call `saveSession()` on every event.** Use `_scheduleSessionSave()` (5s debounce) to coalesce bursts. Write storms during key exchange create abnormal DB patterns.
- **Hash before writing.** `saveSession()` must SHA-256 hash the encoded blob and skip DB writes when unchanged. This prevents redundant writes from periodic saves and debounced saves racing.
- **Periodic saves are a safety net, not a replacement.** The 60s periodic timer catches anything the debounced save misses. Never remove it.
- **On restore, seed the hash map** from the restored data so the first post-connect save accurately detects changes.
- **Never restore a session with `registered=false` and no `me` field.** This creates a stale session that causes 401 errors and rapid reconnect cycles.
- **Validate ALL identity keys** before restoring: `signedIdentityKey`, `noiseKey`, `signedPreKey`, `registrationId`. Missing any = handshake failure = reconnect storm = ban.

## onWhatsApp() / Number Existence Checks

- **NEVER call `sock.onWhatsApp()` directly.** Always use `_safeOnWhatsApp()` which enforces rate limiting (8 calls/60s) and 24h caching.
- **Meta permanently bans accounts** that make excessive `onWhatsApp()` calls — they classify it as number enumeration.
- **Cache aggressively.** A verified number doesn't change in 24 hours. Always check `onWhatsAppCache` before making a server call.
- **Degrade gracefully** when rate-limited. If `_safeOnWhatsApp()` returns null, use the fallback JID format (`number@s.whatsapp.net`) rather than blocking the operation.

## Message Sending

- **Rate limit: 30 messages per 60 seconds per account.** This is enforced in `_checkSendRateLimit()`. Never bypass or increase this limit.
- **Every send method** (`sendMessage`, `sendMessageToJid`, `sendMedia`, `sendPoll`) must check the rate limiter BEFORE sending.
- **Human-like presence sequence is mandatory:** `available` → `composing` → `paused` → send → `unavailable`. Every send must follow this pattern with randomized delays.
- **Typing delay must be proportional to message length.** Use `typingDelay()` — never use a fixed delay.
- **Go unavailable after sending.** Real WhatsApp Web users don't stay online 24/7. The 2-10s delay before `unavailable` is critical.
- **Never add bulk/batch/broadcast endpoints.** Every message must be a separate API call subject to individual rate limiting.
- **Duplicate detection is mandatory.** SHA-256 hash + 60s window on `(accountId, jid, message)` triples. Never remove `isDuplicateMessage()`.

## AI Auto-Reply

- **Loop guard is mandatory.** Max 3 consecutive AI replies per contact per 5-minute window (`_checkAiReplyAllowed()`). Never increase this limit.
- **Reset counter on human messages.** When a real human message arrives, call `_resetAiReplyCounter()`. Only consecutive AI replies count toward the loop limit.
- **AI replies must have human-like delay.** 2-6s delay before generating + typing simulation before sending. Never send AI replies instantly.
- **Never enable AI auto-reply for group chats.** Group messages are high-visibility and AI loops in groups are immediate ban triggers.

## Connection & Reconnection

- **Max 3 reconnect attempts** before requiring manual intervention. Never increase `maxReconnectAttempts`.
- **Min 120s between reconnections.** Rapid reconnect cycles are the #1 ban trigger after number enumeration.
- **Max 3 session conflicts (440 errors)** before stopping. The session is likely being used on another device.
- **Stagger multi-account initialization.** 8-15s between accounts for <10 accounts, 25-45s for 10+ accounts. Never parallelize `connect()` calls.
- **Connection order should be randomized** when initializing many accounts. Don't connect in alphabetical or creation-date order.
- **Keep-alive interval must have jitter.** Use 20-30s randomized, never a fixed interval. Perfectly periodic pings are a bot fingerprint.
- **`markOnlineOnConnect: false`** — real WhatsApp Web clients don't immediately go online. Never change this.
- **Set presence to `unavailable` after connecting** with a 3-8s human delay.

## Browser & Platform Fingerprinting

- **Only use Baileys' built-in `Browsers.*` helpers.** Custom browser strings (`['Windows', 'Chrome', '120.0']`) produce fingerprints that don't match any real client → ban.
- **Browser profile must be deterministic per account** (hash-based selection from `BROWSER_PROFILES`). Changing fingerprint on reconnect = detection.
- **Platform proto patch is required.** WA rejects Platform.WEB (14) since Feb 2026. Must remap to MACOS (24). Never revert this.

## JID Handling

- **Never send to `@lid` JIDs.** LID-based sending is broken on Baileys v6.7.21 and causes "Waiting for message." Always resolve to `@s.whatsapp.net`.
- **Skip broadcast, newsletter, status, and bot JIDs** in `shouldIgnoreJid`. These generate spurious Signal sessions that cause Bad MAC errors.
- **Register LID↔phone mappings** from every available source (onWhatsApp results, history sync, message sender info) but never USE the LID for sending.

## Features That Must NEVER Be Added

These features are guaranteed ban triggers. Reject any PR or feature request for:

1. **Number validation/checking endpoint** (`/api/check-number`, `/api/exists`) — pure number enumeration
2. **Bulk/mass send** (`/api/broadcast`, `/api/bulk-send`) — spam detection
3. **Group creation/invite/member management API** — group abuse detection
4. **Auto-join invite links** — automated group infiltration
5. **Newsletter/channel posting** — unofficial newsletter API use
6. **Status/story posting** — automated story patterns
7. **Profile picture/name/about rapid changes** — profile abuse
8. **Contact scraping/export** — data harvesting
9. **Message scheduling without rate limits** — bulk automation
10. **Forwarding/chain messaging** — spam pattern detection

## Error Handling

- **Never retry failed connections immediately.** Always use exponential backoff with jitter.
- **Never bypass safety checks** (--no-verify, force flags) to fix connection issues.
- **On auth failure (401), clear session and wait** for manual QR re-scan. Never auto-retry auth failures.
- **On stream error (515), wait 60-120s** before reconnecting. Immediate retry amplifies the issue.
- **Log all session-related errors** at warn level minimum. Silent failures in session management cause cascading CIPHERTEXT errors.

## Testing Checklist for Any Change

Before merging any code that touches WhatsApp interactions:

- [ ] No raw `sock.onWhatsApp()` calls (must use `_safeOnWhatsApp()`)
- [ ] No `saveSession()` called directly in hot paths (must use `_scheduleSessionSave()`)
- [ ] All send methods check `_checkSendRateLimit()` before sending
- [ ] Presence sequence maintained (available → composing → paused → send → unavailable)
- [ ] Human-like delays use `humanDelay()`, never fixed milliseconds
- [ ] New features don't add bulk/batch/broadcast capabilities
- [ ] AI auto-reply checks `_checkAiReplyAllowed()` before sending
- [ ] Connection changes respect stagger delays and backoff timers
- [ ] Browser fingerprint uses only `Browsers.*` helpers
