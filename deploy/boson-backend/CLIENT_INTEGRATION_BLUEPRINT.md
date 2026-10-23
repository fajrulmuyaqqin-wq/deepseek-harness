# 📐 Blueprint Integrasi Client & Frontend ke Boson LLM Gateway

Dokumen ini adalah **panduan integrasi standar (Integration Specification & Blueprint)** untuk membantu developer dan AI coding agent menghubungkan aplikasi frontend eksternal (**Web App, Desktop Electron/Tauri, CLI, Mobile, VSCode Extension**) ke arsitektur **Boson Unified LLM Gateway**.

---

## 1. Arsitektur & Prinsip Gateway

```
+-----------------------------------------------------------------------------------+
|                            KLIEN EKSTERNAL (FRONTEND)                             |
|  [ Web Apps (React/Vue/Next) ]  [ Desktop (Electron/Tauri) ]  [ CLI / Extension ] |
+------------------------------------------+----------------------------------------+
                                           |
                   HTTP / SSE Streaming    | Header:
                   (REST / JSON)           | - Authorization: Bearer <token / sk_boson_>
                                           | - X-Boson-Platform-Id: <platform-id>
                                           v
+-----------------------------------------------------------------------------------+
|                        BOSON UNIFIED LLM GATEWAY (Port 8088 / 5001)               |
|                                                                                   |
|  1. Gatekeeper & Rate Limiter (Anti-Brute Force & DoS)                            |
|  2. Platform Allowlist Verification (Scoping platform id)                         |
|  3. Dual Auth Resolver (PKCE JWT Sesi / Google SSO / Personal API Key Hash)       |
|  4. Pre-Flight Quota Guard (Cek saldo > $0.0005, HTTP 402 jika habis)            |
|  5. Dual Engine Protocol:                                                         |
|     - Anthropic Messages API (/v1/messages)                                       |
|     - OpenAI Chat Completions API (/v1/chat/completions)                          |
|  6. Live Pricing Engine (Wholesale + 15% margin, OpenRouter 940+ models sync)     |
|  7. Atomic Wallet Deduction (Bonus -> Subscription -> Normal Balance)             |
|  8. Monetization & Billing (Xendit QRIS / VA Top-Up & Subscriptions)             |
+------------------------------------------+----------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------+
|                            UPSTREAM INFERENCE & STORAGE                           |
|  [ LiteLLM Proxy / DeepSeek / Claude / Gemini ]       [ PostgreSQL + RLS ]        |
+-----------------------------------------------------------------------------------+
```

---

## 2. Kredensial & Base URL Gateway

| Lingkungan | Base URL Gateway | Port SSO & Billing |
| :--- | :--- | :--- |
| **Lokal / Development** | `http://127.0.0.1:8088` | `http://127.0.0.1:5001` (atau `8088`) |
| **Produksi (VPS / Server)** | `https://api.yourdomain.com` (atau IP Publik:8088) | Sesuai konfigurasi reverse proxy Nginx/Caddy |

---

## 3. Registrasi Platform Baru (`Platform ID`)

Gateway memiliki proteksi **Platform Allowlist**. Sebelum klien baru melakukan pemanggilan API inferensi, ID platform harus terdaftar di tabel `allowed_platforms`:

### Langkah Pendaftaran:
Jalankan query SQL berikut di database (atau lewat gateway):
```sql
INSERT INTO public.allowed_platforms (id, name, description, is_active)
VALUES (
  'my-custom-desktop-app', 
  'My Custom Desktop App', 
  'Aplikasi Desktop Electron untuk tim internal', 
  true
)
ON CONFLICT (id) DO NOTHING;
```
> [!TIP]
> Platform ID default yang sudah terdaftar dan siap pakai:
> - `boson-desktop` (Aplikasi Boson Studio Desktop / Web)
> - `aethel-studio` (Aethel Coding Assistant)
> - `boson-cli` (Command Line Interface & Scripts)
> - `vscode-extension` (Plugin Editor)

---

## 4. Metode Autentikasi (Pilih Sesuai Kebutuhan)

Gateway mendukung 3 metode autentikasi:

