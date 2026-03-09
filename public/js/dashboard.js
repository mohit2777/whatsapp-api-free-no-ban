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
    loadAccounts();
    loadHealth();

    setInterval(loadAccounts, 30000);
    setInterval(loadHealth, 60000);
    // Auto-refresh activity log every 10s when webhook tab is visible
    setInterval(() => {
        const webhooksView = document.getElementById('webhooksView');
        if (webhooksView && webhooksView.style.display !== 'none') {
            loadActivityLog();
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
    else if (viewName === 'webhooks') { populateWebhookAccountSelect(); loadWebhookStats(); loadActivityLog(); }

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
        if (input) { input.value = ''; filterAccounts(''); input.focus(); }
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

function filterAccounts(query) {
    const tbodyFull = document.getElementById('accountsTableFull');
    if (!tbodyFull) return;

    const q = query.toLowerCase();
    const rows = tbodyFull.querySelectorAll('tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
    });
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
// API Docs Helpers
// ============================================================================

function toggleApiGroup(btn) {
    const items = btn.nextElementSibling;
    const isActive = btn.classList.contains('active');
    btn.classList.toggle('active', !isActive);
    items.classList.toggle('show', !isActive);
}

function showEndpoint(endpoint) {
    // Remove active class from all items
    document.querySelectorAll('.api-nav-item').forEach(item => item.classList.remove('active'));
    // Add active to clicked item
    event.target.closest('.api-nav-item')?.classList.add('active');
    // For now, scroll to content (all endpoints shown in single view)
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
