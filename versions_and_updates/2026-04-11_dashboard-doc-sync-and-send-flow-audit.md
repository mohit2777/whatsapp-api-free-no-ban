# Dashboard Doc Sync and Send-Flow Audit — 2026-04-11

## Why this change was needed

The runtime send path had already been hardened against unsafe `@lid` replies, but the dashboard's embedded API docs still told users to reply with `data.fromJid` and still advertised the old `30 msg/min` limit.

That created two avoidable risks:

1. External automations could follow stale examples and bypass the safer `replyTo` contract.
2. Operators auditing high-volume behavior could get the wrong impression about the actual enforced limits.

## Audit result

End-to-end review of the send flow found the core runtime path is aligned with the ban-prevention rules:

- API endpoints gate on valid API key and `account.status === 'ready'`.
- All outbound sends route through `resolveRecipientJid()`.
- Unresolved direct `@lid` targets are blocked instead of being sent.
- Sends are serialized per account with `_enqueueSend()`.
- A minimum 3 second inter-message gap is enforced inside the send queue.
- WhatsApp send volume is capped at 20/minute and 80/hour per account.
- `onWhatsApp()` lookups are wrapped by `_safeOnWhatsApp()` with caching and request throttling.
- Reconnect behavior uses long backoff windows and hard caps on retries/conflicts.
- Message retry storage and session persistence reduce decrypt churn after reconnects and restarts.

One additional reliability issue was found during the audit and fixed immediately:

- Outbound text sends previously awaited conversation-history DB writes after `sock.sendMessage()` succeeded.
- If that DB insert failed under load, the API could return an error even though WhatsApp had already accepted the message.
- That created a duplicate-send risk because API clients may retry on the false failure.
- The conversation-history write is now non-blocking for outbound text sends; failures are logged without turning a successful send into an API error.

## Docs updated

Files:

- `public/js/dashboard.js`
- `README.md`

Changes:

- Switched dashboard reply examples from `data.fromJid` to `data.replyTo`.
- Updated dashboard webhook payload reference to the current runtime fields (`from`, `phone`, `replyTo`, `timestamp`).
- Corrected the dashboard rate-limit text from `30 msg/min` to the current enforced limits.
- Clarified in the README that `from` is the best available sender identifier, not always a resolved phone number.

## Residual operational limits

This audit improves correctness and operator guidance, but it does not create a zero-ban guarantee.

WhatsApp can still restrict accounts for reasons outside the code path itself, including:

- low-quality or spam-like message content,
- recipient complaints / blocks,
- sudden traffic jumps across many accounts from one IP,
- account reputation and age,
- repeated manual reconnects during instability.

Within the configured limits and the current hardened send path, the code now looks materially safer and should not create the earlier `@lid` reply failure pattern or misleading dashboard guidance.