### Metode A: Personal API Key (`sk_boson_...`) — **Sangat Direkomendasikan untuk Desktop / CLI / Extension**
User membuat API Key sekali via Billing Portal (`/billing` atau `/api/v0/api-keys`), lalu klien menyimpannya secara aman di config lokal atau secure storage.

- **Header yang dikirim**:
  ```http
  Authorization: Bearer sk_boson_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
  X-Boson-Platform-Id: my-custom-desktop-app
  ```
- **Kelebihan**: Tidak memerlukan pop-up login browser; langsung bekerja seketika (headless-friendly).

### Metode B: OAuth2 PKCE Flow — **Direkomendasikan untuk Aplikasi Web & Desktop Native Login**
1. **Inisiasi Sesi PKCE**:
   - `POST /auth-api/v0/dsh/auth_init`
   - Body: `{ code_challenge, redirect_uri, state }`
   - Respons: `{ authorize_url: "http://127.0.0.1:8088/dsh/authorize?auth_id=...", authorize_id }`
2. **Arahkan Pengguna ke Browser**:
   - Buka `authorize_url` di browser atau Webview.
   - Pengguna login atau mendaftar (otomatis mendapatkan bonus selamat datang $2.00).
3. **Exchange Token**:
   - `POST /auth-api/v0/dsh/auth_exchange`
   - Body: `{ code: auth_code, authorize_id, code_verifier }`
   - Respons: `{ token: "..." }`
4. Gunakan token ini pada header:
   ```http
   x-dsh-auth-token: <token>
   ```
   *(Atau `Authorization: Bearer <token>`)*

### Metode C: Google SSO Flow (Port 5001)
1. Buka popup ke: `http://localhost:5001/v1/auth/google/popup?origin=http://localhost:3000&session_id=<uuid_acak>`
2. Tunggu callback atau lakukan polling token pada: `GET http://localhost:5001/v1/auth/google/session/<uuid_acak>`
3. Ambil `token` dari respons JSON.

### Metode D: LiteLLM Virtual Key (`sk-...`) — **Direkomendasikan untuk Backend Service Account, Pipeline Otomatisasi, & Autonomous Agent**
Key yang dibuat di dashboard LiteLLM UI (`http://127.0.0.1:4000/ui/api-keys/`) dengan opsi **`You`**, **`Service Account`**, **`Another User`**, atau **`Agent`** kini dapat digunakan langsung ke Boson Gateway (:8088) tanpa memotong/melewati fitur gateway!

- **Header yang dikirim**:
  ```http
  Authorization: Bearer sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
  X-Boson-Platform-Id: pipeline
  ```
  *(Platform ID yang didukung untuk pipeline: `pipeline`, `service-account`, `agent-runtime`, atau `boson-desktop`)*
- **Jaminan Zero-Bypass Arsitektur**:
  1. **Atomic Wallet & Billing Tetap Berjalan**: Saldo dompet Boson tetap terpotong otomatis (`Bonus` $\rightarrow$ `Subscription` $\rightarrow$ `Normal`).
  2. **Realtime Two-Way Spend Sync**: Pengeluaran token langsung tercatat di tabel `usage_ledger` Boson sekaligus memperbarui kolom **Spend** pada virtual key di UI LiteLLM (:4000) secara realtime.
  3. **Model & Budget Guard Terintegrasi**: Pilihan batasan model (`models`) dan batas budget maksimal (`max_budget`) yang disetel di UI LiteLLM ditegakkan secara ketat oleh Gateway (HTTP 403 jika melebihi batas atau memilih model di luar izin).

---

## 5. Spesifikasi Endpoint Inferensi

Gateway mendukung **Anthropic Messages** dan **OpenAI Chat Completions**. Pilih protokol yang paling kompatibel dengan library klien Anda:

### 5.1. Anthropic Messages API (`POST /v1/messages`)
Format native yang digunakan oleh Boson Studio, Claude Client, dan DeepSeek Harness.

