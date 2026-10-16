# Boson Gateway: Multi-Tenant & Markup LLM Proxy (OpenRouter)

Gateway ini berfungsi sebagai perantara pintar (*middleware*) antara **Boson Studio** dan **OpenRouter**. Dilengkapi dengan sistem **Multi-Tenant Virtual Keys**, **Sistem Saldo Deposit (Prepaid / Pay-as-You-Go)**, dan **Markup Harga Otomatis (Margin Profit)**.

---

## 1. Arsitektur Komponen

Terdapat 2 opsi arsitektur backend yang didukung:

### Opsi A: Boson Native Gateway Server (Rekomendasi Utama)
* **File Entry**: [`gateway/src/server.ts`](src/server.ts)
* **Double-Bucket Ledger**: [`gateway/src/ledger.ts`](src/ledger.ts) (menggunakan SQLite bawaan Node.js `node:sqlite`).
* **Fitur Utama**:
  * Memisahkan kuota langganan (`subscriptionQuotaUsd`) dan saldo deposit top-up (`depositBalanceUsd`).
  * Saat reset siklus 30 hari tiba, kuota langganan diperbarui **tanpa menghapus atau mengubah deposit top-up** (Bug #3 teratasi).
  * Saat masa hangus deposit tiba, hanya deposit yang dikunci; kuota langganan tetap aktif (Bug #4 teratasi).
  * Transaksi audit append-only yang immutable mencatat prompt, completion, modal OpenRouter, harga jual, dan laba bersih Anda.
  * Autentikasi Master Key dan proteksi CORS Origin bawaan.

### Opsi B: LiteLLM Proxy Container
* **Docker Compose**: [`gateway/docker-compose.yml`](docker-compose.yml) (LiteLLM + PostgreSQL).
* Cocok jika Anda ingin menggunakan Dashboard Admin UI bawaan LiteLLM di port 4000.

---

## 2. Cara Menjalankan Backend Gateway

### Cara 1: Menjalankan Boson Native Gateway Server (Cepat & Ringan)
```bash
# 1. Pastikan OPENROUTER_API_KEY sudah diset di gateway/.env
# 2. Jalankan server backend:
npx tsx gateway/src/server.ts
```
Server akan aktif di `http://127.0.0.1:4000`.

### Cara 2: Menjalankan via Docker Compose (LiteLLM + PostgreSQL)
```bash
cd gateway
docker compose up -d
```


---

## 3. Konfigurasi Markup Harga (`config.yaml`)

Harga jual token ke tenant diatur pada berkas [`gateway/config.yaml`](config.yaml). Anda bisa menentukan harga custom per token:

| Model | Harga Modal OpenRouter (Prompt/Completion) | Harga Jual ke Tenant (Markup +25% s/d +30%) |
| :--- | :--- | :--- |
| **`deepseek-v3`** | \$0.14 / \$0.28 per 1M token | **\$0.182 / \$0.364 per 1M token** |
| **`deepseek-r1`** | \$0.55 / \$2.19 per 1M token | **\$0.715 / \$2.847 per 1M token** |
| **`claude-3-5-sonnet`**| \$3.00 / \$15.00 per 1M token | **\$3.750 / \$18.750 per 1M token** |
| **`gpt-4o`** | \$2.50 / \$10.00 per 1M token | **\$3.125 / \$12.500 per 1M token** |

Setiap token yang dikonsumsi pengguna akan dihitung berdasarkan harga jual Anda. Selisihnya adalah **keuntungan bersih Anda**.

---

---

## 4. Model Monetisasi: Langganan Bulanan vs Deposit dengan Masa Hangus

Gateway mendukung 2 model bisnis utama (serta kombinasi hybrid) yang dapat Anda tawarkan kepada pengguna:

### Skema 1: Langganan Bulanan (Monthly Credit Budget / Pay-As-You-Go Recurring)
* **Karakteristik**: Pengguna membayar biaya bulanan (misal Rp 150.000/bulan) dan mendapatkan kuota pemakaian senilai misal \$10 - \$25 per bulan.
* **Siklus Reset**: Menggunakan `budget_duration: "30d"`.
* **Masa Hangus**: Kuota bulanan di-reset otomatis setiap 30 hari. Tidak ada sistem hangus saldo kumulatif, melainkan kuota bulan baru langsung aktif.
* **Bila Kuota Habis**: Request ditolak dengan kode `402 QUOTA_EXCEEDED` hingga siklus bulan berikutnya, atau pengguna membeli *Add-on Deposit*.

### Skema 2: Deposit Prabayar (Bisa dengan Masa Hangus / Expiring)
* **Karakteristik**: Pengguna membeli paket saldo kredit tertentu (misal \$10 atau \$50).
* **Masa Hangus (`duration`)**:
  - **Dengan Masa Hangus**: Anda dapat menyetel masa aktif saldo (contoh `30d` untuk 30 hari, `90d` untuk 3 bulan). Begitu tanggal kedaluwarsa tiba, virtual key otomatis dinonaktifkan (`403 KEY_EXPIRED`).
  - **Tanpa Masa Hangus (`none`)**: Saldo tetap aktif selamanya sampai token benar-benar habis dipakai.
* **Top-up**: Pengguna dapat melakukan top-up untuk menambah saldo kredit sekaligus memperpanjang masa aktif.

---

## 5. Mengelola Tenant, Langganan & Deposit (`manage-tenant.ts`)

Gunakan skrip CLI yang sudah disediakan untuk memanajemen pengguna/tenant:

### A. Membuat Akun Langganan Bulanan (Reset Otomatis 30 Hari)
```bash
npx tsx gateway/manage-tenant.ts create-sub <user_id> <monthly_budget_usd> [alias]

# Contoh: Langganan bulanan untuk 'user_budi' dengan budget $20/bulan
npx tsx gateway/manage-tenant.ts create-sub user_budi 20.0 "Langganan Budi Pro"
```

### B. Membuat Akun Deposit dengan Masa Hangus
```bash
npx tsx gateway/manage-tenant.ts create-deposit <user_id> <deposit_usd> [duration e.g. 30d/60d/90d/none] [alias]

# Contoh 1: Deposit $15 dengan masa aktif hangus dalam 30 hari
npx tsx gateway/manage-tenant.ts create-deposit user_siti 15.0 30d "Deposit Siti 1 Bulan"

# Contoh 2: Deposit $50 dengan masa aktif hangus dalam 90 hari
npx tsx gateway/manage-tenant.ts create-deposit user_tono 50.0 90d "Deposit Tono 3 Bulan"

# Contoh 3: Deposit $10 tanpa masa hangus (aktif selamanya sampai habis)
npx tsx gateway/manage-tenant.ts create-deposit user_andi 10.0 none "Deposit Andi Lifetime"
```

### C. Top-up Saldo / Tambah Deposit & Perpanjang Masa Aktif
```bash
npx tsx gateway/manage-tenant.ts topup <virtual_key> <additional_budget_usd> [extend_duration e.g. 30d]

# Contoh: Tambah saldo $10 dan perpanjang masa aktif 30 hari lagi
npx tsx gateway/manage-tenant.ts topup sk-boson-xxxx 10.0 30d
```

### D. Memeriksa Status Saldo, Kuota Bulanan & Tanggal Hangus
```bash
npx tsx gateway/manage-tenant.ts balance <virtual_key>
```
*Output menampilkan: Tipe Paket, Total Limit, Spend, Sisa Saldo, Siklus Reset Bulanan, dan Tanggal Masa Hangus.*

### E. Melihat Semua Tenant
```bash
npx tsx gateway/manage-tenant.ts list
```

---

## 6. Menghubungkan Boson Studio ke Gateway

Di sisi klien Boson Studio, tambahkan provider ke konfigurasi runtime atau profil [`cordis.patch.yml`](../packages/bundle/web-app/cordis.patch.yml):

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      boson-cloud:
        displayName: 'Boson Cloud (OpenRouter)'
        api: openai-completions
        baseURL: http://127.0.0.1:4000/v1      # atau https://api.boson.dev/v1
        apiKeyEnv: BOSON_TENANT_API_KEY        # Virtual API Key milik tenant
```

Atau pengguna dapat langsung memasukkan Virtual Key mereka di menu **Settings -> Models -> Custom Provider** dengan Base URL gateway Anda.

---

## 7. Penanganan Kuota Habis & Saldo Hangus

1. **Jika Saldo Deposit Habis (`spend >= max_budget`)**:
   Gateway LiteLLM menolak request berikutnya dengan status **HTTP 402 Payment Required** (`QUOTA_EXCEEDED`).
2. **Jika Masa Hangus Deposit Tiba (`now > expires`)**:
   Gateway menolak request dengan status **HTTP 403 Forbidden** (`KEY_EXPIRED`).
3. **Jika Kuota Langganan Bulanan Habis**:
   Menolak request hingga tanggal reset bulanan (`budget_duration: 30d`) berikutnya, kecuali jika pengguna melakukan top-up add-on.
4. **Respon Klien**:
   Boson Studio menangkap kode error ini dan secara otomatis mengarahkan tenant ke portal pembayaran untuk melakukan perpanjangan paket atau top-up saldo deposit.
