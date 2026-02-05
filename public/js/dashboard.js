/**
 * WhatsApp Multi-Automation Dashboard
 * Client-side JavaScript
 */

// ============================================================================
// State
// ============================================================================

let accounts = [];
let currentAccountId = null;
let socket = null;
let activePollingAccountId = null;  // Track which account is being polled
let qrGeneratedAt = null;           // Track QR generation time
let qrTimerInterval = null;         // QR countdown timer

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

    // Refresh data periodically
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
        
        // Re-subscribe to current account if we have one
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
        
        // If this is the account we're watching and it's ready, show success
        if (data.accountId === activePollingAccountId && data.status === 'ready') {
            showQrSuccess();
        }
        
        loadAccounts(); // Refresh full list
    });

    socket.on('qr-update', (data) => {
        console.log('QR update received:', data.accountId);
        if (data.accountId === activePollingAccountId) {
            displayQrCode(data.qr);
        }
    });

    socket.on('account-deleted', (data) => {
        loadAccounts();
    });
}

function updateSystemStatus(online) {
    const indicator = document.querySelector('.sidebar-footer .status-indicator');
    const text = document.querySelector('.sidebar-footer span');
    
    if (indicator) {
        indicator.classList.toggle('online', online);
    }
    if (text) {
        text.textContent = online ? 'System Online' : 'Reconnecting...';
    }
}

// ============================================================================
// Navigation
// ============================================================================

function initializeNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.dataset.view;
            switchView(view);
        });
    });

    // Mobile menu toggle
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    
    menuToggle?.addEventListener('click', () => {
        sidebar.classList.toggle('open');
    });
}

function switchView(viewName) {
    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.view === viewName);
    });

    // Update views
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });
    
    // Handle special case for api-docs -> apiDocsView
    const viewId = viewName === 'api-docs' ? 'apiDocsView' : `${viewName}View`;
    const view = document.getElementById(viewId);
    if (view) {
        view.classList.add('active');
    }

    // Update title
    const titles = {
        'dashboard': 'Dashboard',
        'accounts': 'Accounts',
        'webhooks': 'Webhooks',
        'system': 'System',
        'api-docs': 'API Documentation'
    };
    
    document.getElementById('pageTitle').textContent = titles[viewName] || viewName;

    // Load view-specific data
    if (viewName === 'system') {
        loadHealth();
    } else if (viewName === 'webhooks') {
        populateWebhookAccountSelect();
    }

    // Close mobile menu
    document.getElementById('sidebar')?.classList.remove('open');
}

// ============================================================================
// Modals
// ============================================================================

function initializeModals() {
    // QR Modal
    document.getElementById('closeQrModal')?.addEventListener('click', () => {
        closeModal('qrModal');
    });

    // New Account Modal
    document.getElementById('closeNewAccountModal')?.addEventListener('click', () => {
        closeModal('newAccountModal');
    });

    // AI Config Modal
    document.getElementById('closeAiConfigModal')?.addEventListener('click', () => {
        closeModal('aiConfigModal');
    });

    // Close on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('show');
            }
        });
    });
}

function openModal(modalId) {
    document.getElementById(modalId)?.classList.add('show');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
    
    // Cleanup when closing QR modal
    if (modalId === 'qrModal') {
        // Stop polling for this account
        activePollingAccountId = null;
        
        // Clear QR timer
        if (qrTimerInterval) {
            clearInterval(qrTimerInterval);
            qrTimerInterval = null;
        }
        qrGeneratedAt = null;
        
        // Reset QR container
        const qrContainer = document.getElementById('qrContainer');
        if (qrContainer) {
            qrContainer.innerHTML = '<p>Waiting for QR code...</p>';
        }
    }
}

// ============================================================================
// Event Listeners
// ============================================================================

function initializeEventListeners() {
    // New Account buttons
    document.getElementById('newAccountBtn')?.addEventListener('click', () => openModal('newAccountModal'));
    document.getElementById('newAccountBtn2')?.addEventListener('click', () => openModal('newAccountModal'));

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    // New Account Form
    document.getElementById('newAccountForm')?.addEventListener('submit', createAccount);

    // AI Config Form
    document.getElementById('aiConfigForm')?.addEventListener('submit', saveAiConfig);
    document.getElementById('deleteAiConfig')?.addEventListener('click', deleteAiConfig);
    
    // AI Provider change - update model dropdown
    document.getElementById('aiProvider')?.addEventListener('change', (e) => {
        updateModelDropdown(e.target.value);
    });
    
    // AI Active toggle - update status text
    document.getElementById('aiActive')?.addEventListener('change', (e) => {
        updateToggleStatus(e.target);
    });

    // Webhook Account Select
    document.getElementById('webhookAccountSelect')?.addEventListener('change', loadWebhooksForAccount);
}

