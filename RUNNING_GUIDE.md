# Panduan Lengkap Menjalankan Boson Studio (Front-to-Back Runbook)

Panduan ini menjelaskan langkah demi langkah untuk menjalankan seluruh ekosistem **Boson Studio** dari ujung depan (*frontend/client*) hingga ujung belakang (*backend gateway, database, dan upstream LLM*).

---

## 1. Arsitektur Alur Sistem (Front-to-Back Flow)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        1. FRONTEND / CLIENT                            │
│  - Web App: http://localhost:3080 (Boson Studio)                       │
│  - Desktop App: Electron / Tauri Native Client                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Request HTTP + Bearer Virtual Key
                                    │ (Origin Header: app.yourdomain.com)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                2. REVERSE PROXY & FIREWALL (Produksi)                  │
│  - Caddy / Nginx (Port 80/443 dengan SSL Otomatis)                     │
│  - Filter Domain: Blokir request dari luar domain resmi (CORS 403)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Teruskan ke Localhost Only
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 3. BACKEND GATEWAY (LiteLLM Proxy)                     │
│  - Port Internal: 127.0.0.1:4000                                       │
│  - Validasi Virtual Key, Masa Hangus, & Kuota Langganan                │
│  - Markup Harga Otomatis (+25% s/d +30% Margin Keuntungan Anda)        │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
                    ▼                                ▼
    ┌──────────────────────────────┐ ┌──────────────────────────────────┐
    │     4. DATABASE LOKAL        │ │       5. UPSTREAM PROVIDER       │
    │  - PostgreSQL (Port 5432)    │ │  - OpenRouter API                │
    │  - Saldo Deposit & Masa Aktif│ │  - DeepSeek V3, DeepSeek R1,     │
    │  - Riwayat Token & Audit Log │ │    Claude 3.5 Sonnet, GPT-4o     │
    └──────────────────────────────┘ └──────────────────────────────────┘
```

---

## 2. Prasyarat Sistem (Prerequisites)

Sebelum memulai, pastikan perangkat atau server Anda sudah terpasang:
1. **Node.js**: Versi `^22.19` atau `>=24`
2. **pnpm**: Versi `>=10`
3. **Docker & Docker Compose**: Untuk menjalankan PostgreSQL dan LiteLLM
4. **API Key OpenRouter**: Dapatkan di [https://openrouter.ai/keys](https://openrouter.ai/keys)

---

## 3. Langkah Demi Langkah Menjalankan Aplikasi

### TAHAP 1: Konfigurasi Backend Gateway

1. Masuk ke direktori `gateway/`:
   ```bash
   cd /var/home/fazdev/deepseek-harness/gateway
   ```

2. Pastikan berkas `.env` sudah terisi dengan benar:
   ```bash
   # Salin template jika belum ada
   cp .env.example .env
   ```
   Edit berkas `.env`:
   ```ini
   # Masukkan OpenRouter API Key asli Anda
   OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

   # Kunci admin rahasia Anda untuk membuat Virtual Key tenant & top-up
   LITELLM_MASTER_KEY=sk-boson-master-admin-key-2026

   # Password database PostgreSQL lokal
   POSTGRES_PASSWORD=boson_secure_db_pass_2026
   ```

3. Periksa konfigurasi model & markup harga di [`gateway/config.yaml`](config.yaml):
   * `deepseek-v3`: Modal \$0.14/1M $\rightarrow$ Harga Jual \$0.182/1M (+30%)
   * `deepseek-r1`: Modal \$0.55/1M $\rightarrow$ Harga Jual \$0.715/1M (+30%)
   * `claude-3-5-sonnet`: Modal \$3.00/1M $\rightarrow$ Harga Jual \$3.75/1M (+25%)

---

### TAHAP 2: Menjalankan Backend Gateway (Docker)

Jalankan container PostgreSQL dan LiteLLM di latar belakang:

```bash
cd /var/home/fazdev/deepseek-harness/gateway
docker compose up -d
```

#### Verifikasi Status Backend:
1. **Cek status container**:
   ```bash
   docker compose ps
   ```
   *Kedua container (`boson-gateway-db` dan `boson-gateway-proxy`) harus berstatus `Up` / `healthy`.*

2. **Cek log LiteLLM**:
   ```bash
   docker compose logs -f litellm
   ```

3. **Uji kesehatan gateway via curl**:
   ```bash
   curl http://127.0.0.1:4000/health
   # Respon yang diharapkan: "healthy" atau status 200 OK
   ```

---

### TAHAP 3: Membuat Virtual Key Tenant (Langganan / Deposit)

Sebelum pengguna membuka Boson Studio, buatkan Virtual API Key terlebih dahulu:

#### Opsi A: Model Langganan Bulanan (Reset Otomatis 30 Hari)
```bash
npx tsx gateway/manage-tenant.ts create-sub <user_id> <budget_bulanan_usd> [alias]

# Contoh: Pengguna 'budi' paket $20/bulan
npx tsx gateway/manage-tenant.ts create-sub user_budi 20.0 "Langganan Budi Pro"
```

#### Opsi B: Model Deposit Prabayar dengan Masa Hangus
```bash
npx tsx gateway/manage-tenant.ts create-deposit <user_id> <saldo_usd> <durasi> [alias]

# Contoh 1: Deposit $15 dengan masa aktif 30 hari (hangus setelah 30 hari)
npx tsx gateway/manage-tenant.ts create-deposit user_siti 15.0 30d "Deposit Siti 1 Bulan"

