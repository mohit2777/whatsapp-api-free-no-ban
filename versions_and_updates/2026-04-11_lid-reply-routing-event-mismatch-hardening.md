# LID Reply Routing and Event-Mismatch Hardening — 2026-04-11

## Why this change was needed

Investigation of failed sends and dashboard `event mismatch` warnings found two separate issues:

1. Some outbound replies could still attempt `@lid` delivery when the sender phone number had not been resolved yet.
2. The dashboard counted unsubscribed `connection` events as generic pipeline mismatches, which made normal webhook setups look like delivery problems.

These are not equivalent risks:

- `@lid` sends are a real delivery and ban-risk issue on the current Baileys version because they can produce `Waiting for message`, Signal session churn, and decryption noise.
- `connection` event mismatches are local webhook-filter outcomes only. They do not create WhatsApp traffic by themselves and do not signal automation to Meta.

## Root cause details

### 1. Unsafe unresolved-LID fallback

File: `utils/whatsappManager.js`

`resolveRecipientJid()` explicitly documented that sending to `@lid` is broken on Baileys v6, but the final fallback still returned the original `@lid` JID when no phone mapping was available.

That path was reachable from:

- AI auto-replies using the inbound `remoteJid`
- external automations replying without a safe phone target

Observed effect:

- sends fail or appear as `Waiting for message`
- recipient-side decrypt issues increase
- more CIPHERTEXT / null-message noise appears in diagnostics

### 2. Webhook payload lacked a consistently safe reply target

File: `utils/whatsappManager.js`

The README documented `replyTo` for direct messages, but the runtime payload only set `replyTo` for groups.

That encouraged external tools to reuse `from`, which can be a LID when the phone is not yet resolved.

Observed effect:

- automations could try replying to an unsafe identifier
- failures looked like generic send failures instead of a routing problem

### 3. Optional connection events polluted pipeline mismatch counters

Files: `utils/webhookDeliveryService.js`, `public/js/dashboard.js`

The dispatcher increments `dispatch_event_mismatch` whenever no webhook subscribes to an event. That included `connection`, even when a webhook intentionally subscribed only to `message` and `message.status`.

Observed effect:

- dashboard showed frequent `event mismatch` warnings
- activity log implied a pipeline problem where there was only an unsubscribed optional lifecycle event

## Fixes applied

### 1. Block unresolved `@lid` sends

- Removed the fallback that returned the original `@lid` JID.
- `resolveRecipientJid()` now throws when a definite `@lid` target cannot be converted to a phone JID.

### 2. Expose safe reply fields in webhook payloads

- Added `phone` to webhook payloads.
- Added `replyTo` for direct chats as the resolved phone number.
- Kept `replyTo` for groups as the group JID.
- Direct messages with unresolved LIDs now expose `replyTo: null` instead of an unsafe target.

### 3. Prevent AI auto-replies from sending to unresolved LIDs

- AI auto-reply now requires a resolved phone target.
- If the sender is still only identified by an unresolved LID, the AI reply is skipped and logged instead of attempting a broken send.

### 4. Make dashboard mismatch warnings accurate

- Only `message` and `message.status` dispatch misses increment the pipeline mismatch counter.
- Unsubscribed `connection` events are logged as optional/no-subscriber activity instead of warning-level pipeline mismatches.
- Dashboard label updated to `Message event mismatch`.

## Files changed

- `utils/whatsappManager.js`
- `utils/webhookDeliveryService.js`
- `public/js/dashboard.js`
- `README.md`

## Expected outcome

- fewer false-positive mismatch warnings in System Monitor
- safer webhook-driven auto-replies
- no more deliberate attempts to send directly to unresolved `@lid` JIDs
- lower risk of `Waiting for message` and related decryption churn during reply flows