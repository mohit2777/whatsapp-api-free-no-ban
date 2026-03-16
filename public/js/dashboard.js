/**
 * WAMulti Dashboard — Premium UI
 * Client-side JavaScript
 */

// ============================================================================
// State
// ============================================================================

let accounts = [];
let currentAccountId = null;
let socket = null;
let activePollingAccountId = null;
let qrGeneratedAt = null;
let qrTimerInterval = null;
let lastQr = null;

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    initializeSocket();
    initializeNavigation();
    initializeModals();
    initializeEventListeners();
    initApiDocs();
    loadAccounts();
    loadHealth();

    setInterval(loadAccounts, 30000);
    setInterval(loadHealth, 60000);
    // Auto-refresh activity log + pipeline stats every 10s when webhook tab is visible
    setInterval(() => {
        const webhooksView = document.getElementById('webhooksView');
        if (webhooksView && webhooksView.style.display !== 'none') {
            loadActivityLog();
            loadPipelineStats();
        }
    }, 10000);
});

// ============================================================================
// Socket.IO
// ============================================================================

function initializeSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Socket connected');
        updateSystemStatus(true);
        if (currentAccountId) {
            socket.emit('subscribe-account', currentAccountId);
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket disconnected');
        updateSystemStatus(false);
    });

    socket.on('account-status', (data) => {
        console.log('Account status update:', data);
        updateAccountStatus(data.accountId, data.status, data.phoneNumber);
        if (data.accountId === activePollingAccountId && data.status === 'ready') {
            showQrSuccess();
        }
        loadAccounts();
    });

    socket.on('qr-update', (data) => {
        console.log('QR update received:', data.accountId);
        if (data.accountId === activePollingAccountId) {
            displayQrCode(data.qr);
        }
    });

    socket.on('account-deleted', () => {
        loadAccounts();
    });
}

function updateSystemStatus(online) {
    const indicator = document.querySelector('.sidebar-footer .status-indicator');
    const text = document.querySelector('.system-status span');
    if (indicator) indicator.classList.toggle('online', online);
    if (text) text.textContent = online ? 'System Online' : 'Reconnecting...';
}

// ============================================================================
// Navigation
// ============================================================================

function initializeNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(link.dataset.view);
        });
    });

    document.getElementById('menuToggle')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('sidebarBackdrop')?.classList.toggle('show');
    });
}

const viewMeta = {
    'dashboard':  { title: 'Dashboard',         subtitle: 'Overview of your WhatsApp automation' },
    'accounts':   { title: 'Accounts',           subtitle: 'Manage your WhatsApp accounts' },
    'webhooks':   { title: 'Webhooks',           subtitle: 'Configure webhook integrations' },
    'system':     { title: 'System Monitor',     subtitle: 'Server health and configuration' },
    'api-docs':   { title: 'API Documentation',  subtitle: 'Integration guides and endpoints' }
};

function switchView(viewName) {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.view === viewName);
    });

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewId = viewName === 'api-docs' ? 'apiDocsView' : `${viewName}View`;
    document.getElementById(viewId)?.classList.add('active');

    const meta = viewMeta[viewName] || {};
    document.getElementById('pageTitle').textContent = meta.title || viewName;
    document.getElementById('pageSubtitle').textContent = meta.subtitle || '';

    if (viewName === 'system') { loadHealth(); renderActiveConnections(); }
    else if (viewName === 'webhooks') { populateWebhookAccountSelect(); loadWebhookStats(); loadActivityLog(); loadPipelineStats(); }
    else if (viewName === 'api-docs' && !currentEndpoint) { initApiDocs(); }

    document.getElementById('sidebar')?.classList.remove('open');
}

// ============================================================================
// Modals
// ============================================================================

function initializeModals() {
    document.getElementById('closeQrModal')?.addEventListener('click', () => closeModal('qrModal'));
    document.getElementById('closeNewAccountModal')?.addEventListener('click', () => closeModal('newAccountModal'));
    document.getElementById('closeAiConfigModal')?.addEventListener('click', () => closeModal('aiConfigModal'));

    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('show');
        });
    });
}

function openModal(modalId) {
    document.getElementById(modalId)?.classList.add('show');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('show');

    if (modalId === 'qrModal') {
        activePollingAccountId = null;
        if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
        qrGeneratedAt = null;
        lastQr = null;
        const qrContainer = document.getElementById('qrContainer');
        if (qrContainer) {
            qrContainer.innerHTML = '<div class="qr-placeholder"><div class="qr-spinner"></div><p>Initializing connection...</p></div>';
        }
    }
}

// ============================================================================
// Event Listeners
// ============================================================================

function initializeEventListeners() {
    document.getElementById('newAccountBtn')?.addEventListener('click', () => openModal('newAccountModal'));
    document.getElementById('newAccountBtn2')?.addEventListener('click', () => openModal('newAccountModal'));
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('newAccountForm')?.addEventListener('submit', createAccount);
    document.getElementById('aiConfigForm')?.addEventListener('submit', saveAiConfig);
    document.getElementById('deleteAiConfig')?.addEventListener('click', deleteAiConfig);
    document.getElementById('aiProvider')?.addEventListener('change', (e) => updateModelDropdown(e.target.value));
    document.getElementById('aiActive')?.addEventListener('change', (e) => updateToggleStatus(e.target));
    document.getElementById('webhookAccountSelect')?.addEventListener('change', loadWebhooksForAccount);
    document.getElementById('addWebhookForm')?.addEventListener('submit', submitWebhookForm);

    // Webhook "All Events" checkbox mutual exclusion
    document.querySelectorAll('input[name="webhookEvents"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
            if (e.target.value === '*' && e.target.checked) {
                document.querySelectorAll('input[name="webhookEvents"]').forEach(other => {
                    if (other.value !== '*') other.checked = false;
                });
            } else if (e.target.value !== '*' && e.target.checked) {
                const allBox = document.querySelector('input[name="webhookEvents"][value="*"]');
                if (allBox) allBox.checked = false;
            }
        });
    });

    // Search clear button
    document.getElementById('searchClearBtn')?.addEventListener('click', () => {
        const input = document.getElementById('accountSearchInput');
        if (input) { input.value = ''; filterAccounts(); input.focus(); }
        document.getElementById('searchClearBtn').style.display = 'none';
    });
    document.getElementById('accountSearchInput')?.addEventListener('input', (e) => {
        const clearBtn = document.getElementById('searchClearBtn');
        if (clearBtn) clearBtn.style.display = e.target.value ? 'flex' : 'none';
    });

    // Mobile sidebar backdrop
    document.getElementById('sidebarBackdrop')?.addEventListener('click', () => {
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarBackdrop')?.classList.remove('show');
    });
}

// ============================================================================
// API Calls
// ============================================================================

async function apiCall(url, options = {}) {
    try {
        const response = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    } catch (error) {
        showToast(error.message, 'error');
        throw error;
    }
}

async function loadAccounts() {
    try {
        const data = await apiCall('/api/accounts');
        accounts = data.accounts || [];
        renderAccountsTable();
        updateStats();
        populateWebhookAccountSelect();
    } catch (error) {
        console.error('Failed to load accounts:', error);
    }
}

async function loadHealth() {
    try {
        const data = await apiCall('/api/health');

        if (data.metrics) {
            document.getElementById('messagesSent').textContent = formatNumber(data.metrics.messagesSent || 0);
            document.getElementById('messagesReceived').textContent = formatNumber(data.metrics.messagesReceived || 0);
        }

        if (data.uptime) {
            document.getElementById('sysUptime').textContent = formatUptime(data.uptime);
        }

        if (data.memory) {
            const usedMB = Math.round(data.memory.heapUsed / 1024 / 1024);
            const totalMB = Math.round(data.memory.heapTotal / 1024 / 1024);
            document.getElementById('sysMemory').textContent = `${usedMB} MB`;
        }

        if (data.cache) {
            const hitRate = (data.cache.hitRate * 100).toFixed(1);
            document.getElementById('sysCacheHit').textContent = `${hitRate}%`;
        }

        if (data.nodeVersion) {
            document.getElementById('sysNodeVersion').textContent = data.nodeVersion;
        }

        // Update webhook queue stats if available
        if (data.webhookQueue) {
            document.getElementById('queueSize').textContent = `${data.webhookQueue.queueSize || 0} / 1000`;
            document.getElementById('queueProcessing').textContent = data.webhookQueue.isProcessing ? 'Active' : 'Idle';
            document.getElementById('queueDelivered').textContent = data.webhookQueue.delivered || 0;
            document.getElementById('queueFailedCount').textContent = data.webhookQueue.failed || 0;
        }
    } catch (error) {
        console.error('Failed to load health:', error);
    }
}

async function loadWebhookStats() {
    try {
        const data = await apiCall('/api/health');
        if (data.webhookQueue) {
            document.getElementById('webhookQueueSize').textContent = data.webhookQueue.queueSize || 0;
        }
    } catch (error) {
        console.error('Failed to load webhook stats:', error);
    }
}

async function loadActivityLog() {
    try {
        const data = await apiCall('/api/webhooks/activity-log?limit=50');
        if (!data.success) return;

        // Update queue stats from the activity log response
        const s = data.stats || {};
        const el = (id) => document.getElementById(id);
        if (el('queueSize')) el('queueSize').textContent = `${s.total || 0} / ${s.maxSize || 1000}`;
        if (el('queueProcessing')) el('queueProcessing').textContent = s.processing > 0 ? `${s.processing} active` : 'Idle';
        if (el('queueDelivered')) el('queueDelivered').textContent = s.lifetime?.sent || 0;
        if (el('queueFailedCount')) el('queueFailedCount').textContent = s.lifetime?.failed || 0;
        if (el('queueMsgHandlerCalls')) el('queueMsgHandlerCalls').textContent = s.messageHandlerCalls || 0;

        renderActivityLog(data.recentActivity || []);
    } catch (error) {
        console.error('Failed to load activity log:', error);
    }
}