# Contoh 2: Deposit $50 aktif 90 hari
npx tsx gateway/manage-tenant.ts create-deposit user_tono 50.0 90d "Deposit Tono 3 Bulan"

# Contoh 3: Deposit $10 tanpa masa hangus (aktif selamanya)
npx tsx gateway/manage-tenant.ts create-deposit user_andi 10.0 none "Deposit Andi Lifetime"
```

> Simpan Virtual Key yang dihasilkan (contoh: `sk-boson-xxxxxxxxxxxxxxxx`). Key inilah yang akan dimasukkan ke Boson Studio.

---

### TAHAP 4: Menjalankan Frontend (Boson Studio)

Buka terminal baru di root direktori project:

```bash
cd /var/home/fazdev/deepseek-harness
```

#### 1. Menjalankan Versi Web:
```bash
pnpm run dev:web
# Atau mode langsung:
node --import tsx/esm apps/cli/src/bin.ts web
```
Aplikasi web Boson Studio akan berjalan di port `3080`.
Buka link yang tercetak di konsol browser Anda, misalnya:
`http://localhost:3080/?token=xxxxxxxx`

#### 2. Menjalankan Versi Desktop (Jika Menggunakan Desktop):
```bash
pnpm run dev:desktop
```

---

### TAHAP 5: Menghubungkan Frontend Boson Studio ke Gateway

Ada 2 cara menghubungkan Boson Studio ke gateway backend Anda:

#### Metode A: Melalui Antarmuka UI Pengguna (Paling Mudah)
1. Buka Boson Studio di browser (`http://localhost:3080`).
2. Masuk ke menu **Settings** (ikon gerigi di sidebar kiri bawah).
3. Pilih tab **Models** $\rightarrow$ Tambahkan **Custom Provider**:
   * **Provider Name**: `Boson Cloud` (atau nama brand Anda)
   * **API Protocol**: `OpenAI-Compatible`
   * **Base URL**: `http://127.0.0.1:4000/v1` (atau alamat domain resmi Anda `https://api.yourdomain.com/v1`)
   * **API Key**: Masukkan Virtual API Key tenant Anda (`sk-boson-...`).
4. Klik **Save**. Pengguna sekarang siap berinteraksi dengan AI menggunakan saldo/kuota mereka!

#### Metode B: Otomatis di Level Konfigurasi Profil ([`cordis.patch.yml`](packages/bundle/web-app/cordis.patch.yml))
Anda dapat mengunci konfigurasi ini agar pengguna tidak perlu memasukkan Base URL secara manual:
```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      boson-cloud:
        displayName: 'Boson Cloud (OpenRouter)'
        api: openai-completions
        baseURL: http://127.0.0.1:4000/v1
        apiKeyEnv: BOSON_TENANT_API_KEY
```

---

## 4. Menjalankan di Server Produksi (Domain Publik + SSL)

Jika Anda mendeploy sistem ini ke server VPS/Cloud (misal Ubuntu Server / Debian):

### 1. Amankan Port Internal
Port `4000` (LiteLLM) dan `5432` (PostgreSQL) pada `docker-compose.yml` sudah otomatis terikat ke `127.0.0.1` (*localhost only*). Artinya, pengguna internet dari luar **tidak bisa mengakses port ini secara langsung**.

### 2. Pasang Reverse Proxy (Caddy atau Nginx)
Gunakan konfigurasi yang sudah disiapkan di folder `gateway/`:

#### Pilihan A: Menggunakan Caddy (Rekomendasi, Otomatis SSL HTTPS)
1. Buka [`gateway/Caddyfile`](gateway/Caddyfile).
2. Ganti `app.yourdomain.com` dan `api.yourdomain.com` dengan domain asli Anda.
3. Jalankan Caddy:
   ```bash
   caddy run --config gateway/Caddyfile
   ```
*Caddy akan otomatis membuat sertifikat SSL gratis (Let's Encrypt) dan menolak request dari origin yang tidak terdaftar.*

#### Pilihan B: Menggunakan Nginx
Salin [`gateway/nginx.conf`](gateway/nginx.conf) ke `/etc/nginx/sites-available/` dan aktifkan dengan `systemctl reload nginx`.

---

## 5. Ringkasan Perintah Penting (Cheat Sheet)

| Kebutuhan | Perintah |
| :--- | :--- |
| **Nyalakan Gateway Backend** | `cd gateway && docker compose up -d` |
| **Matikan Gateway Backend** | `cd gateway && docker compose down` |
| **Lihat Log Gateway** | `cd gateway && docker compose logs -f litellm` |
| **Buat Akun Langganan Bulanan** | `npx tsx gateway/manage-tenant.ts create-sub <user> <budget_usd>` |
| **Buat Akun Deposit Berjangka** | `npx tsx gateway/manage-tenant.ts create-deposit <user> <usd> <durasi>` |
| **Top-up Saldo Tenant** | `npx tsx gateway/manage-tenant.ts topup <key> <usd_tambahan> [durasi]` |
| **Cek Sisa Saldo & Masa Hangus** | `npx tsx gateway/manage-tenant.ts balance <key>` |
| **Lihat Semua Tenant** | `npx tsx gateway/manage-tenant.ts list` |
| **Nyalakan Frontend Web** | `pnpm run dev:web` |
| **Uji Semua Skenario Simulasi** | `npx tsx gateway/test-simulation.ts` |
