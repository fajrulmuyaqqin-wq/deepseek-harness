# 🏛️ Cetak Biru Arsitektur, Panduan Setup, & Strategi Skalabilitas: Boson Backend

Dokumen ini adalah panduan teknis komprehensif (*Master Architectural & Scaling Blueprint*) untuk sistem **Boson Backend**. Dokumen ini merinci setiap lapisan arsitektur, panduan instalasi dan deployment ke server produksi, serta strategi peningkatan kapasitas (*scaling roadmap*) dari tahap awal hingga melayani ratusan ribu pengguna aktif.

---

## DAFTAR ISI
1. [Arsitektur Sistem & Prinsip Desain](#1-arsitektur-sistem--prinsip-desain)
2. [Pembedahan Setiap Lapisan (Deep-Dive Component Layers)](#2-pembedahan-setiap-lapisan-deep-dive-component-layers)
   - [Lapisan 1: Client & Ingress Tier](#lapisan-1-client--ingress-tier)
   - [Lapisan 2: Control Plane & Gateway Tier (boson-gateway)](#lapisan-2-control-plane--gateway-tier-boson-gateway)
   - [Lapisan 3: AI Inference & Smart Router Tier (boson-litellm)](#lapisan-3-ai-inference--smart-router-tier-boson-litellm)
   - [Lapisan 4: Data & Wallet Ledger Tier (boson-db & Supabase)](#lapisan-4-data--wallet-ledger-tier-boson-db--supabase)
3. [Panduan Setup & Deployment Server Produksi](#3-panduan-setup--deployment-server-produksi)
   - [Prasyarat Hardware & Sistem Operasi](#prasyarat-hardware--sistem-operasi)
   - [Konfigurasi Environment (.env)](#konfigurasi-environment-env)
   - [Deployment dengan Docker Compose](#deployment-dengan-docker-compose)
   - [Konfigurasi Domain & HTTPS Otomatis (Caddy)](#konfigurasi-domain--https-otomatis-caddy)
   - [Pengujian Verifikasi End-to-End](#pengujian-verifikasi-end-to-end)
4. [Strategi Skalabilitas (Scaling Roadmap: 100 s.d. 100.000+ Pengguna)](#4-strategi-skalabilitas-scaling-roadmap-100-sd-100000-pengguna)
   - [Fase 1: Optimasi Single-VPS (100 – 1.000 DAU)](#fase-1-optimasi-single-vps-100--1000-dau)
   - [Fase 2: Pemisahan Database & Replikasi Gateway (1.000 – 10.000 DAU)](#fase-2-pemisahan-database--replikasi-gateway-1000--10000-dau)
   - [Fase 3: Arsitektur Terdistribusi & Multi-Region (> 10.000 DAU)](#fase-3-arsitektur-terdistribusi--multi-region--10000-dau)
5. [Runbook Pemeliharaan, Backup, & Penanganan Insiden](#5-runbook-pemeliharaan-backup--penanganan-insiden)

---

## 1. Arsitektur Sistem & Prinsip Desain

Boson Backend dirancang menggunakan filosofi **Local-First Agentic Client** dipadukan dengan **Centralized Control & Monetization Plane**. 

Beban komputasi berat (seperti pembacaan file lokal, manipulasi workspace, terminal/bash execution, dan loop agent) dilakukan di perangkat pengguna (Boson Desktop / CLI). Server VPS Anda bertindak sebagai **"The Cash Register & Smart AI Highway"** yang mengurus otentikasi, perizinan platform, pemotongan kuota/saldo, failover model, dan agregasi keuntungan SaaS.

### Diagram Arsitektur End-to-End

```mermaid
flowchart TD
    subgraph ClientTier ["1. Client & Multi-Platform Tier"]
        Desktop["Boson Studio (Desktop / Electron)"]
        WebClient["Boson Studio Web (PWA)"]
        CLI["Boson CLI & Scripting Tools"]
        VSCode["Boson VSCode Extension"]
    end

    subgraph EdgeTier ["2. Ingress & Security Edge"]
        Caddy["Caddy Reverse Proxy (HTTPS / Let's Encrypt)"]
    end

    subgraph ControlTier ["3. Boson Control Plane (:8080)"]
        AuthResolver["Dual Auth: Supabase JWT / Google SSO / SHA-256 API Key"]
        PlatformGuard["Platform Allowlist & Concurrency Check"]
        PreFlight["Pre-Flight Quota Guard (Balance > $0.0005)"]
        ProtocolEngine["Dual Protocol: OpenAI (/v1/chat) & Anthropic (/v1/messages)"]
        PricingEngine["Dynamic Margin Engine (+15% markup live)"]
        BillingPortal["User Billing & Top-Up Portal (:8088/billing)"]
    end

    subgraph RouterTier ["4. Smart Model Router (:4000)"]
        LiteLLM["LiteLLM Proxy Core"]
        CircuitBreaker["Circuit Breaker & Cooldown Manager"]
        FallbackEngine["Fallback Hierarchy (DeepSeek -> Gemini -> OpenRouter)"]
        TokenExtractor["Usage & Cached-Tokens Extractor"]
    end

    subgraph PersistenceTier ["5. Data & Identity Tier (:5432 / Supabase)"]
        Postgres["PostgreSQL 15 (WAL Enabled)"]
        GoTrue["Supabase GoTrue (Auth Daemon)"]
        PostgREST["PostgREST (Auto-REST API)"]
        StudioUI["Supabase Studio (Admin Dashboard :3001)"]
        Wallets["Multi-Bucket Wallet Ledger (Bonus, Subs, Normal)"]
    end

    subgraph UpstreamProviders ["6. AI Inference Providers"]
        DeepSeek["DeepSeek API (V3 & R1)"]
        Gemini["Google Gemini (Flash & Pro)"]
        Anthropic["Anthropic Claude API"]
        OpenRouter["OpenRouter (940+ Models)"]
    end

    subgraph PaymentGateways ["7. External Payment"]
        Xendit["Xendit (QRIS, BCA VA, Mandiri VA, E-Wallet)"]
    end

    %% Relasi Alur
    ClientTier -->|HTTPS / WSS / SSE| Caddy
    Caddy -->|Internal Port 8080| ControlTier
    ControlTier <-->|SQL Queries / RLS| PersistenceTier
    ControlTier -->|Internal Proxy Port 4000| RouterTier
    ControlTier <-->|Webhooks & Invoices| PaymentGateways
    RouterTier -->|Circuit Breaker & Fallback| UpstreamProviders
```

---

## 2. Pembedahan Setiap Lapisan (Deep-Dive Component Layers)

### Lapisan 1: Client & Ingress Tier
* **Caddy Web Server:**
  * Menangani terminasi SSL/TLS secara otomatis via Let's Encrypt.
  * Meneruskan traffic ke `boson-gateway` pada port `8080` dan `boson-studio` pada port `3001`.
  * Mengompresi response dengan Gzip/Zstandard dan mendukung streaming Server-Sent Events (SSE) tanpa buffering timeout (`flush_interval -1`).
* **Multi-Platform Access:**
  * Setiap request menyertakan header platform: `X-Boson-Platform-Id: boson-desktop` (atau `vscode-extension`, `boson-cli`).
  * Memungkinkan satu akun pengguna mengakses saldo yang sama dari berbagai aplikasi yang Anda izinkan.

### Lapisan 2: Control Plane & Gateway Tier (`boson-gateway`)
Terletak pada direktori `gateway/src/`, lapisan ini adalah inti dari aturan bisnis Anda:
1. **Dual Auth Resolver:**
   * Mendukung sesi browser/desktop via OAuth2 PKCE token JWT GoTrue.
   * Mendukung Google One-Tap SSO via `googleAuthIntegration.mjs`.
   * Mendukung Personal Access Token *Headless* (`sk_boson_...`) yang disimpan menggunakan hash SHA-256 (Zero-Trust: server tidak menyimpan plaintext API key).
2. **Platform Allowlist & Concurrency Guard:**
   * Memvalidasi apakah aplikasi pengirim terdaftar di tabel `allowed_platforms`.
   * Membatasi jumlah *concurrent streaming* (misal: Desktop maks 3 stream, CLI maks 1 stream) untuk mencegah eksploitasi sharing akun.
3. **Pre-Flight Quota Guard:**
   * Sebelum meneruskan request ke model AI yang mahal, gateway memeriksa:
     $$\text{Total Saldo} = \text{Bonus Balance} + \text{Subscription Balance} + \text{Normal Balance} > \$0.0005$$
   * Jika saldo habis, gateway langsung melempar error `HTTP 402 Payment Required` dalam waktu $< 2\text{ ms}$, melindungi Anda dari pembengkakan tagihan API.
4. **Dual Engine Protocol Parser:**
   * Menerima format OpenAI (`/v1/chat/completions`) maupun format Anthropic (`/v1/messages`).
   * Menstandarkan parsing streaming SSE, menghitung token masuk/keluar, dan mengekstrak token yang ter-cache.
5. **Live Dynamic Pricing (+15% Markup Margin):**
   * Secara periodik mensinkronisasi daftar harga dari OpenRouter untuk 940+ model via `pricingSync.mjs`.
   * Menghitung biaya modal riil lalu menambahkan margin laba bersih +15% ke saldo pengguna.
6. **Billing & Payment Portal:**
   * Menyajikan dashboard web pengguna di `/billing` (`billingView.mjs`).
   * Terintegrasi dengan Xendit (`xenditIntegration.mjs`) untuk melayani top-up otomatis instan menggunakan **QRIS (Gopay, OVO, Dana, ShopeePay)** dan **Virtual Account Bank**.

### Lapisan 3: AI Inference & Smart Router Tier (`boson-litellm`)
Dikelola oleh container `ghcr.io/berriai/litellm` yang dikonfigurasi via `litellm-config.yaml`:
1. **Abstraction Layer:** Gateway Anda hanya perlu berbicara dengan satu endpoint internal (`http://litellm:4000`), LiteLLM yang mengurus perbedaan payload antar penyedia (DeepSeek, Claude, Google, dll.).
2. **Zero-Downtime Circuit Breaker:**
   * Jika DeepSeek mengalami timeout (> 25 detik) atau HTTP 429/503 sebanyak 2 kali berturut-turut, LiteLLM menandai status DeepSeek sebagai *cooldown* selama 60 detik.
   * Request otomatis dialihkan ke provider cadangan (Gemini 2.0 Flash atau OpenRouter) secara transparan tanpa disadari oleh user.
3. **Upstream KV-Cache Passthrough:**
   * Meneruskan struktur pesan dan header `cache_control` agar fitur diskon 50%–90% dari DeepSeek dan Claude aktif otomatis.

### Lapisan 4: Data & Wallet Ledger Tier (`boson-db` & Supabase)
Ditenagai oleh PostgreSQL 15 dengan skema database di `init-scripts/`:
1. **Multi-Bucket Wallet Ledger (`01-schema.sql`):**
   * `bonus_balance`: Saldo selamat datang \$2.00 (diprioritaskan pertama kali untuk dipotong saat inferensi).
   * `subscription_balance`: Kuota kredit bulanan dari langganan Pro.
   * `normal_balance`: Saldo deposit riil pengguna dari top-up QRIS/VA (tidak pernah hangus).
   * `reserved_balance`: Saldo yang di-hold saat inferensi berjalan untuk mencegah saldo negatif.
2. **Atomic Deduction Function:**
   * Menggunakan stored procedure PostgreSQL dengan row-level lock (`SELECT ... FOR UPDATE`) untuk menjamin tidak terjadi *race condition* (pemotongan saldo ganda) ketika pengguna menjalankan beberapa stream sekaligus.
3. **Idempotent Transaction Ledger:**
   * Setiap webhook dari Xendit dicatat dengan constraint unik `external_id` untuk mencegah manipulasi saldo ganda.

---

## 3. Panduan Setup & Deployment Server Produksi

### Prasyarat Hardware & Sistem Operasi
* **Sistem Operasi:** Ubuntu 22.04 LTS / 24.04 LTS atau AlmaLinux 9.
* **Spesifikasi Minimum:**
  * 2 vCPU
  * 2 GB RAM (dengan Swap 2 GB aktif)
  * 30 GB SSD / NVMe
* **Spesifikasi Rekomendasi (Traffic Nyaman):**
  * 4 vCPU
  * 4 GB – 8 GB RAM
  * 50 GB NVMe

#### Langkah Awal di VPS:
```bash
# Update sistem dan install tool penting
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw fail2ban jq

# Pasang Docker & Docker Compose resmi
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker

# Aktifkan Firewall Dasar
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP Caddy
sudo ufw allow 443/tcp   # HTTPS Caddy
sudo ufw enable
```

---

### Konfigurasi Environment (`.env`)

Clone atau salin folder `deploy/boson-backend` ke VPS Anda (misal ke `/opt/boson-backend`):
```bash
cd /opt/boson-backend
cp .env.example .env
nano .env
```

Pastikan variabel penting berikut terisi dengan benar:

```ini
# ─────────────────────────────────────────────────────────────
# 1. DATABASE & KEAMANAN
# ─────────────────────────────────────────────────────────────
POSTGRES_DB=postgres
POSTGRES_PASSWORD=GantiDenganPasswordDatabaseYangSangatKuatDanPanjang123!
# Buat string 32-karakter acak: openssl rand -base64 32
JWT_SECRET=KunciRahasiaJWTSupabaseMinimal32KarakterPanjangnya!

# ─────────────────────────────────────────────────────────────
# 2. DOMAIN & URL PUBLIK
# ─────────────────────────────────────────────────────────────
PLATFORM_PUBLIC_URL=https://api.domainanda.com
SITE_URL=https://app.domainanda.com

# ─────────────────────────────────────────────────────────────
# 3. UPSTREAM API KEYS
# ─────────────────────────────────────────────────────────────
DEEPSEEK_MASTER_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxx
LITELLM_MASTER_KEY=sk-boson-internal-router-key-admin-123

# ─────────────────────────────────────────────────────────────
# 4. PAYMENT GATEWAY (XENDIT)
# ─────────────────────────────────────────────────────────────
XENDIT_SECRET_KEY=xnd_production_xxxxxxxxxxxxxxxxxxxxxxxx
XENDIT_PUBLIC_KEY=xnd_public_production_xxxxxxxxxxxxxxxx
XENDIT_WEBHOOK_TOKEN=TokenVerifikasiWebhookXenditAnda

# ─────────────────────────────────────────────────────────────
# 5. GOOGLE OAUTH SSO (OPSIONAL)
# ─────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
```

---

### Deployment dengan Docker Compose

Jalankan seluruh stack container:
```bash
docker compose up -d --build
```

Verifikasi kesehatan seluruh container:
```bash
docker compose ps
```

Hasil yang diharapkan (Semua berstatus `Up` atau `healthy`):
* `boson-db` (Port 5432 - Healthy)
* `boson-auth` (Port 9999 - Up)
* `boson-rest` (Port 3000 - Up)
* `boson-studio-dashboard` (Port 3001 - Up)
* `boson-gateway` (Port 8088 / 5001 - Up)
* `boson-litellm` (Port 4000 - Up)

---

### Konfigurasi Domain & HTTPS Otomatis (Caddy)

Pasang Caddy sebagai reverse proxy utama:
```bash
sudo apt install -y caddy
```

Edit `/etc/caddy/Caddyfile`:
```caddy
# Domain untuk API Gateway & Billing Portal
api.domainanda.com {
    # Forward ke Boson Gateway
    reverse_proxy localhost:8088 {
        header_up X-Forwarded-Proto https
        header_up X-Real-IP {remote_host}
    }
}

# Domain untuk Dashboard Admin Database (Supabase Studio)
admin.domainanda.com {
    # Proteksi Basic Auth (Opsional tapi disarankan)
    basicauth {
        admin $2a$14$HashPasswordBcryptAnda
    }
    reverse_proxy localhost:3001
}
```

Muat ulang Caddy:
```bash
sudo systemctl reload caddy
```

---

### Pengujian Verifikasi End-to-End

#### 1. Uji Healthcheck Gateway:
```bash
curl https://api.domainanda.com/health
```
*Respons:* `{"status":"healthy","service":"Boson Studio Unified LLM Gateway"}`

#### 2. Uji Inferensi via API Key:
Buat Personal API Key untuk user atau uji coba langsung lewat master token:
```bash
curl -X POST https://api.domainanda.com/v1/chat/completions \
  -H "Authorization: Bearer sk_boson_xxxxxxxxxxxxxxxx" \
  -H "X-Boson-Platform-Id: boson-desktop" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Halo Boson!"}],
    "stream": false
  }'
```

---

## 4. Strategi Skalabilitas (Scaling Roadmap: 100 s.d. 100.000+ Pengguna)

Sistem Anda dirancang modular sehingga dapat ditingkatkan skalanya secara bertahap tanpa perlu merombak ulang kode arsitektur.

```mermaid
flowchart LR
    subgraph Fase1 ["Fase 1: 100 - 1.000 DAU"]
        SingleVPS["Single VPS (4 vCPU / 8 GB RAM)<br>Semua Container Berjalan di 1 Mesin"]
    end

    subgraph Fase2 ["Fase 2: 1.000 - 10.000 DAU"]
        AppVPS["App VPS (Stateless)<br>Caddy + Multiple Gateway + LiteLLM"]
        ManagedDB[("Managed PostgreSQL<br>Supabase / AWS RDS / DO DB<br>+ PgBouncer Pooler")]
        AppVPS --> ManagedDB
    end

    subgraph Fase3 ["Fase 3: > 10.000 DAU (Enterprise)"]
        LB["Cloudflare Load Balancer"]
        NodeCluster["Kubernetes / Docker Swarm Replicas"]
        RedisCluster[("Redis Cluster<br>Session & Rate Limit")]
        ManagedDBCluster[("PostgreSQL Master + Read Replicas")]
        
        LB --> NodeCluster
        NodeCluster --> RedisCluster
        NodeCluster --> ManagedDBCluster
    end
```

---

### Fase 1: Optimasi Single-VPS (100 – 1.000 DAU)
Pada tahap awal, 1 server VPS (4 vCPU, 8 GB RAM) sudah sangat mencukupi karena komputasi agent dilakukan di mesin pengguna.

**Tindakan Optimasi:**
1. **Batasi Worker LiteLLM:**
   * Di `docker-compose.yml`, pastikan command LiteLLM menggunakan:
     `command: ["--config", "/app/config.yaml", "--port", "4000", "--num_workers", "2"]`
2. **Koneksi Database PostgreSQL:**
   * Di `init-scripts/01-schema.sql`, tambahkan indeks pada tabel transaksi dan wallet:
     ```sql
     CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);
     CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON public.api_keys(key_hash);
     ```
3. **Log Rotation Docker:**
   * Mencegah harddisk server penuh akibat log container yang membesar:
     Edit `/etc/docker/daemon.json`:
     ```json
     {
       "log-driver": "json-file",
       "log-opts": {
         "max-size": "50m",
         "max-file": "3"
       }
     }
     ```

---

### Fase 2: Pemisahan Database & Replikasi Gateway (1.000 – 10.000 DAU)
Ketika transaksi dompet dan pemotongan saldo mencapai puluhan request per detik, bottleneck pertama akan terjadi pada I/O disk database.

**Langkah-langkah Scaling:**
1. **Pindahkan Database ke Managed Service:**
   * Pisahkan `boson-db` dari VPS aplikasi.
   * Gunakan layanan Managed PostgreSQL (seperti Supabase Cloud, DigitalOcean Managed Database, atau AWS RDS).
   * Aktifkan **PgBouncer** (Connection Pooler) untuk menangani ribuan koneksi konkuren tanpa membebani thread database.
2. **Jalankan Replikasi Stateless Gateway:**
   * Karena `boson-gateway` bersifat *stateless* (tidak menyimpan state sesi di memori aplikasi), Anda dapat menjalankan 3–5 instance container gateway di belakang Caddy:
     ```caddy
     api.domainanda.com {
         reverse_proxy {
             to localhost:8081 localhost:8082 localhost:8083
             lb_policy round_robin
         }
     }
     ```

---

### Fase 3: Arsitektur Terdistribusi & Multi-Region (> 10.000 DAU)
Ketika platform Anda memiliki puluhan ribu developer aktif di berbagai negara:

1. **Global CDN & Anycast Ingress:**
   * Gunakan **Cloudflare Enterprise / Pro** di depan domain Anda untuk proteksi DDoS, Web Application Firewall (WAF), dan routing SSL tercepat.
2. **Multi-Account API Key Pooling:**
   * Satu akun API DeepSeek atau Claude memiliki batasan *Rate Limit (Tier Limits)*.
   * Di LiteLLM, Anda dapat mendaftarkan **banyak API Key sekaligus** dari organisasi berbeda:
     ```yaml
     model_list:
       - model_name: deepseek-chat
         litellm_params:
           model: deepseek/deepseek-chat
           api_key: os.environ/DEEPSEEK_KEY_ORG_1
       - model_name: deepseek-chat
         litellm_params:
           model: deepseek/deepseek-chat
           api_key: os.environ/DEEPSEEK_KEY_ORG_2
     router_settings:
       routing_strategy: "least-busy" # Otomatis merotasi kunci yang paling kosong
     ```
3. **Asynchronous Ledger Processing (Message Queue):**
   * Untuk lalu lintas sangat tinggi, pemotongan saldo tidak lagi dilakukan secara sinkronis pada akhir HTTP request.
   * Pemotongan saldo diubah menjadi event streaming (via Redis Streams atau RabbitMQ) yang diproses secara atomik oleh *ledger worker pool*.

---

## 5. Runbook Pemeliharaan, Backup, & Penanganan Insiden

### Prosedur Backup Otomatis Database
Buat script backup harian di server (`/opt/scripts/backup-db.sh`):

```bash
#!/bin/bash
BACKUP_DIR="/opt/backups/postgres"
DATE=$(date +"%Y%m%d_%H%M%S")
mkdir -p $BACKUP_DIR

# Dump database PostgreSQL
docker exec -t boson-db pg_dumpall -c -U postgres | gzip > "$BACKUP_DIR/boson_db_$DATE.sql.gz"

# Hapus backup yang lebih lama dari 14 hari
find $BACKUP_DIR -type f -name "*.sql.gz" -mtime +14 -exec rm {} \;

echo "Backup berhasil disimpan di $BACKUP_DIR/boson_db_$DATE.sql.gz"
```
Jalankan script ini setiap pukul 02:00 pagi melalui crontab:
```bash
0 2 * * * /bin/bash /opt/scripts/backup-db.sh >> /var/log/cron-backup.log 2>&1
```

---

### Penanganan Insiden Produksi (Troubleshooting Guide)

| Gejala Masalah | Kemungkinan Akar Masalah | Solusi Cepat |
| :--- | :--- | :--- |
| **Klien menerima HTTP 502 Bad Gateway** | Container `boson-gateway` crash atau Caddy gagal meneruskan request. | Cek status container: `docker compose ps`. Cek log error: `docker compose logs -f gateway`. Restart: `docker compose restart gateway`. |
| **Stream macet atau timeout > 30 detik** | Provider upstream (DeepSeek) sedang mengalami lonjakan antrean global. | Periksa apakah fallback LiteLLM aktif di log LiteLLM: `docker compose logs -f litellm`. Pastikan API Key cadangan (Gemini/OpenRouter) memiliki kuota saldo aktif. |
| **User komplain saldo tidak bertambah setelah bayar QRIS** | Webhook Xendit terblokir firewall atau token verifikasi tidak cocok. | Periksa log webhook: `docker compose logs --tail=100 gateway \| grep -i xendit`. Pastikan URL Webhook di dashboard Xendit mengarah ke `https://api.domainanda.com/api/v0/billing/xendit/webhook`. |
| **Penggunaan RAM VPS mencapai > 90%** | Memori bocor pada LiteLLM worker atau connection leak pada PostgreSQL. | Batasi worker LiteLLM ke `--num_workers 2`. Restart container: `docker compose restart litellm db`. Periksa koneksi aktif di PostgreSQL: `SELECT count(*) FROM pg_stat_activity;`. |

---
*Dokumen ini merupakan panduan arsitektur hidup (living document) yang dikelola oleh tim rekayasa Boson Studio.*