- **Headers**:
  ```http
  POST /v1/messages HTTP/1.1
  Host: 127.0.0.1:8088
  Content-Type: application/json
  Authorization: Bearer <token_atau_sk_boson>
  X-Boson-Platform-Id: boson-desktop
  anthropic-version: 2023-06-01
  Accept: text/event-stream
  ```
- **Body**:
  ```json
  {
    "model": "deepseek-flash",
    "max_tokens": 4096,
    "messages": [
      { "role": "user", "content": "Tuliskan fungsi binary search dalam TypeScript." }
    ]
  }
  ```

### 5.2. OpenAI Chat Completions API (`POST /v1/chat/completions`)
Format universal untuk integrasi dengan library `@google/genai`, `openai`, LangChain, Cursor, OpenCode, dan SDK Python.

- **Headers**:
  ```http
  POST /v1/chat/completions HTTP/1.1
  Host: 127.0.0.1:8088
  Content-Type: application/json
  Authorization: Bearer <token_atau_sk_boson>
  X-Boson-Platform-Id: boson-desktop
  ```
- **Body**:
  ```json
  {
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "Anda adalah asisten AI coding ahli." },
      { "role": "user", "content": "Halo! Bantu optimasi query PostgreSQL ini." }
    ],
    "stream": true
  }
  ```

### Model-Model yang Didukung:
- `deepseek-flash` / `deepseek-chat` (DeepSeek V3 / V4 Flash - Cepat, hemat, cerdas coding)
- `deepseek-reasoner` (DeepSeek R1 - Deep Reasoning / Matematika / Arsitektur)
- `deepseek-v4-pro` (Kapasitas konteks besar hingga 1M token)
- `claude-3-5-sonnet` (Opsional jika upstream LiteLLM dikonfigurasi)

---

## 6. Penanganan Saldo & Error Penting (Error Handling)

### 6.1. Saldo Habis (`HTTP 402 Payment Required`)
Jika total saldo user (`bonus_balance + subscription_balance + normal_balance`) kurang dari ambang batas minimum (`$0.0005`), gateway **menolak request sebelum mengirim ke model** (Pre-Flight Guard).

- **Contoh Respons 402**:
  ```json
  {
    "error": {
      "type": "insufficient_quota",
      "code": "insufficient_quota",
      "status": 402,
      "message": "Saldo Boson Studio Anda telah habis. Silakan lakukan deposit atau berlangganan untuk melanjutkan.",
      "details": {
        "current_balance": "0.0000",
        "required_minimum": "0.0005",
        "currency": "USD",
        "top_up_url": "http://127.0.0.1:8088/top_up"
      }
    }
  }
  ```
- **Tindakan Klien**: Tangkap status `402`, lalu tampilkan dialog modal atau buka `details.top_up_url` di browser pengguna.

### 6.2. Platform Ditolak (`HTTP 403 Forbidden`)
```json
{
  "error": {
    "code": "platform_forbidden",
    "message": "Akses dari platform 'xxx' belum diizinkan oleh administrator."
  }
}
```
- **Tindakan Klien**: Pastikan header `X-Boson-Platform-Id` mengirim ID yang sudah didaftarkan di tabel `allowed_platforms`.

### 6.3. Rate Limit Exceeded (`HTTP 429 Too Many Requests`)
```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Terlalu banyak permintaan. Silakan coba lagi nanti."
  }
}
```
- **Tindakan Klien**: Baca header `Retry-After` (dalam detik) dan lakukan exponential backoff retry.

---

## 7. Endpoint Saldo, Kuota, & Billing untuk Frontend

Aplikasi frontend dapat menampilkan status saldo dan paket pengguna secara realtime:

| Endpoint | Method | Fungsi |
| :--- | :---: | :--- |
| `/v1/quota` | `GET` | Mengambil rincian total saldo, deposit balance, subscription balance, dan bonus balance. |
| `/api/v0/users/get_user_summary` | `GET` | Ringkasan profil, tier (`free`/`pro`), dan balance wallets. |
| `/v1/pricing` | `GET` | Daftar tarif live pricing per 1M token (Wholesale + fair margin). Bebas auth. |
| `/api/v0/billing/plans` | `GET` | Daftar paket langganan dan perbandingan fitur. |
| `/api/v0/billing/create-deposit` | `POST` | Membuat invoice top-up QRIS/VA Xendit (`amount_usd`). |
| `/api/v0/billing/subscribe` | `POST` | Membuat invoice langganan Pro/Starter (`plan_tier`). |
| `/billing` atau `/top_up` | `GET` | Web Portal HTML interaktif bawaan untuk top-up dan manajemen API Key. |

