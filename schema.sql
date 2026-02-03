-- ============================================================================
-- WHATSAPP MULTI-AUTOMATION V4 - DATABASE SCHEMA
-- ============================================================================
-- Run this file in your Supabase SQL Editor to set up the database
-- Last Updated: 2026-02-02
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- WhatsApp Accounts Table
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'initializing' CHECK (status IN ('initializing', 'qr_ready', 'ready', 'disconnected', 'auth_failed', 'error')),
    phone_number VARCHAR(50),
    api_key VARCHAR(64) UNIQUE,
    session_data TEXT,
    last_session_saved TIMESTAMP WITH TIME ZONE,
    qr_code TEXT,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_accounts_api_key ON whatsapp_accounts(api_key);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON whatsapp_accounts(status);

COMMENT ON TABLE whatsapp_accounts IS 'Stores WhatsApp account information and session data';
COMMENT ON COLUMN whatsapp_accounts.session_data IS 'Base64 encoded WhatsApp session data for persistent authentication';
COMMENT ON COLUMN whatsapp_accounts.api_key IS 'API key for authenticating message sending without dashboard login';

-- ============================================================================
-- WEBHOOKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    secret VARCHAR(255),
    events TEXT[] DEFAULT ARRAY['message'],
    is_active BOOLEAN DEFAULT true,
    retry_count INTEGER DEFAULT 0,
    last_success_at TIMESTAMP WITH TIME ZONE,
    last_failure_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_account ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(is_active);

COMMENT ON TABLE webhooks IS 'Webhook configurations for message forwarding';

-- ============================================================================
-- WEBHOOK DELIVERY QUEUE
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhook_delivery_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    webhook_url VARCHAR(500) NOT NULL,
    webhook_secret VARCHAR(255),
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed', 'dead_letter')),
    attempt_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 5,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    last_response_code INTEGER,
    processing_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_queue_status ON webhook_delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_next_retry ON webhook_delivery_queue(next_retry_at);

-- ============================================================================
-- AI CONFIGURATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID UNIQUE NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'openrouter-free')),
    api_key VARCHAR(255) NOT NULL,
    model VARCHAR(100) NOT NULL,
    system_prompt TEXT DEFAULT '',
    temperature DECIMAL(3,2) DEFAULT 0.7,
    is_active BOOLEAN DEFAULT true,
    memory_enabled BOOLEAN DEFAULT true,
    memory_limit INTEGER DEFAULT 10,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_configs_account ON ai_configs(account_id);

COMMENT ON TABLE ai_configs IS 'AI auto-reply configuration per account';
COMMENT ON COLUMN ai_configs.memory_enabled IS 'Whether to include conversation history in AI prompts';
COMMENT ON COLUMN ai_configs.memory_limit IS 'Number of previous messages to include as context';

-- ============================================================================
-- CONVERSATION HISTORY (for AI context)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    contact_id VARCHAR(100) NOT NULL,
    direction VARCHAR(20) NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    message TEXT NOT NULL,
    message_type VARCHAR(50) DEFAULT 'text',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_account_contact ON conversation_history(account_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_conversation_created ON conversation_history(created_at);

-- Auto-cleanup old conversations (keep last 7 days)
CREATE OR REPLACE FUNCTION cleanup_old_conversations()
RETURNS void AS $$
BEGIN
    DELETE FROM conversation_history WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SESSION TABLE (for express-session)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all tables with updated_at
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN 
        SELECT table_name 
        FROM information_schema.columns 
        WHERE column_name = 'updated_at' 
        AND table_schema = 'public'
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS update_%I_updated_at ON %I;
            CREATE TRIGGER update_%I_updated_at
            BEFORE UPDATE ON %I
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        ', t, t, t, t);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- ROW LEVEL SECURITY (Optional but recommended)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;

-- Service role can access everything
CREATE POLICY "Service role full access on accounts" ON whatsapp_accounts
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on webhooks" ON webhooks
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on queue" ON webhook_delivery_queue
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on ai_configs" ON ai_configs
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on history" ON conversation_history
    FOR ALL USING (auth.role() = 'service_role');

-- ============================================================================
-- USEFUL VIEWS
-- ============================================================================

CREATE OR REPLACE VIEW account_stats AS
SELECT 
    wa.id,
    wa.name,
    wa.status,
    wa.phone_number,
    wa.created_at,
    COUNT(DISTINCT wh.id) as webhook_count,
    EXISTS(SELECT 1 FROM ai_configs ac WHERE ac.account_id = wa.id AND ac.is_active) as ai_enabled
FROM whatsapp_accounts wa
LEFT JOIN webhooks wh ON wh.account_id = wa.id AND wh.is_active = true
GROUP BY wa.id;

CREATE OR REPLACE VIEW webhook_queue_stats AS
SELECT 
    status,
    COUNT(*) as count,
    AVG(attempt_count) as avg_attempts
FROM webhook_delivery_queue
GROUP BY status;

-- ============================================================================
-- CLEANUP FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_expired_data()
RETURNS void AS $$
BEGIN
    -- Clean up expired sessions
    DELETE FROM session WHERE expire < NOW();
    
    -- Clean up old webhook queue items (successful ones older than 24h)
    DELETE FROM webhook_delivery_queue 
    WHERE status = 'success' AND created_at < NOW() - INTERVAL '24 hours';
    
    -- Clean up dead letter items older than 7 days
    DELETE FROM webhook_delivery_queue 
    WHERE status = 'dead_letter' AND created_at < NOW() - INTERVAL '7 days';
    
    -- Clean up old conversation history
    PERFORM cleanup_old_conversations();
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- MIGRATIONS (Run only for existing installations)
-- ============================================================================

-- Add memory columns to ai_configs if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_configs' AND column_name = 'memory_enabled') THEN
        ALTER TABLE ai_configs ADD COLUMN memory_enabled BOOLEAN DEFAULT true;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_configs' AND column_name = 'memory_limit') THEN
        ALTER TABLE ai_configs ADD COLUMN memory_limit INTEGER DEFAULT 10;
    END IF;
END $$;

-- ============================================================================
-- DONE
-- ============================================================================
-- Run the cleanup periodically using pg_cron or external scheduler:
-- SELECT cleanup_expired_data();
