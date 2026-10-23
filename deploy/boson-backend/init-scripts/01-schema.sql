-- Schema Database Boson Studio (Supabase / PostgreSQL)
-- Mengintegrasikan: Auth Profil, Multi-Tier Dompet, API Keys Lintas Platform, Subscriptions, & Allowed Platforms

CREATE SCHEMA IF NOT EXISTS auth;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA public;

-- 1. Tabel Profil Pengguna (Sinkron dengan auth.users Supabase)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    tier VARCHAR(20) DEFAULT 'free', -- 'free', 'payg', 'pro'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabel Platform yang Diizinkan (Owner Allowlist)
CREATE TABLE IF NOT EXISTS public.allowed_platforms (
    id VARCHAR(50) PRIMARY KEY, -- e.g. 'boson-desktop', 'aethel-web', 'boson-vscode', 'boson-cli'
    name TEXT NOT NULL,
    allowed_models TEXT[] DEFAULT '{"*"}'::text[],
    max_concurrent_streams INT DEFAULT 2,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Masukkan default platform yang diizinkan oleh Owner
INSERT INTO public.allowed_platforms (id, name, allowed_models, max_concurrent_streams)
VALUES 
    ('boson-desktop', 'Boson Studio Desktop & PWA', '{"*"}', 3),
    ('aethel-web', 'Aethel Studio (OpenDesign)', '{"deepseek-chat","deepseek-reasoner","claude-3-5-sonnet"}', 2),
    ('aethel-studio', 'Aethel Coding Assistant', '{"*"}', 2),
    ('boson-vscode', 'Boson IDE Companion Extension', '{"deepseek-chat","deepseek-reasoner"}', 2),
    ('boson-cli', 'Boson Developer CLI', '{"*"}', 1),
    ('pipeline', 'Application Pipeline & CI/CD', '{"*"}', 20),
    ('service-account', 'Service Account Client', '{"*"}', 20),
    ('agent-runtime', 'Autonomous Agent Runtime', '{"*"}', 50)
ON CONFLICT (id) DO NOTHING;

-- 3. Tabel Dompet / Saldo Pengguna (Multi-Bucket: Bonus, Subs, Normal/Deposit)
CREATE TABLE IF NOT EXISTS public.wallets (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    currency VARCHAR(3) DEFAULT 'USD',
    normal_balance NUMERIC(16, 6) DEFAULT 0.000000,       -- Saldo Top-Up / Deposit Bebas (Never Expires)
    subscription_balance NUMERIC(16, 6) DEFAULT 0.000000, -- Kuota Kredit Langganan Bulanan
    bonus_balance NUMERIC(16, 6) DEFAULT 2.000000,        -- Saldo Bonus Pendaftaran (Gratis $2)
    reserved_balance NUMERIC(16, 6) DEFAULT 0.000000,     -- Pre-flight Hold untuk cegah negative balance
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Tabel Langganan Bulanan (Subscription Tiers - Bersaing dg Claude Pro $20)
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    plan_tier VARCHAR(20) DEFAULT 'pro', -- 'pro' ($14/bln bernilai $15 token pool)
    price_usd NUMERIC(12, 2) DEFAULT 14.00,
    monthly_token_pool NUMERIC(12, 4) DEFAULT 15.0000,
    current_period_start TIMESTAMPTZ DEFAULT NOW(),
    current_period_end TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 month'),
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'cancelled', 'past_due'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Tabel Personal API Keys (Omnipresent Access untuk CLI, VS Code, Script)
CREATE TABLE IF NOT EXISTS public.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    key_name TEXT NOT NULL,
    key_prefix VARCHAR(16) NOT NULL, -- e.g. 'sk_boson_a1b2...' (hanya prefix untuk display UI)
    key_hash VARCHAR(64) NOT NULL UNIQUE, -- Hash SHA-256 (Zero-Trust: plaintext tidak disimpan)
    allowed_platforms TEXT[] DEFAULT '{"*"}'::text[], -- Pembatasan akses platform per key
    last_used_at TIMESTAMPTZ,
    is_revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Tabel Riwayat Transaksi (Top-Up, Deposit, Langganan)
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- 'deposit', 'subscription', 'usage', 'bonus', 'refund'
    amount NUMERIC(12, 4) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    payment_gateway VARCHAR(50), -- 'midtrans', 'stripe', 'xendit'
    gateway_reference TEXT,
    status VARCHAR(20) DEFAULT 'success', -- 'pending', 'success', 'failed'
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Tabel Buku Besar Pemakaian Token AI (Token Usage Ledger)
CREATE TABLE IF NOT EXISTS public.usage_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    platform_id VARCHAR(50) DEFAULT 'boson-desktop',
    session_id TEXT,
    model TEXT NOT NULL,
    prompt_tokens INT DEFAULT 0,
    completion_tokens INT DEFAULT 0,
    total_tokens INT DEFAULT 0,
    cost_usd NUMERIC(12, 6) DEFAULT 0.000000,
    deducted_from VARCHAR(20) DEFAULT 'bonus', -- 'bonus', 'subscription', 'normal'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Tabel Authorize Code PKCE Sesi Sementara (OAuth2)
CREATE TABLE IF NOT EXISTS public.pkce_sessions (
    authorize_id TEXT PRIMARY KEY,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT DEFAULT 'S256',
    redirect_uri TEXT,
    state TEXT,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    auth_code TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'exchanged', 'cancelled'
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Trigger Otomatis: Buat Profil & Wallet Saat User Baru Mendaftar di Supabase
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        NEW.raw_user_meta_data->>'avatar_url'
    );

    INSERT INTO public.wallets (user_id, currency, normal_balance, subscription_balance, bonus_balance)
    VALUES (
        NEW.id,
        'USD',
        0.0000,
        0.0000,
        2.0000 -- Bonus kredit awal pendaftaran $2.00
    );

    -- Catat transaksi bonus awal
    INSERT INTO public.transactions (user_id, type, amount, currency, status, metadata)
    VALUES (
        NEW.id,
        'bonus',
        2.0000,
        'USD',
        'success',
        '{"note": "Welcome bonus for new registration"}'::jsonb
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Pasang trigger ke auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Indexing untuk query cepat
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user_id ON public.usage_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_platform ON public.usage_ledger(platform_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON public.api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_pkce_sessions_auth_code ON public.pkce_sessions(auth_code);

-- ============================================================
-- KEAMANAN: ROW LEVEL SECURITY (RLS) & REVOKE HAK AKSES ANON
-- ============================================================
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pkce_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.wallets FROM anon;
REVOKE ALL ON public.api_keys FROM anon;
REVOKE ALL ON public.transactions FROM anon;
REVOKE ALL ON public.usage_ledger FROM anon;
REVOKE ALL ON public.pkce_sessions FROM anon;
REVOKE ALL ON public.subscriptions FROM anon;
REVOKE ALL ON public.profiles FROM anon;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP POLICY IF EXISTS service_role_all ON public.%I', tbl);
        EXECUTE format('CREATE POLICY service_role_all ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', tbl);
    END LOOP;
END $$;

-- ============================================================
-- ATOMIC DEBIT FUNCTION (ANTI RACE-CONDITION & CONCURRENCY SAFE)
-- ============================================================
CREATE OR REPLACE FUNCTION public.atomic_debit_wallet(
    p_user_id UUID,
    p_cost NUMERIC,
    p_model TEXT,
    p_platform_id TEXT,
    p_prompt_tokens INT,
    p_completion_tokens INT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
    v_wallet RECORD;
    v_rem_cost NUMERIC := p_cost;
    v_bonus NUMERIC;
    v_subs NUMERIC;
    v_norm NUMERIC;
    v_deduct NUMERIC;
    v_deducted_from TEXT := 'normal';
BEGIN
    -- 1. Kunci baris dompet user (Anti Race-Condition via FOR UPDATE)
    SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
    END IF;

    v_bonus := v_wallet.bonus_balance;
    v_subs := v_wallet.subscription_balance;
    v_norm := v_wallet.normal_balance;

    -- 2. Potong dari Bonus terlebih dahulu
    IF v_bonus > 0 AND v_rem_cost > 0 THEN
        v_deduct := LEAST(v_bonus, v_rem_cost);
        v_bonus := v_bonus - v_deduct;
        v_rem_cost := v_rem_cost - v_deduct;
        v_deducted_from := 'bonus';
    END IF;

    -- 3. Jika masih ada sisa, potong dari Subscription
    IF v_subs > 0 AND v_rem_cost > 0 THEN
        v_deduct := LEAST(v_subs, v_rem_cost);
        v_subs := v_subs - v_deduct;
        v_rem_cost := v_rem_cost - v_deduct;
        v_deducted_from := 'subscription';
    END IF;

    -- 4. Jika masih ada sisa, potong dari Normal Deposit
    IF v_rem_cost > 0 THEN
        v_norm := GREATEST(0.0000, v_norm - v_rem_cost);
        v_deducted_from := 'normal';
    END IF;

    -- 5. Update dompet secara atomik
    UPDATE public.wallets
    SET bonus_balance = v_bonus,
        subscription_balance = v_subs,
        normal_balance = v_norm,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- 6. Catat langsung ke usage_ledger dalam satu transaksi
    INSERT INTO public.usage_ledger (
        user_id, platform_id, model, prompt_tokens, completion_tokens,
        total_tokens, cost_usd, deducted_from, metadata
    ) VALUES (
        p_user_id, p_platform_id, p_model, p_prompt_tokens, p_completion_tokens,
        p_prompt_tokens + p_completion_tokens, p_cost, v_deducted_from, p_metadata
    );

    RETURN jsonb_build_object(
        'success', true,
        'deducted_from', v_deducted_from,
        'bonus_balance', v_bonus,
        'subscription_balance', v_subs,
        'normal_balance', v_norm,
        'cost_usd', p_cost
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.atomic_debit_wallet TO service_role;

-- ============================================================
-- GET USER DAILY USAGE FUNCTION (FOR VISUAL USAGE & TOKEN CHARTS)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_daily_usage(p_user_id UUID, p_days INT DEFAULT 14)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH date_series AS (
        SELECT generate_series(
            (CURRENT_DATE - ((p_days - 1) || ' days')::interval)::date,
            CURRENT_DATE,
            '1 day'::interval
        )::date AS day
    ),
    daily_agg AS (
        SELECT 
            ds.day,
            COALESCE(SUM(ul.cost_usd), 0)::numeric(12, 6) AS cost_usd,
            COALESCE(SUM(ul.total_tokens), 0)::bigint AS total_tokens,
            COALESCE(SUM(ul.prompt_tokens), 0)::bigint AS prompt_tokens,
            COALESCE(SUM(ul.completion_tokens), 0)::bigint AS completion_tokens,
            COUNT(ul.id)::int AS turn_count,
            COALESCE(
                jsonb_agg(DISTINCT ul.model) FILTER (WHERE ul.model IS NOT NULL),
                '[]'::jsonb
            ) AS models
        FROM date_series ds
        LEFT JOIN usage_ledger ul 
            ON DATE(ul.created_at) = ds.day 
            AND ul.user_id = p_user_id
        GROUP BY ds.day
        ORDER BY ds.day ASC
    ),
    overall_summary AS (
        SELECT 
            COALESCE(SUM(cost_usd), 0)::numeric(12, 6) AS total_cost_usd,
            COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
            COALESCE(SUM(turn_count), 0)::int AS total_turns
        FROM daily_agg
    )
    SELECT jsonb_build_object(
        'days', p_days,
        'total_cost_usd', s.total_cost_usd,
        'total_tokens', s.total_tokens,
        'total_turns', s.total_turns,
        'series', (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'date', to_char(d.day, 'YYYY-MM-DD'),
                    'cost_usd', d.cost_usd,
                    'total_tokens', d.total_tokens,
                    'prompt_tokens', d.prompt_tokens,
                    'completion_tokens', d.completion_tokens,
                    'turn_count', d.turn_count,
                    'models', d.models
                )
            ) FROM daily_agg d
        )
    ) INTO v_result
    FROM overall_summary s;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_user_daily_usage TO service_role;