---

## 8. Contoh Kode Integrasi Siap Pakai

### Contoh A: JavaScript / TypeScript (Fetch Native)
```typescript
interface SendPromptParams {
  apiKey: string;
  prompt: string;
  onChunk?: (text: string) => void;
}

export async function askBosonAssistant({ apiKey, prompt, onChunk }: SendPromptParams) {
  const GATEWAY_URL = 'http://127.0.0.1:8088';

  const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-Boson-Platform-Id': 'boson-desktop',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  });

  // 1. Handle Saldo Habis
  if (response.status === 402) {
    const errorData = await response.json();
    throw new Error(`[SALDO HABIS]: Silakan top up di ${errorData.error.details.top_up_url}`);
  }

  if (!response.ok) {
    throw new Error(`Gateway Error (${response.status}): ${await response.text()}`);
  }

  // 2. Baca Stream SSE (Server-Sent Events)
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  if (!reader) return '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const parsed = JSON.parse(line.slice(6));
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            onChunk?.(delta);
          }
        } catch {
          // Abaikan parsing error pada chunk parsial
        }
      }
    }
  }

  return fullText;
}
```

### Contoh B: Node.js / Electron dengan Library `openai` Resmi
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.BOSON_API_KEY, // Isi dengan sk_boson_...
  baseURL: 'http://127.0.0.1:8088/v1',
  defaultHeaders: {
    'X-Boson-Platform-Id': 'boson-desktop',
  },
});

async function run() {
  try {
    const stream = await client.chat.completions.create({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Halo dari Electron App!' }],
      stream: true,
    });

    for await (const chunk of stream) {
      process.stdout.write(chunk.choices[0]?.delta?.content || '');
    }
  } catch (err) {
    if (err.status === 402) {
      console.error('Kredit habis. Kunjungi http://127.0.0.1:8088/top_up');
    } else {
      console.error('Inference error:', err);
    }
  }
}

run();
```

### Contoh C: Python (Requests & OpenAI SDK)
```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ.get("BOSON_API_KEY", "sk_boson_your_key_here"),
    base_url="http://127.0.0.1:8088/v1",
    default_headers={"X-Boson-Platform-Id": "boson-cli"}
)

response = client.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "You are a code optimization bot."},
        {"role": "user", "content": "Explain async generator in Python."}
    ],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
print()
```

### Contoh D: cURL Sederhana
```bash
curl -N http://127.0.0.1:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk_boson_your_key_here" \
  -H "X-Boson-Platform-Id: boson-cli" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Tes panggil API Boson"}],
    "stream": true
  }'
```

---

## 9. Checklist Integrasi untuk Agent / Developer

- [ ] **1. Tentukan Platform ID**: Gunakan `boson-desktop` (default) atau daftarkan ID baru di database.
- [ ] **2. Simpan Kunci**: Simpan `sk_boson_...` di file `.env` klien atau keyring aman OS.
- [ ] **3. Pasang Header Wajib**: Selalu sertakan `Authorization: Bearer <key>` dan `X-Boson-Platform-Id: <id>`.
- [ ] **4. Tangani Status HTTP 402**: Buat dialog redirect ke `http://<host>:8088/top_up` saat kuota habis.
- [ ] **5. CORS Allowlist (Untuk Web App Browser)**: Jika aplikasi web Anda berjalan di domain baru (misal `http://localhost:5173` atau `https://app.anda.com`), tambahkan domain tersebut ke environment variable `ALLOWED_ORIGINS` di backend gateway.
- [ ] **6. Monitor Kuota**: Tampilkan widget sisa saldo dengan memanggil `GET /v1/quota` secara periodik di header/navbar aplikasi Anda.