async function loadPipelineStats() {
    try {
        const data = await apiCall('/api/webhooks/pipeline-stats');
        if (!data.success) return;
        renderPipelineStats(data.pipeline || {});
    } catch (error) {
        console.error('Failed to load pipeline stats:', error);
    }
}

function renderPipelineStats(p) {
    const container = document.getElementById('pipelineStats');
    if (!container) return;

    const resetTime = p.resetAt ? new Date(p.resetAt).toLocaleTimeString() : 'N/A';

    // Calculate drop-off at each stage
    const stages = [
        { label: 'Baileys events fired', value: p.upsert_events, icon: '📡', cls: '' },
        { label: 'Events type=notify', value: p.upsert_notify, icon: '🔔', cls: '', drop: p.upsert_not_notify > 0 ? `${p.upsert_not_notify} history sync skipped` : null },
        { label: 'Messages received', value: p.messages_total, icon: '📨', cls: '' },
        { label: 'Passed to handler', value: p.messages_to_handler, icon: '➡️', cls: '', drop: p.messages_from_me > 0 ? `${p.messages_from_me} fromMe skipped` : null },
        { label: 'Handler started', value: p.handler_started, icon: '⚙️', cls: '' },
        { label: 'Dispatch reached', value: p.handler_dispatch_reached, icon: '🎯', cls: 'pipeline-success' },
    ];

    const drops = [
        { label: 'No socket', value: p.handler_no_socket, icon: '🔌' },
        { label: 'Null message (decrypt fail)', value: p.handler_null_message, icon: '🔐' },
        { label: 'CIPHERTEXT errors', value: p.handler_ciphertext, icon: '💔' },
        { label: 'Stub notifications', value: p.handler_stub_notification, icon: '📋' },
        { label: 'Protocol messages', value: p.handler_protocol_msg, icon: '⏭️' },
        { label: 'Empty text', value: p.handler_empty_text, icon: '📝' },
        { label: 'Handler errors', value: p.handler_error, icon: '💥' },
    ].filter(d => d.value > 0);

    const dispatchStats = [
        { label: 'dispatch() called', value: p.dispatch_called, icon: '📤' },
        { label: 'No webhooks in DB', value: p.dispatch_no_webhooks, icon: '⚠️' },
        { label: 'Event mismatch', value: p.dispatch_event_mismatch, icon: '🔀' },
        { label: 'Successfully queued', value: p.dispatch_queued, icon: '✅' },
    ];

    let html = `<div class="pipeline-header">
        <span class="pipeline-title">Message Pipeline (since ${resetTime})</span>
        <button class="btn btn-xs btn-outline" onclick="resetPipelineStats()">Reset Counters</button>
    </div>`;

    // Flow stages
    html += '<div class="pipeline-flow">';
    for (const s of stages) {
        html += `<div class="pipeline-stage ${s.cls}">
            <span class="pipeline-icon">${s.icon}</span>
            <span class="pipeline-value">${s.value}</span>
            <span class="pipeline-label">${s.label}</span>
            ${s.drop ? `<span class="pipeline-drop">${s.drop}</span>` : ''}
        </div>`;
    }
    html += '</div>';

    // Drop-off reasons
    if (drops.length > 0) {
        html += '<div class="pipeline-drops"><div class="pipeline-drops-title">Drop-off reasons:</div>';
        for (const d of drops) {
            html += `<div class="pipeline-drop-item">
                <span class="pipeline-icon">${d.icon}</span>
                <span class="pipeline-drop-value">${d.value}</span>
                <span class="pipeline-label">${d.label}</span>
            </div>`;
        }
        html += '</div>';
    }

    // Dispatch stats
    html += '<div class="pipeline-dispatch"><div class="pipeline-drops-title">Webhook dispatch:</div>';
    for (const d of dispatchStats) {
        const highlight = d.value > 0 && d.label === 'Successfully queued' ? ' pipeline-success' : '';
        const warn = d.value > 0 && (d.label === 'No webhooks in DB' || d.label === 'Event mismatch') ? ' pipeline-warn' : '';
        html += `<div class="pipeline-drop-item${highlight}${warn}">
            <span class="pipeline-icon">${d.icon}</span>
            <span class="pipeline-drop-value">${d.value}</span>
            <span class="pipeline-label">${d.label}</span>
        </div>`;
    }
    html += '</div>';

    container.innerHTML = html;
}

async function resetPipelineStats() {
    try {
        await apiCall('/api/webhooks/pipeline-stats/reset', { method: 'POST' });
        showToast('Pipeline stats reset', 'info');
        loadPipelineStats();
    } catch (error) {
        console.error('Failed to reset pipeline stats:', error);
    }
}

function renderActivityLog(entries) {
    const container = document.getElementById('activityLog');
    if (!container) return;

    if (entries.length === 0) {
        container.innerHTML = '<p class="text-muted">No recent activity. Send a message or click Test Dispatch to see entries here.</p>';
        return;
    }

    // Show most recent first
    const reversed = [...entries].reverse();
    const html = reversed.map(e => {
        const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '--';
        if (e.type === 'message_received') {
            return `<div class="activity-entry activity-message">
                <span class="activity-time">${time}</span>
                <span class="activity-icon">📩</span>
                <span class="activity-text">Message from <strong>${e.from || '?'}</strong> (${e.pushName || '?'}) — type: ${e.messageType || 'text'}</span>
                <span class="activity-account">${(e.accountId || '').substring(0, 8)}</span>
            </div>`;
        }
        if (e.type === 'dispatch') {
            const statusClass = e.status === 'queued' ? 'activity-ok' : (e.status === 'no_webhooks' ? 'activity-warn' : 'activity-warn');
            const icon = e.status === 'queued' ? '🚀' : '⚠️';
            return `<div class="activity-entry ${statusClass}">
                <span class="activity-time">${time}</span>
                <span class="activity-icon">${icon}</span>
                <span class="activity-text">Dispatch <strong>${e.event}</strong> → ${e.queued || 0}/${e.webhookCount || 0} webhook(s) ${e.status === 'no_webhooks' ? '<em>(no active webhooks!)</em>' : e.status === 'no_match' ? '<em>(no event match)</em>' : ''}</span>
                <span class="activity-account">${(e.accountId || '').substring(0, 8)}</span>
            </div>`;
        }
        if (e.type === 'delivery') {
            const ok = e.status === 'success';
            return `<div class="activity-entry ${ok ? 'activity-ok' : 'activity-fail'}">
                <span class="activity-time">${time}</span>
                <span class="activity-icon">${ok ? '✅' : '❌'}</span>
                <span class="activity-text">${ok ? 'Delivered' : 'Failed'} → ${truncateUrl(e.url)} ${ok ? `(${e.duration}ms)` : `— ${e.error || 'unknown error'}`} ${e.attempt > 1 ? `(attempt ${e.attempt})` : ''}</span>
                <span class="activity-account">${(e.accountId || '').substring(0, 8)}</span>
            </div>`;
        }
        if (e.type === 'dispatch_error') {
            return `<div class="activity-entry activity-fail">
                <span class="activity-time">${time}</span>
                <span class="activity-icon">💥</span>
                <span class="activity-text">Dispatch error: ${e.error}</span>
                <span class="activity-account">${(e.accountId || '').substring(0, 8)}</span>
            </div>`;
        }
        if (e.type === 'pipeline_skip') {
            return `<div class="activity-entry activity-warn">
                <span class="activity-time">${time}</span>
                <span class="activity-icon">⏭️</span>
                <span class="activity-text">Pipeline skip at <strong>${e.stage}</strong>: ${e.reason || 'unknown'}${e.pushName ? ` (${e.pushName})` : ''}${e.remoteJid ? ` [${e.remoteJid.substring(0, 15)}...]` : ''}</span>
                <span class="activity-account">${(e.accountId || '').substring(0, 8)}</span>
            </div>`;
        }
        if (e.type === 'pipeline_error') {
            return `<div class="activity-entry activity-fail">
                <span class="activity-time">${time}</span>
                <span class="activity-icon">💥</span>
                <span class="activity-text">Pipeline error at <strong>${e.stage}</strong>: ${e.error || 'unknown'}</span>
                <span class="activity-account">${(e.accountId || '').substring(0, 8)}</span>
            </div>`;
        }
        return '';
    }).join('');

    container.innerHTML = html;
}

function truncateUrl(url) {
    if (!url) return '?';
    try {
        const u = new URL(url);
        const path = u.pathname.length > 30 ? u.pathname.substring(0, 27) + '...' : u.pathname;
        return u.hostname + path;
    } catch {
        return url.length > 50 ? url.substring(0, 47) + '...' : url;
    }
}

async function createAccount(e) {
    e.preventDefault();
    const name = document.getElementById('accountName').value;
    const description = document.getElementById('accountDesc').value;

    try {
        const data = await apiCall('/api/accounts', {
            method: 'POST',
            body: JSON.stringify({ name, description })
        });

        closeModal('newAccountModal');
        document.getElementById('newAccountForm').reset();
        showToast('Account created successfully', 'success');
        loadAccounts();

        currentAccountId = data.account.id;
        activePollingAccountId = data.account.id;
        socket.emit('subscribe-account', currentAccountId);
        await new Promise(resolve => setTimeout(resolve, 100));
        openModal('qrModal');
        pollQrCode(currentAccountId);
    } catch (error) {
        console.error('Failed to create account:', error);
    }
}

async function deleteAccount(accountId) {
    if (!confirm('Are you sure you want to delete this account? This cannot be undone.')) return;
    try {
        await apiCall(`/api/accounts/${accountId}`, { method: 'DELETE' });
        showToast('Account deleted', 'success');
        loadAccounts();
    } catch (error) {
        console.error('Failed to delete account:', error);
    }
}

