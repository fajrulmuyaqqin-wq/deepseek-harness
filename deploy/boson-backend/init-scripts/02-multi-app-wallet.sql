-- ============================================================
-- MIGRATION: UNIVERSAL WALLET & MULTI-APP SAAS SUPPORT
-- ============================================================

-- 1. Tambahkan kolom app_id ke usage_ledger jika belum ada
ALTER TABLE public.usage_ledger ADD COLUMN IF NOT EXISTS app_id VARCHAR(50);
UPDATE public.usage_ledger SET app_id = COALESCE(platform_id, 'boson-studio') WHERE app_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_usage_ledger_app_id ON public.usage_ledger(app_id);

-- 2. Tambahkan kolom target_app_id ke api_keys agar API Key bisa di-scope ke app tertentu atau universal
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS target_app_id VARCHAR(50) DEFAULT '*';

-- 3. Daftarkan aplikasi-aplikasi SaaS standar ke allowed_platforms
INSERT INTO public.allowed_platforms (id, name, allowed_models, max_concurrent_streams, is_active)
VALUES 
    ('boson-studio', 'Boson Studio Coding Assistant', '{"*"}', 5, true),
    ('ai-content', 'AI Content & Copywriting SaaS', '{"deepseek-chat","deepseek-flash","claude-3-5-sonnet","gpt-4o"}', 5, true),
    ('customer-bot', 'WhatsApp/Telegram AI Customer Bot', '{"deepseek-flash","deepseek-chat"}', 10, true),
    ('seo-generator', 'AI SEO & Article Generator', '{"deepseek-chat","deepseek-reasoner","gpt-4o"}', 5, true),
    ('data-analyst', 'AI Data & SQL Analyst', '{"deepseek-reasoner","deepseek-v4-pro","claude-3-5-sonnet"}', 3, true)
ON CONFLICT (id) DO UPDATE SET 
    name = EXCLUDED.name,
    allowed_models = EXCLUDED.allowed_models,
    is_active = EXCLUDED.is_active;

-- 4. Update atomic_debit_wallet agar menyimpan app_id dan platform_id secara serentak
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
    v_app_id TEXT := COALESCE(p_platform_id, 'boson-studio');
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

    -- 6. Catat langsung ke usage_ledger dalam satu transaksi (isi platform_id dan app_id)
    INSERT INTO public.usage_ledger (
        user_id, platform_id, app_id, model, prompt_tokens, completion_tokens,
        total_tokens, cost_usd, deducted_from, metadata
    ) VALUES (
        p_user_id, v_app_id, v_app_id, p_model, p_prompt_tokens, p_completion_tokens,
        p_prompt_tokens + p_completion_tokens, p_cost, v_deducted_from, p_metadata
    );

    RETURN jsonb_build_object(
        'success', true,
        'app_id', v_app_id,
        'deducted_from', v_deducted_from,
        'bonus_balance', v_bonus,
        'subscription_balance', v_subs,
        'normal_balance', v_norm,
        'cost_usd', p_cost
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.atomic_debit_wallet TO service_role;

-- 5. Fungsi SQL Agregasi Penggunaan Saldo Berdasarkan Aplikasi (Multi-App Breakdown)
CREATE OR REPLACE FUNCTION public.get_user_usage_by_app(p_user_id UUID, p_days INT DEFAULT 30)
RETURNS JSONB AS $$
DECLARE
    v_total_spent NUMERIC := 0;
    v_wallet RECORD;
    v_apps JSONB;
BEGIN
    -- Ambil sisa saldo saat ini
    SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id;
    
    -- Hitung total pengeluaran dalam rentang waktu
    SELECT COALESCE(SUM(cost_usd), 0) INTO v_total_spent
    FROM public.usage_ledger
    WHERE user_id = p_user_id 
      AND created_at >= (NOW() - (p_days || ' days')::interval);

    -- Agregasi per aplikasi
    SELECT COALESCE(jsonb_agg(sub), '[]'::jsonb) INTO v_apps
    FROM (
        SELECT 
            t.app_id,
            COALESCE(p.name, t.app_id, 'Unknown App') AS app_name,
            COUNT(*)::INT AS total_requests,
            COALESCE(SUM(t.prompt_tokens), 0)::INT AS prompt_tokens,
            COALESCE(SUM(t.completion_tokens), 0)::INT AS completion_tokens,
            COALESCE(SUM(t.total_tokens), 0)::INT AS total_tokens,
            ROUND(COALESCE(SUM(t.cost_usd), 0), 6)::NUMERIC AS total_cost_usd,
            CASE 
                WHEN v_total_spent > 0 THEN ROUND((COALESCE(SUM(t.cost_usd), 0) / v_total_spent) * 100, 2)
                ELSE 0.00
            END AS percentage_of_spent
        FROM (
            SELECT 
                COALESCE(app_id, platform_id, 'unspecified') AS app_id,
                prompt_tokens,
                completion_tokens,
                total_tokens,
                cost_usd
            FROM public.usage_ledger
            WHERE user_id = p_user_id
              AND created_at >= (NOW() - (p_days || ' days')::interval)
        ) t
        LEFT JOIN public.allowed_platforms p ON p.id = t.app_id
        GROUP BY t.app_id, p.name
        ORDER BY total_cost_usd DESC
    ) sub;

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'days_window', p_days,
        'current_balance', jsonb_build_object(
            'total', COALESCE(v_wallet.bonus_balance, 0) + COALESCE(v_wallet.subscription_balance, 0) + COALESCE(v_wallet.normal_balance, 0),
            'bonus', COALESCE(v_wallet.bonus_balance, 0),
            'subscription', COALESCE(v_wallet.subscription_balance, 0),
            'normal', COALESCE(v_wallet.normal_balance, 0),
            'currency', 'USD'
        ),
        'total_spent_window_usd', v_total_spent,
        'apps_breakdown', v_apps
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_user_usage_by_app TO service_role;