// ============================================================================
// API Calls
// ============================================================================

async function apiCall(url, options = {}) {
    try {
        const response = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Request failed');
        }

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
        
        // Update stats
        if (data.metrics) {
            document.getElementById('messagesSent').textContent = data.metrics.messagesSent || 0;
            document.getElementById('messagesReceived').textContent = data.metrics.messagesReceived || 0;
        }

        // Update system view
        if (data.uptime) {
            document.getElementById('sysUptime').textContent = formatUptime(data.uptime);
        }
        if (data.memory) {
            const usedMB = Math.round(data.memory.heapUsed / 1024 / 1024);
            document.getElementById('sysMemory').textContent = `${usedMB} MB`;
        }
        if (data.cache) {
            const hitRate = (data.cache.hitRate * 100).toFixed(1);
            document.getElementById('sysCacheHit').textContent = `${hitRate}%`;
        }
    } catch (error) {
        console.error('Failed to load health:', error);
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

        // CRITICAL: Subscribe to socket BEFORE opening modal
        // Backend now starts connection async, so we have time to subscribe
        currentAccountId = data.account.id;
        activePollingAccountId = data.account.id;
        socket.emit('subscribe-account', currentAccountId);
        
        // Small delay to ensure subscription is processed
        await new Promise(resolve => setTimeout(resolve, 100));
        
        openModal('qrModal');
        pollQrCode(currentAccountId);
    } catch (error) {
        console.error('Failed to create account:', error);
    }
}