async function reconnectAccount(accountId) {
    try {
        currentAccountId = accountId;
        activePollingAccountId = accountId;
        socket.emit('subscribe-account', accountId);
        await new Promise(resolve => setTimeout(resolve, 100));
        await apiCall(`/api/accounts/${accountId}/reconnect`, { method: 'POST' });
        showToast('Reconnection initiated', 'info');
        openModal('qrModal');
        pollQrCode(accountId);
    } catch (error) {
        console.error('Failed to reconnect:', error);
        activePollingAccountId = null;
    }
}

// ============================================================================
// QR Code Polling
// ============================================================================

async function pollQrCode(accountId) {
    const qrContainer = document.getElementById('qrContainer');
    qrContainer.innerHTML = '<div class="qr-placeholder"><div class="qr-spinner"></div><p>Initializing connection...</p></div>';

    let attempts = 0;
    const maxAttempts = 90;
    lastQr = null;
    let qrDisplayed = false;

    const poll = async () => {
        if (activePollingAccountId !== accountId) return;

        try {
            const accountData = await apiCall(`/api/accounts/${accountId}`);
            const status = accountData.account?.status || accountData.account?.runtimeStatus;

            if (status === 'ready') { showQrSuccess(); return; }

            if ((status === 'error' || status === 'disconnected') && accountData.account?.error_message) {
                qrContainer.innerHTML = `
                    <div class="qr-placeholder">
                        <i class="fas fa-exclamation-triangle" style="font-size: 32px; color: var(--warning);"></i>
                        <p style="color: var(--warning);">${escapeHtml(accountData.account.error_message)}</p>
                        <button class="btn btn-primary" onclick="reconnectAccount('${accountId}')">
                            <i class="fas fa-sync"></i> Try Again
                        </button>
                    </div>`;
                return;
            }

            const data = await apiCall(`/api/accounts/${accountId}/qr`);
            if (data.qr) {
                if (data.qr !== lastQr) {
                    lastQr = data.qr;
                    displayQrCode(data.qr);
                    qrDisplayed = true;
                }
            } else if (!qrDisplayed && status === 'initializing') {
                qrContainer.innerHTML = '<div class="qr-placeholder"><div class="qr-spinner"></div><p>Waiting for QR code...<br><small>This may take a few seconds</small></p></div>';
            }

            attempts++;
            if (attempts < maxAttempts && activePollingAccountId === accountId) {
                setTimeout(poll, attempts < 10 ? 1500 : 3000);
            } else if (activePollingAccountId === accountId) {
                qrContainer.innerHTML = `
                    <div class="qr-placeholder">
                        <i class="fas fa-clock" style="font-size: 32px; color: var(--warning);"></i>
                        <p style="color: var(--warning);">QR code timeout</p>
                        <button class="btn btn-primary" onclick="reconnectAccount('${accountId}')">
                            <i class="fas fa-sync"></i> Try Again
                        </button>
                    </div>`;
            }
        } catch (error) {
            console.error('QR poll error:', error);
            if (attempts < maxAttempts && activePollingAccountId === accountId) {
                setTimeout(poll, 3000);
            }
        }
    };

    setTimeout(poll, 500);
}

function showQrSuccess() {
    const qrContainer = document.getElementById('qrContainer');
    if (qrContainer) {
        qrContainer.innerHTML = `
            <div class="qr-placeholder">
                <i class="fas fa-check-circle" style="font-size: 48px; color: var(--success);"></i>
                <p style="color: var(--success); font-weight: 600;">Connected successfully!</p>
            </div>`;
    }
    if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
    setTimeout(() => { closeModal('qrModal'); loadAccounts(); }, 2000);
}

function displayQrCode(qrDataUrl) {
    const qrContainer = document.getElementById('qrContainer');
    qrGeneratedAt = Date.now();

    qrContainer.innerHTML = `
        <img src="${qrDataUrl}" alt="QR Code" id="qrImage">
        <div class="qr-actions">
            <button class="btn btn-sm btn-outline" onclick="shareQrCode()" title="Share / Download QR">
                <i class="fas fa-share-alt"></i> Share QR
            </button>
        </div>
        <div class="qr-timer-bar">
            <div class="qr-timer-fill" id="qrTimerFill"></div>
        </div>
        <p class="qr-timer-text" id="qrTimer">Scan within 20 seconds</p>
    `;

    if (qrTimerInterval) clearInterval(qrTimerInterval);

    qrTimerInterval = setInterval(() => {
        if (!qrGeneratedAt || activePollingAccountId === null) {
            clearInterval(qrTimerInterval);
            qrTimerInterval = null;
            return;
        }
        const elapsed = Math.floor((Date.now() - qrGeneratedAt) / 1000);
        const remaining = Math.max(0, 20 - elapsed);
        const timer = document.getElementById('qrTimer');
        const fill = document.getElementById('qrTimerFill');

        if (fill) fill.style.width = `${(remaining / 20) * 100}%`;

        if (timer) {
            if (remaining > 5) {
                timer.textContent = `Scan within ${remaining} seconds`;
                timer.style.color = 'var(--text-muted)';
            } else if (remaining > 0) {
                timer.textContent = `Hurry! ${remaining}s left`;
                timer.style.color = 'var(--warning)';
            } else {
                clearInterval(qrTimerInterval);
                qrTimerInterval = null;
                qrGeneratedAt = null;
                lastQr = null;
                const qrContainer = document.getElementById('qrContainer');
                if (qrContainer) {
                    qrContainer.innerHTML = '<div class="qr-placeholder"><div class="qr-spinner"></div><p>Refreshing QR code...</p></div>';
                }
                return;
            }
        }
    }, 1000);
}

async function shareQrCode() {
    const img = document.getElementById('qrImage');
    if (!img) return;
    try {
        const res = await fetch(img.src);
        const blob = await res.blob();
        const file = new File([blob], 'whatsapp-qr.png', { type: 'image/png' });
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: 'WhatsApp QR Code' });
        } else {
            const a = document.createElement('a');
            a.href = img.src;
            a.download = 'whatsapp-qr.png';
            a.click();
            showToast('QR code downloaded', 'success');
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
            const a = document.createElement('a');
            a.href = img.src;
            a.download = 'whatsapp-qr.png';
            a.click();
            showToast('QR code downloaded', 'success');
        }
    }
}

