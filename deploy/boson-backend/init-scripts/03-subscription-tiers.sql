-- ============================================================
-- MIGRATION: UNIVERSAL SUBSCRIPTION TIERS & ZERO-COST FREE MODELS
-- ============================================================

-- 1. Buat Tabel Aturan Tier Langganan & Model Access
CREATE TABLE IF NOT EXISTS public.tier_rules (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    price_usd NUMERIC(10, 2) DEFAULT 0.00,
    allowed_models TEXT[] NOT NULL DEFAULT '{"*"}',
    zero_cost_models TEXT[] NOT NULL DEFAULT '{}',
    max_concurrent_streams INT NOT NULL DEFAULT 2,
    max_rpm INT NOT NULL DEFAULT 15,
    is_active BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Pastikan kolom tier ada di tabel wallets
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS tier VARCHAR(50) DEFAULT 'free';
CREATE INDEX IF NOT EXISTS idx_wallets_tier ON public.wallets(tier);

-- 3. Isi Data Standar Tiering (Dapat diubah kapan saja via Supabase UI atau API)
INSERT INTO public.tier_rules (id, name, price_usd, allowed_models, zero_cost_models, max_concurrent_streams, max_rpm, is_active, description)
VALUES 
    (
        'free', 
        'Free Community Tier', 
        0.00, 
        '{"deepseek-flash", "gemini-2.5-flash", "gemini-2.0-flash", "llama-3.3-70b-free"}', 
        '{"gemini-2.5-flash", "gemini-2.0-flash", "llama-3.3-70b-free"}', 
        2, 
        15, 
        true, 
        'Tier gratis tanpa biaya. Model yang ada di zero_cost_models tidak memotong saldo.'
    ),
    (
        'lite', 
        'Developer Lite', 
        4.99, 
        '{"deepseek-flash", "gemini-2.5-flash", "gemini-2.0-flash", "gpt-4o-mini", "llama-3.3-70b-free"}', 
        '{"gemini-2.5-flash", "gemini-2.0-flash", "llama-3.3-70b-free"}', 
        5, 
        30, 
        true, 
        'Paket pengembang pemula dengan akses model mini cepat.'
    ),
    (
        'plus', 
        'Creator Plus', 
        9.99, 
        '{"deepseek-flash", "deepseek-chat", "gemini-2.5-flash", "gpt-4o-mini", "claude-3-5-haiku", "llama-3.3-70b-free"}', 
        '{"gemini-2.5-flash", "gemini-2.0-flash", "llama-3.3-70b-free"}', 
        10, 
        60, 
        true, 
        'Paket standar untuk kreator konten dan asisten AI harian.'
    ),
    (
        'pro', 
        'Agentic Pro (Paling Populer)', 
        14.99, 
        '{"deepseek-flash", "deepseek-chat", "deepseek-reasoner", "claude-3-5-sonnet", "gpt-4o", "gemini-2.5-flash", "llama-3.3-70b-free"}', 
        '{"gemini-2.5-flash", "gemini-2.0-flash", "llama-3.3-70b-free"}', 
        15, 
        120, 
        true, 
        'Paket profesional dengan akses model penalaran tinggi (R1, Sonnet, GPT-4o).'
    ),
    (
        'max', 
        'Power Max', 
        29.99, 
        '{"*"}', 
        '{"gemini-2.5-flash", "gemini-2.0-flash", "llama-3.3-70b-free"}', 
        25, 
        300, 
        true, 
        'Paket daya penuh tanpa batasan model dengan prioritas antrean tinggi.'
    ),
    (
        'enterprise', 
        'Custom Enterprise', 
        99.00, 
        '{"*"}', 
        '{"*"}', 
        100, 
        1000, 
        true, 
        'Paket skala besar enterprise dengan batas kustom dan SLA khusus.'
    )
ON CONFLICT (id) DO UPDATE SET 
    name = EXCLUDED.name,
    price_usd = EXCLUDED.price_usd,
    allowed_models = EXCLUDED.allowed_models,
    zero_cost_models = EXCLUDED.zero_cost_models,
    max_concurrent_streams = EXCLUDED.max_concurrent_streams,
    max_rpm = EXCLUDED.max_rpm,
    is_active = EXCLUDED.is_active,
    description = EXCLUDED.description,
    updated_at = NOW();

-- 4. Beri akses service_role & anon
GRANT ALL ON TABLE public.tier_rules TO service_role;
GRANT SELECT ON TABLE public.tier_rules TO anon, authenticated;
