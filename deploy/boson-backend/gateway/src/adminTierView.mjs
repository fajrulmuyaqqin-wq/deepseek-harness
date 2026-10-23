// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: VISUAL ADMIN DASHBOARD (TIER & MODEL MANAGEMENT)
// Antarmuka visual web admin untuk:
// 1. Mengatur harga paket langganan (Free, Lite, Plus, Pro, Max, Enterprise)
// 2. Mengaktifkan / menonaktifkan model gratis (Zero-Cost Toggle)
// 3. Mengatur batasan RPM dan konkurensi stream
// 4. Menambah tier baru secara dinamis tanpa sentuh SQL/terminal
// ─────────────────────────────────────────────────────────────

export function renderAdminTierDashboardHtml(platformPublicUrl) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Boson Studio — Tier & Model Admin Control Center</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(17, 24, 39, 0.85);
      --card-border: rgba(31, 41, 61, 0.8);
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --primary-glow: rgba(56, 189, 248, 0.25);
      --accent: #6366f1;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.25);
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(56, 189, 248, 0.1) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(99, 102, 241, 0.1) 0px, transparent 50%);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
      padding-bottom: 5rem;
    }
    code, pre, .mono { font-family: 'JetBrains Mono', monospace; }

    /* Navbar */
    .navbar {
      background: rgba(17, 24, 39, 0.9);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--card-border);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      text-decoration: none;
      color: var(--text);
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #38bdf8, #6366f1);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 1.2rem;
      color: white;
      box-shadow: 0 4px 14px var(--primary-glow);
    }
    .brand-title {
      font-weight: 700;
      font-size: 1.15rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .brand-badge {
      font-size: 0.7rem;
      padding: 0.15rem 0.5rem;
      border-radius: 9999px;
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #a5b4fc;
      font-weight: 600;
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .btn {
      padding: 0.55rem 1.15rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.2s ease;
      text-decoration: none;
      border: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--primary), var(--accent));
      color: white;
      box-shadow: 0 4px 12px var(--primary-glow);
    }
    .btn-primary:hover {
      opacity: 0.95;
      transform: translateY(-1px);
    }
    .btn-outline {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text);
    }
    .btn-outline:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .btn-sm {
      padding: 0.35rem 0.75rem;
      font-size: 0.8rem;
    }

    /* Container */
    .container {
      max-width: 1280px;
      margin: 2rem auto;
      padding: 0 1.5rem;
    }

    /* Header Banner */
    .page-header {
      margin-bottom: 2rem;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .page-header h1 {
      font-size: 1.85rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .page-header p {
      color: var(--text-muted);
      margin-top: 0.25rem;
      font-size: 0.95rem;
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1.25rem;
      backdrop-filter: blur(10px);
    }
    .stat-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }
    .stat-val {
      font-size: 1.75rem;
      font-weight: 800;
      margin-top: 0.4rem;
      color: var(--primary);
    }
    .stat-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }

    /* Tiers Grid */
    .tiers-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 1.5rem;
    }
    .tier-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: all 0.25s ease;
      backdrop-filter: blur(12px);
    }
    .tier-card:hover {
      border-color: rgba(56, 189, 248, 0.4);
      transform: translateY(-2px);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }
    .tier-card.inactive {
      opacity: 0.6;
      border-style: dashed;
    }
    .tier-badge {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: rgba(56, 189, 248, 0.15);
      color: var(--primary);
      margin-bottom: 0.75rem;
      width: fit-content;
    }
    .tier-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }
    .tier-name {
      font-size: 1.25rem;
      font-weight: 700;
    }
    .tier-price {
      font-size: 1.35rem;
      font-weight: 800;
      color: #38bdf8;
    }
    .tier-price span {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-muted);
    }
    .tier-desc {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 1.25rem;
      min-height: 2.5rem;
    }

    .tier-meta-row {
      display: flex;
      gap: 1rem;
      padding: 0.75rem 0;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      margin-bottom: 1.25rem;
    }
    .tier-meta-item {
      flex: 1;
    }
    .tier-meta-label {
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
    }
    .tier-meta-val {
      font-size: 0.95rem;
      font-weight: 700;
      margin-top: 0.2rem;
    }

    .section-subtitle {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }

    .tags-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-bottom: 1.25rem;
    }
    .tag {
      font-size: 0.75rem;
      padding: 0.2rem 0.55rem;
      border-radius: 6px;
      font-weight: 500;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
    }
    .tag-free {
      background: rgba(16, 185, 129, 0.15);
      border-color: rgba(16, 185, 129, 0.35);
      color: #34d399;
      font-weight: 600;
    }

    .tier-footer {
      margin-top: auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 1rem;
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 1000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .modal-backdrop.open {
      display: flex;
    }
    .modal-content {
      background: #111827;
      border: 1px solid var(--card-border);
      border-radius: 16px;
      width: 100%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
      padding: 2rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }
    .modal-header h3 {
      font-size: 1.35rem;
      font-weight: 700;
    }
    .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      color: var(--text-muted);
      cursor: pointer;
    }

    .form-group {
      margin-bottom: 1.25rem;
    }
    .form-label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 0.4rem;
      color: var(--text);
    }
    .form-input, .form-textarea {
      width: 100%;
      padding: 0.65rem 0.85rem;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      color: white;
      font-size: 0.9rem;
      font-family: inherit;
      outline: none;
    }
    .form-input:focus, .form-textarea:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 2px var(--primary-glow);
    }
    .form-grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    .checkbox-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 0.5rem;
      background: rgba(0, 0, 0, 0.25);
      padding: 0.75rem;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      max-height: 180px;
      overflow-y: auto;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.8rem;
      cursor: pointer;
      color: #cbd5e1;
    }
    .checkbox-label input {
      accent-color: var(--primary);
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: #1e293b;
      border: 1px solid var(--success);
      color: #34d399;
      padding: 0.85rem 1.5rem;
      border-radius: 10px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      z-index: 2000;
      display: none;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
      font-size: 0.9rem;
      animation: slideIn 0.3s ease;
    }
    @keyframes slideIn {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>

  <!-- Navbar -->
  <nav class="navbar">
    <a href="/admin/tiers" class="brand">
      <div class="brand-logo">B</div>
      <div>
        <div class="brand-title">Boson Studio <span class="brand-badge">ADMIN CONTROL</span></div>
      </div>
    </a>
    <div class="nav-actions">
      <button class="btn btn-outline btn-sm" onclick="configureAdminKey()" title="Atur Master Admin Key / API Key">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
        <span id="keyLabel">Admin Key (sk-admin)</span>
      </button>
      <a href="/billing" class="btn btn-outline btn-sm" target="_blank">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
        Buka Portal User
      </a>
      <button class="btn btn-primary btn-sm" onclick="openCreateModal()">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
        Tambah Tier Baru
      </button>
    </div>
  </nav>

  <!-- Container -->
  <div class="container">
    <div class="page-header">
      <div>
        <h1>Manajemen Tier Langganan & Model Access</h1>
        <p>Kontrol terpusat untuk menetapkan harga paket, batasan RPM, serta menggratiskan model AI secara realtime.</p>
      </div>
      <div>
        <button class="btn btn-outline btn-sm" onclick="fetchTiers()">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          Refresh Data
        </button>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Tier Terdaftar</div>
        <div class="stat-val" id="stat-total-tiers">0</div>
        <div class="stat-desc">Paket aktif & publik</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Model Gratisan Terbanyak</div>
        <div class="stat-val" id="stat-free-models">3</div>
        <div class="stat-desc">Zero-Cost Models aktif</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Router Status</div>
        <div class="stat-val" style="color: #34d399; font-size: 1.4rem;">ONLINE</div>
        <div class="stat-desc">LiteLLM + Failover Active</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Status Gateway</div>
        <div class="stat-val" style="color: #34d399; font-size: 1.4rem;">HTTPS SECURE</div>
        <div class="stat-desc">Cloudflare Tunnel Active</div>
      </div>
    </div>

    <!-- Tiers Grid -->
    <div class="tiers-grid" id="tiers-container">
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--text-muted);">
        Memuat data paket langganan...
      </div>
    </div>
  </div>

  <!-- Edit Tier Modal -->
  <div class="modal-backdrop" id="editModal">
    <div class="modal-content">
      <div class="modal-header">
        <h3 id="modalTitle">Edit Konfigurasi Tier</h3>
        <button class="close-btn" onclick="closeModal()">&times;</button>
      </div>
      <form id="tierForm" onsubmit="handleSaveTier(event)">
        <input type="hidden" id="form-tier-id">

        <div class="form-group" id="group-id-input" style="display:none;">
          <label class="form-label">ID / Slug Tier (contoh: "starter", "team")</label>
          <input type="text" class="form-input mono" id="form-id-val" placeholder="starter">
        </div>

        <div class="form-group">
          <label class="form-label">Nama Paket (Display Name)</label>
          <input type="text" class="form-input" id="form-name" required placeholder="Agentic Pro">
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Harga Bulanan (USD $)</label>
            <input type="number" step="0.01" class="form-input" id="form-price" required value="0.00">
          </div>
          <div class="form-group">
            <label class="form-label">Maksimal Concurrent Stream</label>
            <input type="number" class="form-input" id="form-streams" required value="5">
          </div>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Batas Kecepatan (Max RPM)</label>
            <input type="number" class="form-input" id="form-rpm" required value="60">
          </div>
          <div class="form-group" style="display: flex; align-items: center; gap: 0.5rem; margin-top: 1.8rem;">
            <input type="checkbox" id="form-active" style="width: 18px; height: 18px; accent-color: var(--primary);">
            <label for="form-active" class="form-label" style="margin-bottom: 0; cursor: pointer;">Status Tier Aktif</label>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Deskripsi Paket</label>
          <textarea class="form-textarea" id="form-desc" rows="2" placeholder="Keterangan singkat target pengguna..."></textarea>
        </div>

        <!-- Allowed Models -->
        <div class="form-group">
          <label class="form-label">Model yang Diizinkan (Allowed Models)</label>
          <div class="checkbox-grid" id="allowed-models-list">
            <!-- Injected via JS -->
          </div>
        </div>

        <!-- Zero Cost Models -->
        <div class="form-group">
          <label class="form-label" style="color: #34d399; display: flex; align-items: center; gap: 0.4rem;">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
            Model Gratisan (Zero-Cost Toggle — Bebas Biaya Token)
          </label>
          <div class="checkbox-grid" id="zero-cost-models-list" style="border-color: rgba(16, 185, 129, 0.3);">
            <!-- Injected via JS -->
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 2rem;">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Batal</button>
          <button type="submit" class="btn btn-primary" id="saveBtn">Simpan Perubahan</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toastMsg">
    <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
    <span id="toastText">Konfigurasi berhasil disimpan!</span>
  </div>

  <script>
    const AVAILABLE_MODELS = [
      'deepseek-flash',
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-pro',
      'claude-3-5-sonnet',
      'claude-3-5-haiku',
      'gpt-4o',
      'gpt-4o-mini',
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'llama-3.3-70b-free',
      '*'
    ];

    let currentTiers = [];
    let isCreateMode = false;

    // Ambil auth token dari localStorage atau default
    function getAuthToken() {
      let token = localStorage.getItem('boson_admin_key');
      if (!token) {
        token = 'sk-admin'; // Master fallback
        localStorage.setItem('boson_admin_key', token);
      }
      const label = document.getElementById('keyLabel');
      if (label) {
        label.innerText = token === 'sk-admin' ? 'Admin Key (sk-admin)' : 'Key: ' + token.slice(0, 10) + '...';
      }
      return token;
    }

    function configureAdminKey() {
      const current = getAuthToken();
      const val = prompt('Masukkan Master Admin Key atau Boson Personal API Key:', current);
      if (val !== null && val.trim()) {
        localStorage.setItem('boson_admin_key', val.trim());
        getAuthToken();
        showToast('Admin Key berhasil disimpan!');
        fetchTiers();
      }
    }

    async function fetchTiers() {
      try {
        const token = getAuthToken();
        const res = await fetch('/api/v0/tiers', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();
        if (data.success && data.tiers) {
          currentTiers = data.tiers;
          renderTiers(currentTiers);
        } else {
          document.getElementById('tiers-container').innerHTML = '<div style="color:var(--danger); text-align:center; padding:2rem;">Gagal memuat tier: ' + (data.error || 'Akses ditolak') + '</div>';
        }
      } catch (err) {
        document.getElementById('tiers-container').innerHTML = '<div style="color:var(--danger); text-align:center; padding:2rem;">Koneksi error: ' + err.message + '</div>';
      }
    }

    function renderTiers(tiers) {
      document.getElementById('stat-total-tiers').innerText = tiers.length;
      
      let maxZeroCost = 0;
      tiers.forEach(t => {
        if (t.zero_cost_models && t.zero_cost_models.length > maxZeroCost) {
          maxZeroCost = t.zero_cost_models.length;
        }
      });
      document.getElementById('stat-free-models').innerText = maxZeroCost;

      const container = document.getElementById('tiers-container');
      container.innerHTML = tiers.map(tier => {
        const isFree = Number(tier.price_usd) === 0;
        const allowed = tier.allowed_models || [];
        const zeroCost = tier.zero_cost_models || [];

        return \`
          <div class="tier-card \${tier.is_active ? '' : 'inactive'}">
            <div>
              <span class="tier-badge mono">\${tier.id}</span>
              <div class="tier-title-row">
                <div class="tier-name">\${tier.name}</div>
                <div class="tier-price">\${isFree ? 'FREE' : '$' + tier.price_usd} <span>\${isFree ? '' : '/bln'}</span></div>
              </div>
              <div class="tier-desc">\${tier.description || 'Tidak ada deskripsi.'}</div>
            </div>

            <div class="tier-meta-row">
              <div class="tier-meta-item">
                <div class="tier-meta-label">Max Concurrency</div>
                <div class="tier-meta-val">\${tier.max_concurrent_streams} Streams</div>
              </div>
              <div class="tier-meta-item">
                <div class="tier-meta-label">Speed Limit</div>
                <div class="tier-meta-val">\${tier.max_rpm} RPM</div>
              </div>
              <div class="tier-meta-item">
                <div class="tier-meta-label">Status</div>
                <div class="tier-meta-val" style="color: \${tier.is_active ? '#34d399' : '#94a3b8'}">\${tier.is_active ? 'Active' : 'Inactive'}</div>
              </div>
            </div>

            <div>
              <div class="section-subtitle">Model yang Didukung:</div>
              <div class="tags-container">
                \${allowed.map(m => \`<span class="tag mono">\${m}</span>\`).join('')}
              </div>

              <div class="section-subtitle" style="color: #34d399;">Model Bebas Biaya (Zero Cost):</div>
              <div class="tags-container">
                \${zeroCost.length > 0 
                  ? zeroCost.map(m => \`<span class="tag tag-free mono">✨ \${m}</span>\`).join('') 
                  : '<span style="font-size:0.75rem; color:var(--text-muted);">Tidak ada (semua potong saldo)</span>'}
              </div>
            </div>

            <div class="tier-footer">
              <button class="btn btn-outline btn-sm" onclick="openEditModal('\${tier.id}')">
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                Edit Konfigurasi
              </button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderCheckboxes(containerId, selectedArray, prefix) {
      const container = document.getElementById(containerId);
      container.innerHTML = AVAILABLE_MODELS.map(model => {
        const isChecked = selectedArray.includes(model);
        const inputId = prefix + '-' + model.replace(/[^a-zA-Z0-9]/g, '_');
        return \`
          <label class="checkbox-label" for="\${inputId}">
            <input type="checkbox" id="\${inputId}" value="\${model}" \${isChecked ? 'checked' : ''}>
            <span class="mono">\${model}</span>
          </label>
        \`;
      }).join('');
    }

    function openEditModal(tierId) {
      isCreateMode = false;
      const tier = currentTiers.find(t => t.id === tierId);
      if (!tier) return;

      document.getElementById('modalTitle').innerText = 'Edit Konfigurasi Tier: ' + tier.name;
      document.getElementById('group-id-input').style.display = 'none';
      document.getElementById('form-tier-id').value = tier.id;
      document.getElementById('form-name').value = tier.name;
      document.getElementById('form-price').value = tier.price_usd;
      document.getElementById('form-streams').value = tier.max_concurrent_streams;
      document.getElementById('form-rpm').value = tier.max_rpm;
      document.getElementById('form-active').checked = tier.is_active;
      document.getElementById('form-desc').value = tier.description || '';

      renderCheckboxes('allowed-models-list', tier.allowed_models || [], 'allow');
      renderCheckboxes('zero-cost-models-list', tier.zero_cost_models || [], 'zero');

      document.getElementById('editModal').classList.add('open');
    }

    function openCreateModal() {
      isCreateMode = true;
      document.getElementById('modalTitle').innerText = 'Tambah Tier Langganan Baru';
      document.getElementById('group-id-input').style.display = 'block';
      document.getElementById('form-id-val').value = '';
      document.getElementById('form-name').value = '';
      document.getElementById('form-price').value = '19.99';
      document.getElementById('form-streams').value = '10';
      document.getElementById('form-rpm').value = '100';
      document.getElementById('form-active').checked = true;
      document.getElementById('form-desc').value = '';

      renderCheckboxes('allowed-models-list', ['*'], 'allow');
      renderCheckboxes('zero-cost-models-list', ['gemini-2.0-flash'], 'zero');

      document.getElementById('editModal').classList.add('open');
    }

    function closeModal() {
      document.getElementById('editModal').classList.remove('open');
    }

    async function handleSaveTier(e) {
      e.preventDefault();
      const saveBtn = document.getElementById('saveBtn');
      saveBtn.innerText = 'Menyimpan...';
      saveBtn.disabled = true;

      // Kumpulkan model yang dipilih
      const allowedModels = [];
      document.querySelectorAll('#allowed-models-list input:checked').forEach(el => allowedModels.push(el.value));

      const zeroCostModels = [];
      document.querySelectorAll('#zero-cost-models-list input:checked').forEach(el => zeroCostModels.push(el.value));

      const payload = {
        name: document.getElementById('form-name').value,
        price_usd: parseFloat(document.getElementById('form-price').value),
        max_concurrent_streams: parseInt(document.getElementById('form-streams').value),
        max_rpm: parseInt(document.getElementById('form-rpm').value),
        is_active: document.getElementById('form-active').checked,
        description: document.getElementById('form-desc').value,
        allowed_models: allowedModels.length > 0 ? allowedModels : ['*'],
        zero_cost_models: zeroCostModels,
      };

      try {
        const token = getAuthToken();
        let res;

        if (isCreateMode) {
          payload.id = document.getElementById('form-id-val').value.trim().toLowerCase();
          res = await fetch('/api/v0/tiers', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(payload)
          });
        } else {
          const tierId = document.getElementById('form-tier-id').value;
          res = await fetch('/api/v0/tiers/' + tierId, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(payload)
          });
        }

        const data = await res.json();
        if (data.success) {
          closeModal();
          showToast(data.message || 'Tier berhasil disimpan!');
          await fetchTiers();
        } else {
          alert('Error: ' + (data.error || 'Gagal menyimpan tier.'));
        }
      } catch (err) {
        alert('Gagal menghubungi server: ' + err.message);
      } finally {
        saveBtn.innerText = 'Simpan Perubahan';
        saveBtn.disabled = false;
      }
    }

    function showToast(text) {
      const toast = document.getElementById('toastMsg');
      document.getElementById('toastText').innerText = text;
      toast.style.display = 'flex';
      setTimeout(() => {
        toast.style.display = 'none';
      }, 3500);
    }

    // Load pertama kali
    fetchTiers();
  </script>
</body>
</html>
`;
}