async function logout() {
    try {
        await apiCall('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login';
    } catch (error) {
        window.location.href = '/login';
    }
}

// ============================================================================
// AI Config
// ============================================================================

const MODEL_OPTIONS = {
    openai: [
        { value: 'gpt-4o', label: 'GPT-4o (Latest)' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast & Cheap)' },
        { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
        { value: 'gpt-4', label: 'GPT-4' },
        { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
    ],
    anthropic: [
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Latest)' },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
        { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
        { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku (Fast)' }
    ],
    gemini: [
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Latest)' },
        { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
        { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' }
    ],
    groq: [
        { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
        { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (Fast)' },
        { value: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
        { value: 'gemma2-9b-it', label: 'Gemma 2 9B' }
    ],
    openrouter: [
        { value: 'openai/gpt-4o', label: 'OpenAI GPT-4o' },
        { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
        { value: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
        { value: 'meta-llama/llama-3.3-70b', label: 'Llama 3.3 70B' },
        { value: 'mistralai/mixtral-8x7b', label: 'Mixtral 8x7B' }
    ],
    'openrouter-free': [
        { value: 'meta-llama/llama-3.3-70b:free', label: 'Llama 3.3 70B (Free)' },
        { value: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash (Free)' },
        { value: 'mistralai/mistral-small-3.1-24b-instruct:free', label: 'Mistral Small 3.1 (Free)' },
        { value: 'qwen/qwen3-32b:free', label: 'Qwen3 32B (Free)' }
    ]
};

function updateModelDropdown(provider) {
    const modelSelect = document.getElementById('aiModel');
    const currentValue = modelSelect.value;
    modelSelect.innerHTML = '<option value="">Select Model</option>';
    if (provider && MODEL_OPTIONS[provider]) {
        MODEL_OPTIONS[provider].forEach(model => {
            const option = document.createElement('option');
            option.value = model.value;
            option.textContent = model.label;
            if (model.value === currentValue) option.selected = true;
            modelSelect.appendChild(option);
        });
    }
}

function updateToggleStatus(checkbox) {
    const statusSpan = document.getElementById('toggleStatus');
    if (statusSpan) statusSpan.textContent = checkbox.checked ? 'Enabled' : 'Disabled';
}

async function openAiConfig(accountId) {
    document.getElementById('aiAccountId').value = accountId;
    try {
        const data = await apiCall(`/api/accounts/${accountId}/ai-config`);
        if (data.config) {
            const provider = data.config.provider || '';
            document.getElementById('aiProvider').value = provider;
            updateModelDropdown(provider);
            document.getElementById('aiApiKey').value = data.config.api_key || '';
            document.getElementById('aiModel').value = data.config.model || '';
            document.getElementById('aiSystemPrompt').value = data.config.system_prompt || '';
            document.getElementById('aiTemperature').value = data.config.temperature || 0.7;
            const isActive = data.config.is_active !== false;
            document.getElementById('aiActive').checked = isActive;
            updateToggleStatus({ checked: isActive });
            document.getElementById('aiMemoryEnabled').checked = data.config.memory_enabled !== false;
            document.getElementById('aiMemoryLimit').value = data.config.memory_limit || 10;
        } else {
            document.getElementById('aiConfigForm').reset();
            document.getElementById('aiAccountId').value = accountId;
            document.getElementById('aiActive').checked = true;
            updateToggleStatus({ checked: true });
            document.getElementById('aiMemoryEnabled').checked = true;
            document.getElementById('aiMemoryLimit').value = 10;
            updateModelDropdown('');
        }
        openModal('aiConfigModal');
    } catch (error) {
        console.error('Failed to load AI config:', error);
    }
}

async function saveAiConfig(e) {
    e.preventDefault();
    const accountId = document.getElementById('aiAccountId').value;
    const config = {
        provider: document.getElementById('aiProvider').value,
        api_key: document.getElementById('aiApiKey').value,
        model: document.getElementById('aiModel').value,
        system_prompt: document.getElementById('aiSystemPrompt').value,
        temperature: parseFloat(document.getElementById('aiTemperature').value) || 0.7,
        is_active: document.getElementById('aiActive').checked,
        memory_enabled: document.getElementById('aiMemoryEnabled').checked,
        memory_limit: parseInt(document.getElementById('aiMemoryLimit').value) || 10
    };

    try {
        await apiCall(`/api/accounts/${accountId}/ai-config`, {
            method: 'POST',
            body: JSON.stringify(config)
        });
        closeModal('aiConfigModal');
        showToast('AI configuration saved', 'success');
        loadAccounts();
    } catch (error) {
        console.error('Failed to save AI config:', error);
    }
}

async function deleteAiConfig() {
    const accountId = document.getElementById('aiAccountId').value;
    if (!confirm('Delete AI configuration?')) return;
    try {
        await apiCall(`/api/accounts/${accountId}/ai-config`, { method: 'DELETE' });
        closeModal('aiConfigModal');
        showToast('AI configuration deleted', 'success');
        loadAccounts();
    } catch (error) {
        console.error('Failed to delete AI config:', error);
    }
}

// ============================================================================
// Webhooks
// ============================================================================

function populateWebhookAccountSelect() {
    const select = document.getElementById('webhookAccountSelect');
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">Select Account</option>';
    accounts.forEach(account => {
        const option = document.createElement('option');
        option.value = account.id;
        const shortId = account.id.substring(0, 8);
        option.textContent = `${account.name} (${account.phone_number || 'Not connected'}) [${shortId}…]`;
        if (account.id === currentValue) option.selected = true;
        select.appendChild(option);
    });
}

async function loadWebhooksForAccount() {
    const accountId = document.getElementById('webhookAccountSelect').value;
    const container = document.getElementById('webhooksList');

    if (!accountId) {
        container.innerHTML = '<div class="empty-state-card"><i class="fas fa-link"></i><p>Select an account to manage its webhooks</p></div>';
        document.getElementById('addWebhookCard').style.display = 'none';
        return;
    }

    try {
        const data = await apiCall(`/api/accounts/${accountId}/webhooks`);
        renderWebhooks(data.webhooks || [], accountId);
    } catch (error) {
        console.error('Failed to load webhooks:', error);
    }
}

function renderWebhooks(webhooks, accountId) {
    const container = document.getElementById('webhooksList');

    // Update stats
    document.getElementById('webhookTotal').textContent = webhooks.length;
    document.getElementById('webhookActive').textContent = webhooks.filter(w => w.is_active).length;
    document.getElementById('webhookFailed').textContent = webhooks.filter(w => !w.is_active).length;
    const countBadge = document.getElementById('webhookCountBadge');
    if (countBadge) countBadge.textContent = `${webhooks.length} configured`;

    if (webhooks.length === 0) {
        container.innerHTML = `
            <div class="empty-state-card">
                <i class="fas fa-link"></i>
                <p>No webhooks configured for this account</p>
                <button class="btn btn-primary" style="margin-top: 12px;" onclick="showAddWebhookForm('${accountId}')">
                    <i class="fas fa-plus"></i> Add Webhook
                </button>
            </div>`;
        return;
    }

    let html = `
        <div style="margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-primary" onclick="showAddWebhookForm('${accountId}')">
                <i class="fas fa-plus"></i> Add Webhook
            </button>
            <button class="btn btn-info" onclick="testDispatch('${accountId}')">
                <i class="fas fa-paper-plane"></i> Test Full Dispatch
            </button>
        </div>
        <table class="table">
            <thead>
                <tr>
                    <th>URL</th>
                    <th>Events</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

    webhooks.forEach(webhook => {
        const urlShort = webhook.url.length > 45 ? webhook.url.substring(0, 45) + '...' : webhook.url;
        const events = Array.isArray(webhook.events) ? webhook.events : ['message'];
        const eventBadges = events.map(e => {
            const icons = { 'message': 'fa-envelope', 'message.status': 'fa-check-double', 'connection': 'fa-plug', '*': 'fa-asterisk', 'poll': 'fa-poll-h', 'poll_vote': 'fa-vote-yea' };
            return `<span class="event-badge"><i class="fas ${icons[e] || 'fa-tag'}"></i> ${e}</span>`;
        }).join(' ');

        html += `
            <tr>
                <td>
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                        <code style="font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-secondary); word-break: break-all;" title="${escapeHtml(webhook.url)}">
                            ${escapeHtml(urlShort)}
                        </code>
                        <code class="webhook-id-badge" onclick="copyToClipboard('${escapeHtml(webhook.id)}')" title="Click to copy webhook ID">ID: ${webhook.id.substring(0, 8)}…</code>
                    </div>
                </td>
                <td>
                    <div class="event-badges-wrap">${eventBadges}</div>
                </td>
                <td>
                    <label class="toggle-switch" title="Toggle active/inactive">
                        <input type="checkbox" ${webhook.is_active ? 'checked' : ''} onchange="toggleWebhook('${webhook.id}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </td>
                <td class="action-buttons">
                    <button class="btn btn-sm btn-info" onclick="testWebhook('${webhook.id}')" title="Test Delivery">
                        <i class="fas fa-bolt"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteWebhook('${webhook.id}')" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>`;
    });

    html += `</tbody></table>`;

    container.innerHTML = html;
}

function showAddWebhookForm(accountId) {
    document.getElementById('webhookFormAccountId').value = accountId;
    document.getElementById('addWebhookCard').style.display = 'block';
    document.getElementById('webhookUrl').focus();
}

function generateSecret() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'whsec_';
    for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById('webhookSecret').value = result;
}

async function submitWebhookForm(e) {
    e.preventDefault();
    const accountId = document.getElementById('webhookFormAccountId').value;
    const url = document.getElementById('webhookUrl').value;
    const secret = document.getElementById('webhookSecret').value;
    const events = Array.from(document.querySelectorAll('input[name="webhookEvents"]:checked')).map(cb => cb.value);

    if (!url || events.length === 0) {
        showToast('Please fill URL and select at least one event', 'error');
        return;
    }

    try {
        await apiCall(`/api/accounts/${accountId}/webhooks`, {
            method: 'POST',
            body: JSON.stringify({ url, secret, events })
        });
        showToast('Webhook added', 'success');
        document.getElementById('addWebhookForm').reset();
        document.getElementById('addWebhookCard').style.display = 'none';
        loadWebhooksForAccount();
    } catch (error) {
        console.error('Failed to add webhook:', error);
    }
}

async function addWebhook(accountId) {
    showAddWebhookForm(accountId);
}

async function testWebhook(webhookId) {
    try {
        const data = await apiCall(`/api/webhooks/${webhookId}/test`, { method: 'POST' });
        if (data.success) {
            let msg = 'Webhook test successful!';
            if (data.debug) {
                const evts = (data.debug.normalizedEvents || []).join(', ');
                msg += ` Events: [${evts}]`;
            }
            showToast(msg, 'success');
        } else {
            showToast(`Webhook test failed: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Failed to test webhook:', error);
    }
}

async function toggleWebhook(webhookId, isActive) {
    try {
        await apiCall(`/api/webhooks/${webhookId}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: isActive })
        });
        showToast(`Webhook ${isActive ? 'activated' : 'deactivated'}`, 'success');
    } catch (error) {
        console.error('Failed to toggle webhook:', error);
        loadWebhooksForAccount(); // Revert UI on failure
    }
}

async function testDispatch(accountId) {
    try {
        showToast('Sending test dispatch through full pipeline...', 'info');
        const data = await apiCall(`/api/accounts/${accountId}/webhooks/test-dispatch`, { method: 'POST' });
        if (data.success) {
            const matched = (data.diagnostics || []).filter(d => d.matchesMessage).length;
            const total = data.totalWebhooks || 0;
            let msg = `Dispatched to ${matched}/${total} webhook(s).`;
            if (matched === 0 && total > 0) {
                msg += ' None subscribed to "message" event — check event config!';
                showToast(msg, 'error');
            } else if (matched > 0) {
                msg += ' Check your endpoint for delivery.';
                showToast(msg, 'success');
            } else {
                showToast('No webhooks configured for this account.', 'error');
            }
            // Log diagnostics to console for debugging
            console.log('[Webhook Dispatch Diagnostics]', data.diagnostics);
        }
    } catch (error) {
        console.error('Failed to test dispatch:', error);
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard', 'success');
    }).catch(() => showToast('Failed to copy', 'error'));
}

async function deleteWebhook(webhookId) {
    if (!confirm('Delete this webhook?')) return;
    try {
        await apiCall(`/api/webhooks/${webhookId}`, { method: 'DELETE' });
        showToast('Webhook deleted', 'success');
        loadWebhooksForAccount();
    } catch (error) {
        console.error('Failed to delete webhook:', error);
    }
}

// ============================================================================
// Rendering
// ============================================================================

function renderProfileAvatar(account, size = 36) {
    if (account.profilePicUrl) {
        return `<img src="${escapeHtml(account.profilePicUrl)}" alt="" class="profile-avatar" style="width:${size}px;height:${size}px;" onerror="this.outerHTML='<div class=\\'profile-avatar-fallback\\' style=\\'width:${size}px;height:${size}px;font-size:${Math.round(size*0.4)}px\\'><i class=\\'fas fa-user\\'></i></div>'">`;
    }
    return `<div class="profile-avatar-fallback" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.4)}px"><i class="fas fa-user"></i></div>`;
}

function renderAccountsTable() {
    const tbody = document.getElementById('accountsTable');
    const tbodyFull = document.getElementById('accountsTableFull');

    if (accounts.length === 0) {
        const emptyRow = `<tr><td colspan="7" class="empty-state">
            <div class="empty-icon"><i class="fas fa-users"></i></div>
            <p>No accounts yet. Create one to get started!</p>
        </td></tr>`;
        if (tbody) tbody.innerHTML = emptyRow;
        if (tbodyFull) tbodyFull.innerHTML = emptyRow;
        document.getElementById('accountCountBadge').textContent = '0 accounts';
        return;
    }

    document.getElementById('accountCountBadge').textContent = `${accounts.length} account${accounts.length !== 1 ? 's' : ''}`;

    // Dashboard table
    if (tbody) {
        tbody.innerHTML = accounts.map(account => {
            const shortId = account.id.substring(0, 8);
            const avatar = renderProfileAvatar(account, 36);
            const displayName = account.pushName ? `${escapeHtml(account.name)} <span class="push-name-label">${escapeHtml(account.pushName)}</span>` : escapeHtml(account.name);
            return `
            <tr>
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        ${avatar}
                        <strong>${displayName}</strong>
                    </div>
                </td>
                <td>
                    <code class="account-id-badge" onclick="copyToClipboard('${escapeHtml(account.id)}')" title="Click to copy full ID: ${escapeHtml(account.id)}">${shortId}…</code>
                </td>
                <td><span style="font-family: var(--font-mono, monospace); font-size: 13px; color: var(--text-secondary);">${account.phone_number || '-'}</span></td>
                <td>${renderStatusBadge(account.runtimeStatus || account.status)}</td>
                <td class="action-buttons">
                    ${renderAccountActions(account)}
                </td>
            </tr>`;
        }).join('');
    }

    // Full accounts table
    if (tbodyFull) {
        tbodyFull.innerHTML = accounts.map(account => {
            const shortId = account.id.substring(0, 8);
            const avatar = renderProfileAvatar(account, 32);
            const displayName = account.pushName ? `${escapeHtml(account.name)} <span class="push-name-label">${escapeHtml(account.pushName)}</span>` : escapeHtml(account.name);
            return `
            <tr data-status="${account.runtimeStatus || account.status}">
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        ${avatar}
                        <strong>${displayName}</strong>
                    </div>
                </td>
                <td>
                    <code class="account-id-badge" onclick="copyToClipboard('${escapeHtml(account.id)}')" title="Click to copy full ID: ${escapeHtml(account.id)}">${shortId}…</code>
                </td>
                <td><span style="font-family: var(--font-mono, monospace); font-size: 13px; color: var(--text-secondary);">${account.phone_number || '-'}</span></td>
                <td>${renderStatusBadge(account.runtimeStatus || account.status)}</td>
                <td>${renderApiKey(account.api_key)}</td>
                <td><span style="font-size: 13px; color: var(--text-secondary);">${formatDate(account.created_at)}</span></td>
                <td class="action-buttons">
                    ${renderAccountActions(account, true)}
                </td>
            </tr>`;
        }).join('');
    }
}

function renderApiKey(apiKey) {
    if (!apiKey) return '<span style="color: var(--text-muted);">-</span>';
    const safeKey = escapeHtml(apiKey);
    return `
        <div class="api-key-container">
            <span class="api-key-full" onclick="toggleApiKeyExpand(this)" title="Click to expand">${safeKey}</span>
            <button class="btn-copy" onclick="copyApiKey(this)" data-key="${safeKey}" title="Copy">
                <i class="fas fa-copy"></i>
            </button>
        </div>
    `;
}

function toggleApiKeyExpand(element) {
    element.classList.toggle('expanded');
}

function copyApiKey(btn) {
    const apiKey = btn.getAttribute('data-key');
    navigator.clipboard.writeText(apiKey).then(() => {
        showToast('API key copied to clipboard', 'success');
    }).catch(() => showToast('Failed to copy', 'error'));
}

function renderStatusBadge(status) {
    const labels = {
        'ready': 'Connected',
        'disconnected': 'Disconnected',
        'qr_ready': 'Scan QR',
        'initializing': 'Connecting...',
        'reconnecting': 'Reconnecting...',
        'error': 'Error',
        'auth_failed': 'Auth Failed'
    };
    return `<span class="status-badge ${status}">${labels[status] || status}</span>`;
}

function renderAccountActions(account, showAll = false) {
    const status = account.runtimeStatus || account.status;
    let actions = '';

    if (status === 'qr_ready' || status === 'disconnected' || status === 'initializing') {
        actions += `<button class="btn btn-sm btn-primary" onclick="reconnectAccount('${account.id}')" title="Connect">
            <i class="fas fa-qrcode"></i>
        </button>`;
    }

    if (status === 'ready') {
        actions += `<button class="btn btn-sm btn-info" onclick="reconnectAccount('${account.id}')" title="Reconnect">
            <i class="fas fa-sync"></i>
        </button>`;
    }

    actions += `<button class="btn btn-sm btn-purple" onclick="openAiConfig('${account.id}')" title="AI Config">
        <i class="fas fa-robot"></i>
    </button>`;

    actions += `<button class="btn btn-sm btn-danger" onclick="deleteAccount('${account.id}')" title="Delete">
        <i class="fas fa-trash"></i>
    </button>`;

    return actions;
}

function renderActiveConnections() {
    const container = document.getElementById('activeConnectionsList');
    if (!container) return;

    if (accounts.length === 0) {
        container.innerHTML = '<div class="empty-state-card compact"><i class="fas fa-plug"></i><p>No accounts configured</p></div>';
        return;
    }

    container.innerHTML = accounts.map(account => {
        const status = account.runtimeStatus || account.status;
        const dotColor = status === 'ready' ? 'green' : (status === 'initializing' ? 'yellow' : 'red');
        const statusLabel = status === 'ready' ? 'Connected' : (status === 'initializing' ? 'Reconnecting' : 'Disconnected');
        const avatar = renderProfileAvatar(account, 28);

        return `
            <div class="connection-item">
                <div class="connection-left">
                    <div class="connection-dot ${dotColor}"></div>
                    ${avatar}
                    <div>
                        <div class="connection-name">${escapeHtml(account.name)}</div>
                        <div class="connection-status">${statusLabel}${account.pushName ? ' · ' + escapeHtml(account.pushName) : ''}</div>
                    </div>
                </div>
                <div class="connection-meta">
                    ${account.phone_number || '-'}
                </div>
            </div>
        `;
    }).join('');
}

function filterAccounts() {
    const tbodyFull = document.getElementById('accountsTableFull');
    if (!tbodyFull) return;

    const q = (document.getElementById('accountSearchInput')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('accountStatusFilter')?.value || '';
    const rows = tbodyFull.querySelectorAll('tr');
    let visible = 0;
    let total = rows.length;

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const matchesText = !q || text.includes(q);
        const rowStatus = row.getAttribute('data-status') || '';
        const matchesStatus = !statusFilter || rowStatus === statusFilter;
        const show = matchesText && matchesStatus;
        row.style.display = show ? '' : 'none';
        if (show) visible++;
    });

    // Update clear button
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';

    // Update result count
    const footer = document.getElementById('accountTableFooter');
    const countEl = document.getElementById('accountResultCount');
    const badge = document.getElementById('accountFilterBadge');
    if (q || statusFilter) {
        if (footer) footer.style.display = 'flex';
        if (countEl) countEl.textContent = `Showing ${visible} of ${total} account${total !== 1 ? 's' : ''}`;
        if (badge) {
            badge.textContent = `${visible} match${visible !== 1 ? 'es' : ''}`;
            badge.className = 'card-badge' + (visible === 0 ? '' : ' green');
        }
    } else {
        if (footer) footer.style.display = 'none';
        if (badge) { badge.textContent = 'All'; badge.className = 'card-badge'; }
    }

    // Show no-results message
    if (visible === 0 && total > 0 && (q || statusFilter)) {
        const existing = tbodyFull.querySelector('.no-results-row');
        if (!existing) {
            const noRow = document.createElement('tr');
            noRow.className = 'no-results-row';
            noRow.innerHTML = '<td colspan="7" class="empty-state"><div class="empty-icon"><i class="fas fa-search"></i></div><p>No accounts match your search</p></td>';
            tbodyFull.appendChild(noRow);
        }
    } else {
        const existing = tbodyFull.querySelector('.no-results-row');
        if (existing) existing.remove();
    }
}

function updateStats() {
    document.getElementById('totalAccounts').textContent = accounts.length;
    const active = accounts.filter(a => (a.runtimeStatus || a.status) === 'ready').length;
    document.getElementById('activeAccounts').textContent = active;
}

function updateAccountStatus(accountId, status, phoneNumber) {
    const account = accounts.find(a => a.id === accountId);
    if (account) {
        account.runtimeStatus = status;
        if (phoneNumber) account.phone_number = phoneNumber;
        renderAccountsTable();
        updateStats();
        renderActiveConnections();
    }
}

// ============================================================================
// API Docs — Full Endpoint Registry & Dynamic Renderer
// ============================================================================

const API_ENDPOINTS = {
    // ─── Authentication ─────────────────────────────────────────────────
    'auth-login': {
        group: 'auth', method: 'POST', path: '/api/auth/login',
        desc: 'Authenticate with your admin credentials. Returns a session cookie for dashboard access.',
        auth: 'None (public)',
        body: { username: 'admin', password: 'your_password' },
        response: { success: true, message: 'Login successful' },
        errors: [
            { code: 401, body: { success: false, error: 'Invalid credentials' } },
            { code: 429, body: { success: false, error: 'Too many attempts. Try again later.' } }
        ],
        curl: `curl -X POST https://YOUR_DOMAIN/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"username": "admin", "password": "your_password"}'`
    },
    'auth-logout': {
        group: 'auth', method: 'POST', path: '/api/auth/logout',
        desc: 'End your authenticated session.',
        auth: 'Session cookie',
        response: { success: true, message: 'Logged out' },
    },
    'auth-user': {
        group: 'auth', method: 'GET', path: '/api/auth/user',
        desc: 'Get the currently authenticated user info.',
        auth: 'Session cookie',
        response: { success: true, user: { username: 'admin' } },
    },

    // ─── Accounts ────────────────────────────────────────────────────────
    'get-accounts': {
        group: 'accounts', method: 'GET', path: '/api/accounts',
        desc: 'List all WhatsApp accounts with their current status, phone number, and configuration.',
        auth: 'Session cookie (dashboard)',
        response: { success: true, accounts: [{ id: 'uuid', name: 'My Account', status: 'ready', phone_number: '919876543210', api_key: 'wk_...', created_at: '2024-01-15T10:00:00Z' }] },
    },
    'get-account': {
        group: 'accounts', method: 'GET', path: '/api/accounts/:id',
        desc: 'Get details for a single account including runtime status.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, account: { id: 'uuid', name: 'My Account', status: 'ready', runtimeStatus: 'ready', phone_number: '919876543210', api_key: 'wk_...', pushName: 'John' } },
        errors: [{ code: 404, body: { success: false, error: 'Account not found' } }],
    },
    'create-account': {
        group: 'accounts', method: 'POST', path: '/api/accounts',
        desc: 'Create a new WhatsApp account. A unique API key is auto-generated. You\'ll need to scan a QR code to connect.',
        auth: 'Session cookie',
        body: { name: 'My Business', description: 'Main business line' },
        response: { success: true, account: { id: 'new-uuid', name: 'My Business', api_key: 'wk_abc123...' } },
    },
    'delete-account': {
        group: 'accounts', method: 'DELETE', path: '/api/accounts/:id',
        desc: 'Permanently delete an account and disconnect the WhatsApp session.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, message: 'Account deleted' },
    },
    'reconnect-account': {
        group: 'accounts', method: 'POST', path: '/api/accounts/:id/reconnect',
        desc: 'Reconnect a disconnected account. Starts a new session and generates a fresh QR code.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, message: 'Reconnection initiated' },
    },
    'get-qr': {
        group: 'accounts', method: 'GET', path: '/api/accounts/:id/qr',
        desc: 'Get the current QR code for account pairing. Returns a base64-encoded data URL image.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, qr: 'data:image/png;base64,...', status: 'qr_ready' },
        errors: [{ code: 404, body: { success: false, error: 'No QR available yet' } }],
    },
    'regenerate-key': {
        group: 'accounts', method: 'POST', path: '/api/accounts/:id/regenerate-api-key',
        desc: 'Generate a new API key for the account. The old key is immediately invalidated.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, api_key: 'wk_new_key_here...' },
    },

    // ─── Messages ────────────────────────────────────────────────────────
    'send-text': {
        group: 'messages', method: 'POST', path: '/api/send',
        desc: 'Send a text message. The "to" field accepts a phone number (auto-formatted) or a JID from a webhook (e.g. 919876543210@s.whatsapp.net).',
        auth: 'API Key (in body)',
        body: { api_key: 'YOUR_API_KEY', to: '919876543210', message: 'Hello from WAMulti API!' },
        bodyFields: [
            { name: 'api_key', type: 'string', required: true, desc: 'Your account API key' },
            { name: 'to', type: 'string', required: true, desc: 'Phone number or JID (from webhook fromJid)' },
            { name: 'message', type: 'string', required: true, desc: 'Message text' },
        ],
        response: { success: true, messageId: '3EB0F4A2B3C4D5E6F7', timestamp: 1706889600000 },
        errors: [
            { code: 401, body: { success: false, error: 'Invalid API key' } },
            { code: 400, body: { success: false, error: 'Account not connected' } },
            { code: 429, body: { success: false, error: 'Rate limit exceeded (30 msg/min)' } },
        ],
        curl: `curl -X POST https://YOUR_DOMAIN/api/send \\
  -H "Content-Type: application/json" \\
  -d '{
    "api_key": "YOUR_API_KEY",
    "to": "919876543210",
    "message": "Hello from WAMulti!"
  }'`,
        tips: [
            'Use the <code>fromJid</code> field from incoming webhook data to reply to messages',
            'Rate limited to 30 messages per 60 seconds per account',
            'Phone numbers are auto-formatted — no need to add country code prefix or @s.whatsapp.net',
        ],
    },
    'send-media': {
        group: 'messages', method: 'POST', path: '/api/send-media',
        desc: 'Send media using either multipart file upload or direct base64 JSON. Supports image, video, audio, and document types.',
        auth: 'API Key (form-data or JSON body)',
        note: 'Provide one of: multipart field media OR JSON field mediaBase64.',
        bodyFields: [
            { name: 'api_key', type: 'string', required: true, desc: 'Your account API key' },
            { name: 'to', type: 'string', required: true, desc: 'Phone number or JID' },
            { name: 'media', type: 'file', required: false, desc: 'Multipart file to send (use this OR mediaBase64)' },
            { name: 'mediaBase64', type: 'string', required: false, desc: 'Base64 media (data URL or raw base64; use this OR media)' },
            { name: 'mediaType', type: 'string', required: false, desc: 'image | video | audio | document (default: document)' },
            { name: 'caption', type: 'string', required: false, desc: 'Caption for the media' },
            { name: 'mimetype', type: 'string', required: false, desc: 'Optional MIME override (auto-detected from data URL when present)' },
            { name: 'filename', type: 'string', required: false, desc: 'Optional file name (useful for document messages)' },
        ],
        body: {
            api_key: 'YOUR_API_KEY',
            to: '919876543210',
            mediaType: 'image',
            caption: 'Sent from HTTP node',
            mediaBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD...'
        },
        response: { success: true, messageId: '3EB0F4A2B3C4D5E6F7', timestamp: 1706889600000 },
        curl: `curl -X POST https://YOUR_DOMAIN/api/send-media \\
  -H "Content-Type: application/json" \\
  -d '{
    "api_key": "YOUR_API_KEY",
    "to": "919876543210",
    "mediaType": "image",
    "caption": "Sent via JSON base64",
    "mediaBase64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD..."
  }'

# OR multipart upload
curl -X POST https://YOUR_DOMAIN/api/send-media \\
  -F "api_key=YOUR_API_KEY" \\
  -F "to=919876543210" \\
  -F "mediaType=image" \\
  -F "caption=Check this out!" \\
  -F "media=@/path/to/photo.jpg"`,
        n8n: `{
  "api_key": "YOUR_API_KEY",
  "to": "{{ $json.data.fromJid }}",
  "mediaType": "document",
  "caption": "Your file",
  "filename": "report.pdf",
  "mimetype": "application/pdf",
  "mediaBase64": "{{ $json.base64Data }}"
}`,
        tips: [
            'For n8n HTTP Request node, set Content-Type to application/json and send mediaBase64 directly',
            'mediaBase64 accepts both data URL format and raw base64 payload',
            'Caption is supported for image, video, and document (ignored for audio)'
        ],
    },
    'send-media-url': {
        group: 'messages', method: 'POST', path: '/api/send-media-url',
        desc: 'Send media via a public URL or Base64-encoded data. Ideal for n8n / Make / automation platforms.',
        auth: 'API Key (in body)',
        bodyFields: [
            { name: 'api_key', type: 'string', required: true, desc: 'Your account API key' },
            { name: 'to', type: 'string', required: true, desc: 'Phone number or JID' },
            { name: 'mediaType', type: 'string', required: true, desc: 'image | video | audio | document' },
            { name: 'mediaUrl', type: 'string', required: false, desc: 'Public URL of the media file (use this OR mediaBase64)' },
            { name: 'mediaBase64', type: 'string', required: false, desc: 'Base64 media data (use this OR mediaUrl)' },
            { name: 'base64', type: 'string', required: false, desc: 'Alias for mediaBase64 (backward compatibility)' },
            { name: 'mimetype', type: 'string', required: false, desc: 'Optional MIME override' },
            { name: 'filename', type: 'string', required: false, desc: 'Filename (for documents)' },
            { name: 'caption', type: 'string', required: false, desc: 'Caption for the media' },
        ],
        body: { api_key: 'YOUR_API_KEY', to: '919876543210', mediaType: 'image', mediaUrl: 'https://example.com/image.jpg', caption: 'Here is your image!' },
        response: { success: true, messageId: '3EB0F4A2B3C4D5E6F7', timestamp: 1706889600000 },
        curl: `curl -X POST https://YOUR_DOMAIN/api/send-media-url \\
  -H "Content-Type: application/json" \\
  -d '{
    "api_key": "YOUR_API_KEY",
    "to": "919876543210",
    "mediaType": "image",
    "mediaUrl": "https://example.com/photo.jpg",
    "caption": "Check this out!"
  }'`,
        n8n: `// n8n: Send binary data (e.g. from a previous node)
{
  "api_key": "YOUR_API_KEY",
  "to": "{{ $json.data.fromJid }}",
  "mediaType": "document",
  "mediaBase64": "{{ $binary.data.data }}",
  "mimetype": "{{ $binary.data.mimeType }}",
  "filename": "{{ $binary.data.fileName }}",
  "caption": "Your document"
}`,
    },
    'send-poll': {
        group: 'messages', method: 'POST', path: '/api/send-poll',
        desc: 'Send an interactive poll. Voters can select one or multiple options depending on selectableCount.',
        auth: 'API Key (in body)',
        bodyFields: [
            { name: 'api_key', type: 'string', required: true, desc: 'Your account API key' },
            { name: 'to', type: 'string', required: true, desc: 'Phone number or JID' },
            { name: 'name', type: 'string', required: true, desc: 'Poll question / title' },
            { name: 'options', type: 'string[]', required: true, desc: 'Array of poll options (min 2, max 12)' },
            { name: 'selectableCount', type: 'number', required: false, desc: '0 = unlimited selections, 1 = single choice (default: 0)' },
        ],
        body: { api_key: 'YOUR_API_KEY', to: '919876543210', name: 'What is your favorite color?', options: ['Red', 'Blue', 'Green', 'Yellow'], selectableCount: 1 },
        response: { success: true, messageId: '3EB0F4A2B3C4D5E6F7', timestamp: 1706889600000 },
        curl: `curl -X POST https://YOUR_DOMAIN/api/send-poll \\
  -H "Content-Type: application/json" \\
  -d '{
    "api_key": "YOUR_API_KEY",
    "to": "919876543210",
    "name": "What is your favorite color?",
    "options": ["Red", "Blue", "Green", "Yellow"],
    "selectableCount": 1
  }'`,
    },

    // ─── Webhooks ────────────────────────────────────────────────────────
    'get-webhooks': {
        group: 'webhooks', method: 'GET', path: '/api/accounts/:id/webhooks',
        desc: 'List all webhooks configured for an account.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, webhooks: [{ id: 'wh-uuid', url: 'https://n8n.example.com/webhook/abc', events: ['message'], is_active: true, secret: null }] },
    },
    'create-webhook': {
        group: 'webhooks', method: 'POST', path: '/api/accounts/:id/webhooks',
        desc: 'Create a new webhook endpoint for an account. Events specify which types of messages trigger delivery.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        bodyFields: [
            { name: 'url', type: 'string', required: true, desc: 'HTTPS URL to receive POST requests' },
            { name: 'events', type: 'string[]', required: false, desc: 'Event types: message, message.status, connection, poll, poll_vote, * (default: ["message"])' },
            { name: 'secret', type: 'string', required: false, desc: 'HMAC secret for signature verification' },
        ],
        body: { url: 'https://n8n.example.com/webhook/abc', events: ['message', 'connection'], secret: 'whsec_your_secret' },
        response: { success: true, webhook: { id: 'wh-uuid', url: 'https://n8n.example.com/webhook/abc', events: ['message', 'connection'], is_active: true } },
    },
    'update-webhook': {
        group: 'webhooks', method: 'PUT', path: '/api/webhooks/:id',
        desc: 'Update a webhook\'s active status, URL, events, or secret.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Webhook UUID' }],
        body: { is_active: false },
        response: { success: true, webhook: { id: 'wh-uuid', is_active: false } },
    },
    'delete-webhook': {
        group: 'webhooks', method: 'DELETE', path: '/api/webhooks/:id',
        desc: 'Permanently delete a webhook.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Webhook UUID' }],
        response: { success: true, message: 'Webhook deleted' },
    },
    'test-webhook': {
        group: 'webhooks', method: 'POST', path: '/api/webhooks/:id/test',
        desc: 'Send a test payload to a specific webhook to verify delivery.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Webhook UUID' }],
        response: { success: true, statusCode: 200, duration: 142, message: 'Test delivered successfully' },
    },
    'test-dispatch': {
        group: 'webhooks', method: 'POST', path: '/api/accounts/:id/webhooks/test-dispatch',
        desc: 'Simulate a full message dispatch through the pipeline to all matching webhooks for the account.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, totalWebhooks: 2, diagnostics: [{ webhookId: 'wh-1', matchesMessage: true, queued: true }] },
    },
    'webhook-payload': {
        group: 'webhooks', method: 'INFO', path: 'Webhook Payload Reference',
        desc: 'This is the JSON payload your webhook URL receives when a message arrives. Use these fields to build automations.',
        isReference: true,
        referencePayload: `{
  "event": "message",
  "timestamp": "2026-02-10T12:00:00.000Z",
  "account_id": "uuid-here",
  "data": {
    "messageId": "ABC123",
    "from": "918005780278",
    "fromJid": "918005780278@s.whatsapp.net",
    "isLidSender": false,
    "message": "Hello!",
    "messageType": "text",
    "isGroup": false,
    "pushName": "John Doe"
  }
}`,
        payloadFields: [
            { name: 'event', desc: 'Event type: message, message.status, connection, poll, poll_vote' },
            { name: 'timestamp', desc: 'ISO 8601 timestamp of when the event occurred' },
            { name: 'account_id', desc: 'Your WAMulti account UUID' },
            { name: 'data.messageId', desc: 'Unique message identifier' },
            { name: 'data.from', desc: 'Sender phone number (without @s.whatsapp.net)' },
            { name: 'data.fromJid', desc: 'Full JID — use this in the "to" field when replying' },
            { name: 'data.message', desc: 'The message text content' },
            { name: 'data.messageType', desc: 'Type: text, image, video, audio, document, sticker, poll, etc.' },
            { name: 'data.isGroup', desc: 'true if message is from a group chat' },
            { name: 'data.pushName', desc: 'Sender\'s display name on WhatsApp' },
        ],
        n8nAccess: `// n8n field access:
// Reply To:     {{ $json.data.fromJid }}
// Message:      {{ $json.data.message }}
// Sender Name:  {{ $json.data.pushName }}
// Message Type: {{ $json.data.messageType }}
// Is Group:     {{ $json.data.isGroup }}`,
        signatureCode: `const crypto = require('crypto');
const signature = $input.first().headers['x-webhook-signature-256'];
const payload = JSON.stringify($input.first().json);
const secret = 'YOUR_WEBHOOK_SECRET';

const expected = 'sha256=' + crypto
  .createHmac('sha256', secret)
  .update(payload)
  .digest('hex');

if (signature !== expected) {
  throw new Error('Invalid signature');
}
return $input.all();`,
    },

    // ─── AI Auto-Reply ───────────────────────────────────────────────────
    'get-ai-config': {
        group: 'ai', method: 'GET', path: '/api/accounts/:id/ai-config',
        desc: 'Get the AI auto-reply configuration for an account.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, config: { provider: 'openai', model: 'gpt-4o', is_active: true, system_prompt: '...', temperature: 0.7, memory_enabled: true, memory_limit: 10 } },
    },
    'save-ai-config': {
        group: 'ai', method: 'POST', path: '/api/accounts/:id/ai-config',
        desc: 'Save or update AI auto-reply settings. Supports OpenAI, Anthropic, Gemini, Groq, and OpenRouter.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        bodyFields: [
            { name: 'provider', type: 'string', required: true, desc: 'openai | anthropic | gemini | groq | openrouter | openrouter-free' },
            { name: 'api_key', type: 'string', required: true, desc: 'API key for the selected provider' },
            { name: 'model', type: 'string', required: true, desc: 'Model name (e.g. gpt-4o, claude-sonnet-4)' },
            { name: 'system_prompt', type: 'string', required: false, desc: 'System prompt for the AI' },
            { name: 'temperature', type: 'number', required: false, desc: 'Creativity (0.0 - 1.0, default: 0.7)' },
            { name: 'is_active', type: 'boolean', required: false, desc: 'Enable/disable auto-reply (default: true)' },
            { name: 'memory_enabled', type: 'boolean', required: false, desc: 'Enable conversation memory (default: true)' },
            { name: 'memory_limit', type: 'number', required: false, desc: 'Max messages to remember (default: 10)' },
        ],
        body: { provider: 'openai', api_key: 'sk-...', model: 'gpt-4o', system_prompt: 'You are a helpful assistant.', temperature: 0.7, is_active: true },
        response: { success: true, config: { provider: 'openai', model: 'gpt-4o', is_active: true } },
    },
    'delete-ai-config': {
        group: 'ai', method: 'DELETE', path: '/api/accounts/:id/ai-config',
        desc: 'Delete AI auto-reply configuration for an account. The AI will stop responding to messages.',
        auth: 'Session cookie',
        params: [{ name: ':id', desc: 'Account UUID' }],
        response: { success: true, message: 'AI config deleted' },
    },

    // ─── System ──────────────────────────────────────────────────────────
    'health': {
        group: 'system', method: 'GET', path: '/api/health',
        desc: 'Get server health including uptime, memory usage, message metrics, cache stats, and webhook queue status.',
        auth: 'None (public)',
        response: { success: true, uptime: 86400, nodeVersion: 'v20.11.0', memory: { heapUsed: 52428800, heapTotal: 104857600 }, metrics: { messagesSent: 1250, messagesReceived: 3400 }, cache: { hitRate: 0.92 }, webhookQueue: { queueSize: 0, isProcessing: false, delivered: 145, failed: 2 } },
    },
};

