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
    else if (viewName === 'webhooks') { populateWebhookAccountSelect(); loadWebhookStats(); }

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
    let lastQr = null;
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
                        <p style="color: var(--warning);">${accountData.account.error_message}</p>
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
        <img src="${qrDataUrl}" alt="QR Code">
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
                timer.textContent = 'Refreshing QR code...';
                timer.style.color = 'var(--info)';
            }
        }
    }, 1000);
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
        option.textContent = `${account.name} (${account.phone_number || 'Not connected'})`;
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
        <table class="table">
            <thead>
                <tr>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

    webhooks.forEach(webhook => {
        const urlShort = webhook.url.length > 50 ? webhook.url.substring(0, 50) + '...' : webhook.url;
        html += `
            <tr>
                <td>
                    <code style="font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-secondary);" title="${escapeHtml(webhook.url)}">
                        ${escapeHtml(urlShort)}
                    </code>
                </td>
                <td>
                    <span class="status-badge ${webhook.is_active ? 'ready' : 'disconnected'}">
                        ${webhook.is_active ? 'Active' : 'Inactive'}
                    </span>
                </td>
                <td class="action-buttons">
                    <button class="btn btn-sm btn-info" onclick="testWebhook('${webhook.id}')" title="Test">
                        <i class="fas fa-bolt"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteWebhook('${webhook.id}')" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>`;
    });

    html += `</tbody></table>
        <div style="margin-top: 16px;">
            <button class="btn btn-primary" onclick="showAddWebhookForm('${accountId}')">
                <i class="fas fa-plus"></i> Add Webhook
            </button>
        </div>`;

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
        if (data.success) showToast('Webhook test successful', 'success');
        else showToast(`Webhook test failed: ${data.error}`, 'error');
    } catch (error) {
        console.error('Failed to test webhook:', error);
    }
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

function renderAccountsTable() {
    const tbody = document.getElementById('accountsTable');
    const tbodyFull = document.getElementById('accountsTableFull');

    if (accounts.length === 0) {
        const emptyRow = `<tr><td colspan="6" class="empty-state">
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
        tbody.innerHTML = accounts.map(account => `
            <tr>
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="width: 36px; height: 36px; background: var(--primary-glow); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--primary); font-size: 14px;">
                            <i class="fas fa-user"></i>
                        </div>
                        <strong>${escapeHtml(account.name)}</strong>
                    </div>
                </td>
                <td><span style="font-family: var(--font-mono, monospace); font-size: 13px; color: var(--text-secondary);">${account.phone_number || '-'}</span></td>
                <td>${renderStatusBadge(account.runtimeStatus || account.status)}</td>
                <td class="action-buttons">
                    ${renderAccountActions(account)}
                </td>
            </tr>
        `).join('');
    }

    // Full accounts table
    if (tbodyFull) {
        tbodyFull.innerHTML = accounts.map(account => `
            <tr>
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="width: 32px; height: 32px; background: var(--primary-glow); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--primary); font-size: 12px;">
                            <i class="fas fa-user"></i>
                        </div>
                        <strong>${escapeHtml(account.name)}</strong>
                    </div>
                </td>
                <td><span style="font-family: var(--font-mono, monospace); font-size: 13px; color: var(--text-secondary);">${account.phone_number || '-'}</span></td>
                <td>${renderStatusBadge(account.runtimeStatus || account.status)}</td>
                <td>${renderApiKey(account.api_key)}</td>
                <td><span style="font-size: 13px; color: var(--text-secondary);">${formatDate(account.created_at)}</span></td>
                <td class="action-buttons">
                    ${renderAccountActions(account, true)}
                </td>
            </tr>
        `).join('');
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

    if (showAll) {
        actions += `<button class="btn btn-sm btn-danger" onclick="deleteAccount('${account.id}')" title="Delete">
            <i class="fas fa-trash"></i>
        </button>`;
    }

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

        return `
            <div class="connection-item">
                <div class="connection-left">
                    <div class="connection-dot ${dotColor}"></div>
                    <div>
                        <div class="connection-name">${escapeHtml(account.name)}</div>
                        <div class="connection-status">${statusLabel}</div>
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