async function deleteAccount(accountId) {
    if (!confirm('Are you sure you want to delete this account? This cannot be undone.')) {
        return;
    }

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
        // Subscribe FIRST before initiating reconnect
        currentAccountId = accountId;
        activePollingAccountId = accountId;
        socket.emit('subscribe-account', accountId);
        
        // Small delay to ensure subscription is processed
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

async function pollQrCode(accountId) {
    const qrContainer = document.getElementById('qrContainer');
    qrContainer.innerHTML = '<p>Initializing connection...</p>';

    let attempts = 0;
    const maxAttempts = 90;
    let lastQr = null;
    let qrDisplayed = false;

    const poll = async () => {
        // CRITICAL: Check against activePollingAccountId to properly cancel on modal close
        if (activePollingAccountId !== accountId) {
            console.log(`Polling cancelled for ${accountId} (activePollingAccountId changed)`);
            return;
        }
        
        try {
            // First check account status
            const accountData = await apiCall(`/api/accounts/${accountId}`);
            const status = accountData.account?.status || accountData.account?.runtimeStatus;
            
            // If connected, stop polling and show success
            if (status === 'ready') {
                showQrSuccess();
                return;
            }
            
            // If error or disconnected with error message, show it and stop
            if ((status === 'error' || status === 'disconnected') && accountData.account?.error_message) {
                qrContainer.innerHTML = `
                    <p style="color: var(--warning); margin-bottom: 10px;">
                        <i class="fas fa-exclamation-triangle"></i> ${accountData.account.error_message}
                    </p>
                    <button class="btn btn-primary" onclick="reconnectAccount('${accountId}')">
                        <i class="fas fa-sync"></i> Try Again
                    </button>
                `;
                return;
            }
            
            // Try to get QR code
            const data = await apiCall(`/api/accounts/${accountId}/qr`);
            
            if (data.qr) {
                // Only update display if QR changed (prevents flickering)
                if (data.qr !== lastQr) {
                    lastQr = data.qr;
                    displayQrCode(data.qr);
                    qrDisplayed = true;
                }
            } else if (!qrDisplayed && status === 'initializing') {
                // Show waiting message only if QR hasn't been displayed yet
                qrContainer.innerHTML = '<p>Waiting for QR code... <br><small>This may take a few seconds</small></p>';
            }

            attempts++;
            if (attempts < maxAttempts && activePollingAccountId === accountId) {
                // Poll faster initially (1.5s), then slower (3s)
                const interval = attempts < 10 ? 1500 : 3000;
                setTimeout(poll, interval);
            } else if (activePollingAccountId === accountId) {
                qrContainer.innerHTML = `
                    <p style="color: var(--warning); margin-bottom: 10px;">QR code timeout.</p>
                    <button class="btn btn-primary" onclick="reconnectAccount('${accountId}')">
                        <i class="fas fa-sync"></i> Try Again
                    </button>
                `;
            }
        } catch (error) {
            console.error('QR poll error:', error);
            // Continue polling on network errors, but slower
            if (attempts < maxAttempts && activePollingAccountId === accountId) {
                setTimeout(poll, 3000);
            }
        }
    };

    // Start polling after a small delay to let connection initialize
    setTimeout(poll, 500);
}

function showQrSuccess() {
    const qrContainer = document.getElementById('qrContainer');
    if (qrContainer) {
        qrContainer.innerHTML = '<p style="color: var(--success);"><i class="fas fa-check-circle"></i> Connected successfully!</p>';
    }
    
    // Clear timer
    if (qrTimerInterval) {
        clearInterval(qrTimerInterval);
        qrTimerInterval = null;
    }
    
    setTimeout(() => {
        closeModal('qrModal');
        loadAccounts();
    }, 2000);
}

function displayQrCode(qrDataUrl) {
    const qrContainer = document.getElementById('qrContainer');
    qrGeneratedAt = Date.now();
    
    qrContainer.innerHTML = `
        <img src="${qrDataUrl}" alt="QR Code" style="max-width: 280px;">
        <p class="qr-timer" id="qrTimer" style="margin-top: 10px; font-size: 12px; color: #888;">Scan within 20 seconds</p>
    `;
    
    // Clear existing timer
    if (qrTimerInterval) {
        clearInterval(qrTimerInterval);
    }
    
    // Update timer countdown
    qrTimerInterval = setInterval(() => {
        if (!qrGeneratedAt || activePollingAccountId === null) {
            clearInterval(qrTimerInterval);
            qrTimerInterval = null;
            return;
        }
        
        const elapsed = Math.floor((Date.now() - qrGeneratedAt) / 1000);
        const remaining = Math.max(0, 20 - elapsed);
        const timer = document.getElementById('qrTimer');
        
        if (timer) {
            if (remaining > 5) {
                timer.textContent = `Scan within ${remaining} seconds`;
                timer.style.color = '#888';
            } else if (remaining > 0) {
                timer.textContent = `Hurry! ${remaining} seconds left`;
                timer.style.color = '#f39c12';
            } else {
                timer.textContent = 'Refreshing QR code...';
                timer.style.color = '#3498db';
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

// Model options per provider
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
    const statusSpan = document.querySelector('.toggle-status');
    if (statusSpan) {
        statusSpan.textContent = checkbox.checked ? 'Enabled' : 'Disabled';
    }
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
            
            // Chatbot toggle
            const isActive = data.config.is_active !== false;
            document.getElementById('aiActive').checked = isActive;
            updateToggleStatus({ checked: isActive });
            
            // Memory settings
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
        loadAccounts(); // Refresh to show updated chatbot status
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

    select.innerHTML = '<option value="">Select Account</option>';
    accounts.forEach(account => {
        const option = document.createElement('option');
        option.value = account.id;
        option.textContent = `${account.name} (${account.phone_number || 'Not connected'})`;
        select.appendChild(option);
    });
}

async function loadWebhooksForAccount() {
    const accountId = document.getElementById('webhookAccountSelect').value;
    const container = document.getElementById('webhooksList');

    if (!accountId) {
        container.innerHTML = '';
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

    if (webhooks.length === 0) {
        container.innerHTML = `
            <p class="info-text">No webhooks configured.</p>
            <button class="btn btn-primary" onclick="addWebhook('${accountId}')">
                <i class="fas fa-plus"></i> Add Webhook
            </button>
        `;
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
        html += `
            <tr>
                <td>${webhook.url}</td>
                <td>
                    <span class="status-badge ${webhook.is_active ? 'ready' : 'disconnected'}">
                        ${webhook.is_active ? 'Active' : 'Inactive'}
                    </span>
                </td>
                <td class="action-buttons">
                    <button class="btn btn-sm btn-secondary" onclick="testWebhook('${webhook.id}')">Test</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteWebhook('${webhook.id}')">Delete</button>
                </td>
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
        <button class="btn btn-primary" style="margin-top: 16px;" onclick="addWebhook('${accountId}')">
            <i class="fas fa-plus"></i> Add Webhook
        </button>
    `;

    container.innerHTML = html;
}

async function addWebhook(accountId) {
    const url = prompt('Enter webhook URL:');
    if (!url) return;

    const secret = prompt('Enter webhook secret (optional):');

    try {
        await apiCall(`/api/accounts/${accountId}/webhooks`, {
            method: 'POST',
            body: JSON.stringify({ url, secret, events: ['message'] })
        });

        showToast('Webhook added', 'success');
        loadWebhooksForAccount();
    } catch (error) {
        console.error('Failed to add webhook:', error);
    }
}

async function testWebhook(webhookId) {
    try {
        const data = await apiCall(`/api/webhooks/${webhookId}/test`, { method: 'POST' });
        
        if (data.success) {
            showToast('Webhook test successful', 'success');
        } else {
            showToast(`Webhook test failed: ${data.error}`, 'error');
        }
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
        const emptyRow = '<tr><td colspan="6" class="loading">No accounts yet. Create one to get started!</td></tr>';
        if (tbody) tbody.innerHTML = emptyRow;
        if (tbodyFull) tbodyFull.innerHTML = emptyRow;
        return;
    }

    // Dashboard table (simplified)
    if (tbody) {
        tbody.innerHTML = accounts.map(account => `
            <tr>
                <td><strong>${escapeHtml(account.name)}</strong></td>
                <td>${account.phone_number || '-'}</td>
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
                <td><strong>${escapeHtml(account.name)}</strong></td>
                <td>${account.phone_number || '-'}</td>
                <td>${renderStatusBadge(account.runtimeStatus || account.status)}</td>
                <td>${renderApiKey(account.api_key)}</td>
                <td>${formatDate(account.created_at)}</td>
                <td class="action-buttons">
                    ${renderAccountActions(account, true)}
                </td>
            </tr>
        `).join('');
    }
}

function renderApiKey(apiKey) {
    if (!apiKey) return '-';
    return `
        <div class="api-key-container">
            <span class="api-key-full" onclick="toggleApiKeyExpand(this)" title="Click to expand">${escapeHtml(apiKey)}</span>
            <button class="btn-copy" onclick="copyApiKey('${escapeHtml(apiKey)}')" title="Copy">
                <i class="fas fa-copy"></i>
            </button>
        </div>
    `;
}

function toggleApiKeyExpand(element) {
    element.classList.toggle('expanded');
}

function copyApiKey(apiKey) {
    navigator.clipboard.writeText(apiKey).then(() => {
        showToast('API key copied to clipboard', 'success');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

function renderChatbotStatus(account) {
    // Check if account has AI config and if it's active
    const isActive = account.ai_active;
    if (isActive === true) {
        return '<span class="chatbot-badge enabled"><i class="fas fa-circle"></i> On</span>';
    } else if (isActive === false) {
        return '<span class="chatbot-badge disabled"><i class="fas fa-circle"></i> Off</span>';
    }
    return '<span class="chatbot-badge disabled"><i class="fas fa-minus"></i> N/A</span>';
}

function renderStatusBadge(status) {
    const statusLabels = {
        'ready': 'Connected',
        'disconnected': 'Disconnected',
        'qr_ready': 'Scan QR',
        'initializing': 'Connecting...',
        'error': 'Error',
        'auth_failed': 'Auth Failed'
    };

    return `<span class="status-badge ${status}">${statusLabels[status] || status}</span>`;
}

function renderAccountActions(account, showAll = false) {
    const status = account.runtimeStatus || account.status;
    let actions = '';

    if (status === 'qr_ready' || status === 'disconnected' || status === 'initializing') {
        actions += `<button class="btn btn-sm btn-primary" onclick="reconnectAccount('${account.id}')">
            <i class="fas fa-qrcode"></i>
        </button>`;
    }

    if (status === 'ready') {
        actions += `<button class="btn btn-sm btn-secondary" onclick="openAiConfig('${account.id}')" title="AI Config">
            <i class="fas fa-robot"></i>
        </button>`;
    }

    if (showAll) {
        actions += `<button class="btn btn-sm btn-danger" onclick="deleteAccount('${account.id}')" title="Delete">
            <i class="fas fa-trash"></i>
        </button>`;
    }

    return actions;
}

function updateStats() {
    document.getElementById('totalAccounts').textContent = accounts.length;
    
    const active = accounts.filter(a => 
        (a.runtimeStatus || a.status) === 'ready'
    ).length;
    document.getElementById('activeAccounts').textContent = active;
}

function updateAccountStatus(accountId, status, phoneNumber) {
    const account = accounts.find(a => a.id === accountId);
    if (account) {
        account.runtimeStatus = status;
        if (phoneNumber) account.phone_number = phoneNumber;
        renderAccountsTable();
        updateStats();
    }
}

// ============================================================================
// Utilities
// ============================================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
        <span>${escapeHtml(message)}</span>
    `;
    
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString();
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}