const API_GROUPS = [
    { key: 'auth', label: 'Authentication', icon: 'fa-key' },
    { key: 'accounts', label: 'Accounts', icon: 'fa-users' },
    { key: 'messages', label: 'Messages', icon: 'fa-comment-dots' },
    { key: 'webhooks', label: 'Webhooks', icon: 'fa-link' },
    { key: 'ai', label: 'AI Auto-Reply', icon: 'fa-robot' },
    { key: 'system', label: 'System', icon: 'fa-server' },
];

let currentEndpoint = null;

function initApiDocs() {
    const nav = document.getElementById('apiNav');
    if (!nav) return;

    let html = '';
    API_GROUPS.forEach((group, gi) => {
        const endpoints = Object.entries(API_ENDPOINTS).filter(([, ep]) => ep.group === group.key);
        if (endpoints.length === 0) return;
        const isFirst = gi === 2; // Messages group open by default
        html += `<div class="api-nav-group">
            <button class="api-nav-group-toggle${isFirst ? ' active' : ''}" onclick="toggleApiGroup(this)">
                <i class="fas ${group.icon}"></i> ${group.label}
                <span class="api-nav-count">${endpoints.length}</span>
                <i class="fas fa-chevron-down toggle-icon"></i>
            </button>
            <div class="api-nav-items${isFirst ? ' show' : ''}">`;
        endpoints.forEach(([key, ep]) => {
            const methodClass = ep.method === 'INFO' ? 'info-ref' : ep.method.toLowerCase();
            const methodLabel = ep.method === 'INFO' ? 'REF' : (ep.method === 'DELETE' ? 'DEL' : ep.method);
            html += `<a href="#" class="api-nav-item" data-endpoint="${key}" onclick="showEndpoint('${key}', event)">
                <span class="method-badge ${methodClass}">${methodLabel}</span> ${ep.isReference ? ep.path : ep.path.replace('/api/', '/')}
            </a>`;
        });
        html += `</div></div>`;
    });

    nav.innerHTML = html;

    // Show default endpoint
    showEndpoint('send-text');
}

