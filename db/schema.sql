CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_email TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  plan TEXT NOT NULL DEFAULT 'client',
  color TEXT DEFAULT '#10b981',
  niche TEXT DEFAULT '',
  signup_note TEXT DEFAULT '',
  portal_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  portal_password_hash TEXT DEFAULT '',
  requested_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_configs (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform_user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  human_handoff BOOLEAN NOT NULL DEFAULT FALSE,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  audit JSONB NOT NULL DEFAULT '[]'::jsonb,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_user_at TIMESTAMPTZ,
  last_bot_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_status ON conversations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(tenant_id, platform_user_id);

CREATE TABLE IF NOT EXISTS catalog_snapshots (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pages JSONB NOT NULL DEFAULT '[]'::jsonb,
  products JSONB NOT NULL DEFAULT '[]'::jsonb,
  policies JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_text TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS commerce_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'bot',
  platform_user_id TEXT DEFAULT '',
  conversation_id TEXT DEFAULT '',
  customer JSONB NOT NULL DEFAULT '{}'::jsonb,
  product JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery JSONB NOT NULL DEFAULT '{}'::jsonb,
  complaint JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT DEFAULT '',
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commerce_records_tenant ON commerce_records(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT DEFAULT '',
  action TEXT DEFAULT '',
  input_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_month ON usage_records(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'review',
  question TEXT NOT NULL,
  suggested_answer TEXT DEFAULT '',
  source TEXT DEFAULT 'conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processed_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_events_tenant_time ON processed_events(tenant_id, processed_at DESC);

CREATE TABLE IF NOT EXISTS raw_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform_user_id TEXT DEFAULT '',
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