function showEndpoint(key, evt) {
    if (evt) evt.preventDefault();
    const ep = API_ENDPOINTS[key];
    if (!ep) return;

    currentEndpoint = key;

    // Update nav active state
    document.querySelectorAll('.api-nav-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-endpoint') === key);
    });

    // Ensure parent group is open
    const activeNavItem = document.querySelector(`.api-nav-item[data-endpoint="${key}"]`);
    if (activeNavItem) {
        const groupItems = activeNavItem.closest('.api-nav-items');
        const groupToggle = groupItems?.previousElementSibling;
        if (groupItems && !groupItems.classList.contains('show')) {
            groupItems.classList.add('show');
            groupToggle?.classList.add('active');
        }
    }

    const container = document.getElementById('apiEndpointDetail');
    if (!container) return;

    // Reference page (webhook payload)
    if (ep.isReference) {
        container.innerHTML = renderReferenceEndpoint(ep);
        container.scrollTop = 0;
        return;
    }

    let html = '';

    // Header
    const methodClass = ep.method.toLowerCase();
    html += `<div class="endpoint-header">
        <span class="method-badge ${methodClass} large">${ep.method}</span>
        <code class="endpoint-url">${escapeHtml(ep.path)}</code>
    </div>
    <p class="endpoint-desc">${ep.desc}</p>`;

    // Auth badge
    html += `<div class="endpoint-meta">
        <span class="meta-tag"><i class="fas fa-shield-halved"></i> ${escapeHtml(ep.auth || 'Session cookie')}</span>
    </div>`;

    // URL params
    if (ep.params && ep.params.length > 0) {
        html += `<div class="api-section"><h4>URL Parameters</h4><div class="params-table">`;
        ep.params.forEach(p => {
            html += `<div class="param-row"><code class="param-name">${escapeHtml(p.name)}</code><span class="param-desc">${escapeHtml(p.desc)}</span></div>`;
        });
        html += `</div></div>`;
    }

    // Note
    if (ep.note) {
        html += `<div class="api-note"><i class="fas fa-info-circle"></i> ${ep.note}</div>`;
    }

    // Request body fields table
    if (ep.bodyFields && ep.bodyFields.length > 0) {
        html += `<div class="api-section"><h4>Request Body Parameters</h4><div class="params-table params-table-full">`;
        ep.bodyFields.forEach(f => {
            html += `<div class="param-row">
                <code class="param-name">${escapeHtml(f.name)}</code>
                <span class="param-type">${escapeHtml(f.type)}</span>
                <span class="param-required ${f.required ? 'required' : 'optional'}">${f.required ? 'Required' : 'Optional'}</span>
                <span class="param-desc">${f.desc}</span>
            </div>`;
        });
        html += `</div></div>`;
    }

    // Request body JSON
    if (ep.body) {
        html += `<div class="api-section"><h4>Request Body</h4>`;
        html += renderCodeBlock('JSON', JSON.stringify(ep.body, null, 2), true);
        html += `</div>`;
    }

    // Response
    if (ep.response) {
        html += `<div class="api-section"><h4>Success Response</h4>`;
        html += renderCodeBlock('200 OK', JSON.stringify(ep.response, null, 2), false, 'success');
        html += `</div>`;
    }

    // Error responses
    if (ep.errors && ep.errors.length > 0) {
        html += `<div class="api-section"><h4>Error Responses</h4>`;
        ep.errors.forEach(err => {
            html += renderCodeBlock(`${err.code} Error`, JSON.stringify(err.body, null, 2), false, 'error');
        });
        html += `</div>`;
    }

    // cURL
    if (ep.curl) {
        html += `<div class="api-section"><h4>cURL Example</h4>`;
        html += renderCodeBlock('Shell', ep.curl, true);
        html += `</div>`;
    }

    // n8n snippet
    if (ep.n8n) {
        html += `<div class="api-section"><h4>n8n / Automation Example</h4>`;
        html += renderCodeBlock('JSON — n8n HTTP Request', ep.n8n, true);
        html += `</div>`;
    }

    // Tips
    if (ep.tips && ep.tips.length > 0) {
        html += `<div class="api-section"><h4>Tips</h4><ul class="api-tips">`;
        ep.tips.forEach(t => { html += `<li>${t}</li>`; });
        html += `</ul></div>`;
    }

    container.innerHTML = html;
    container.scrollTop = 0;
}

function renderReferenceEndpoint(ep) {
    let html = `<div class="endpoint-header">
        <span class="method-badge info-ref large">REF</span>
        <code class="endpoint-url">${escapeHtml(ep.path)}</code>
    </div>
    <p class="endpoint-desc">${ep.desc}</p>`;

    // Payload
    if (ep.referencePayload) {
        html += `<div class="api-section"><h4>Payload Structure</h4>`;
        html += renderCodeBlock('Webhook Payload', ep.referencePayload, true);
        html += `</div>`;
    }

    // Field reference table
    if (ep.payloadFields && ep.payloadFields.length > 0) {
        html += `<div class="api-section"><h4>Field Reference</h4><div class="params-table">`;
        ep.payloadFields.forEach(f => {
            html += `<div class="param-row"><code class="param-name">${escapeHtml(f.name)}</code><span class="param-desc">${escapeHtml(f.desc)}</span></div>`;
        });
        html += `</div></div>`;
    }

    // n8n access
    if (ep.n8nAccess) {
        html += `<div class="api-section"><h4>n8n Field Access</h4>`;
        html += renderCodeBlock('n8n Expressions', ep.n8nAccess, true);
        html += `</div>`;
    }

    // Signature verification
    if (ep.signatureCode) {
        html += `<div class="api-section"><h4>Signature Verification (n8n Code Node)</h4>
            <p class="section-desc">If you set a webhook secret, verify the HMAC signature before processing:</p>`;
        html += renderCodeBlock('JavaScript', ep.signatureCode, true);
        html += `</div>`;
    }

    // n8n integration guide
    html += `<div class="integration-card">
        <div class="integration-header">
            <div class="integration-icon"><i class="fas fa-diagram-project"></i></div>
            <div><h4>n8n Integration Guide</h4><p>Step-by-step setup for n8n workflows</p></div>
        </div>
        <div class="integration-steps">
            <div class="step"><span class="step-num">1</span><div><strong>Create Webhook Trigger</strong><p>Add a Webhook node in n8n. Copy the Production URL and add it in the Webhooks section of this dashboard.</p></div></div>
            <div class="step"><span class="step-num">2</span><div><strong>Add HTTP Request Node</strong><p>Method: POST, URL: https://YOUR_DOMAIN/api/send</p></div></div>
            <div class="step"><span class="step-num">3</span><div><strong>Set JSON Body</strong><p>Use api_key, to: {{ $json.data.fromJid }}, message: your reply text</p></div></div>
        </div>
    </div>`;

    return html;
}

function renderCodeBlock(label, code, copyable, modifier) {
    const cls = modifier ? ` ${modifier}` : '';
    const copyBtn = copyable ? `<button class="copy-btn" onclick="copyCode(this)"><i class="fas fa-copy"></i> Copy</button>` : '';
    return `<div class="code-block${cls}">
        <div class="code-header"><span>${escapeHtml(label)}</span>${copyBtn}</div>
        <pre><code>${escapeHtml(code)}</code></pre>
    </div>`;
}

function filterApiEndpoints(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.api-nav-group').forEach(group => {
        const items = group.querySelectorAll('.api-nav-item');
        let anyVisible = false;
        items.forEach(item => {
            const text = item.textContent.toLowerCase();
            const key = item.getAttribute('data-endpoint') || '';
            const ep = API_ENDPOINTS[key];
            const desc = ep ? ep.desc.toLowerCase() : '';
            const visible = !q || text.includes(q) || desc.includes(q) || key.includes(q);
            item.style.display = visible ? '' : 'none';
            if (visible) anyVisible = true;
        });
        // Show group if any items match
        group.style.display = anyVisible ? '' : 'none';
        if (q && anyVisible) {
            group.querySelector('.api-nav-items')?.classList.add('show');
            group.querySelector('.api-nav-group-toggle')?.classList.add('active');
        }
    });
}

function toggleApiGroup(btn) {
    const items = btn.nextElementSibling;
    const isActive = btn.classList.contains('active');
    btn.classList.toggle('active', !isActive);
    items.classList.toggle('show', !isActive);
}

function copyCode(btn) {
    const code = btn.closest('.code-block').querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        btn.style.background = 'var(--primary)';
        btn.style.color = 'white';
        btn.style.borderColor = 'var(--primary)';
        setTimeout(() => {
            btn.innerHTML = original;
            btn.style.background = '';
            btn.style.color = '';
            btn.style.borderColor = '';
        }, 2000);
    }).catch(() => showToast('Failed to copy', 'error'));
}

// ============================================================================
// Utilities
// ============================================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: 'check-circle', error: 'exclamation-circle', info: 'info-circle' };
    toast.innerHTML = `
        <i class="fas fa-${icons[type] || 'info-circle'}" style="color: var(--${type === 'success' ? 'success' : type === 'error' ? 'error' : 'info'})"></i>
        <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
