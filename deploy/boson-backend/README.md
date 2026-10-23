# Panduan Deployment Backend Boson Studio (Supabase Self-Hosted)

Direktori ini memuat blueprint produksi lengkap untuk menjalankan backend mandiri **Boson Studio** di Server / VPS Linux (Ubuntu / Debian / AlmaLinux).

Stack ini mencakup:
1. **Supabase PostgreSQL & GoTrue Auth**: Database pengguna, sistem autentikasi, dan sesi.
2. **PostgreSQL Triggers & Wallet Ledger**: Skema dompet otomatis ($2 gratis untuk user baru, pencatatan saldo top-up & bonus).
3. **Boson Custom Gateway**:
   - Mendukung alur OAuth2 PKCE untuk dialog login Boson Studio.
   - Endpoint profil (`/auth-api/v0/users/current`) dan saldo (`/api/v0/users/get_user_summary`).
   - **Inference Reverse Proxy**: Menghitung token streaming dan memotong saldo kredit user secara otomatis, menggunakan Master Key Anda.
4. **Supabase Studio Dashboard**: Antarmuka web admin untuk memantau pendaftaran user, saldo, dan tabel database.

---

## 1. Persiapan VPS

Spesifikasi VPS yang direkomendasikan:
- **OS**: Ubuntu 22.04 LTS atau 24.04 LTS
- **RAM**: Minimal 2 GB (Rekomendasi 4 GB)
- **CPU**: 2 vCPU
- **Disk**: 40 GB SSD / NVMe

Langkah instalasi awal di VPS:
```bash
# Update sistem dan pasang Docker & Compose
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw

# Install Docker resmi
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

---

## 2. Salin Folder Blueprint ke VPS

Anda dapat menyalin folder `deploy/boson-backend` ke VPS menggunakan rsync atau SCP:
```bash
scp -r deploy/boson-backend user@ip_vps_anda:/opt/boson-backend
```

Masuk ke direktori server:
```bash
cd /opt/boson-backend
```

---

## 3. Konfigurasi Environment (`.env`)

Salin file contoh konfigurasi:
```bash
cp .env.example .env
nano .env
```

Sesuaikan nilai-nilai berikut:
1. `POSTGRES_PASSWORD`: Buat kata sandi yang kuat untuk database Anda.
2. `JWT_SECRET`: Buat string acak minimal 32 karakter (misal: `openssl rand -base64 32`).
3. `PLATFORM_PUBLIC_URL`: Masukkan domain backend publik Anda (misal `https://api.boson.id`).
4. `DEEPSEEK_MASTER_KEY`: Masukkan API Key DeepSeek utama Anda (kunci ini akan disimpan aman di server backend, tidak akan pernah terlihat oleh user).

---

## 4. Jalankan Stack Menggunakan Docker Compose

Jalankan container:
```bash
docker compose up -d --build
```

Periksa status container:
```bash
docker compose ps
```

Container berikut akan aktif:
- `boson-db`: PostgreSQL di port 5432
- `boson-auth`: GoTrue Auth di port 9999
- `boson-rest`: PostgREST API
- `boson-gateway`: Boson Custom Gateway di port 8080
- `boson-studio-dashboard`: Dashboard Admin Supabase di port 3001

---

## 5. Konfigurasi Domain & SSL Otomatis (Caddy)

Pasang Caddy untuk mengaktifkan HTTPS otomatis gratis (Let's Encrypt):
```bash
sudo apt install -y caddy
```

Edit `/etc/caddy/Caddyfile`:
```caddy
api.boson.id {
    reverse_proxy localhost:8080
}

admin.boson.id {
    # Batasi akses dashboard hanya untuk IP Anda jika diperlukan
    reverse_proxy localhost:3001
}
```

Terapkan konfigurasi:
```bash
sudo systemctl restart caddy
```

---

## 6. Menghubungkan Aplikasi Boson Studio ke Backend Baru

Setelah backend aktif di domain Anda (misal `https://api.boson.id`):

Di sisi client Boson Studio, Anda cukup memperbarui file konfigurasi profil Cordis:
`packages/bundle/base/cordis.patch.yml` (atau file overlay runtime):

```yaml
- id: deepseek-account
  config:
    platformOrigin: https://api.boson.id
    inferenceOrigin: https://api.boson.id
```

Sekarang:
1. Tombol **Sign In** di Boson Studio akan membuka halaman login akun Boson Studio Anda sendiri.
2. User baru yang mendaftar akan otomatis mendapatkan bonus saldo trial \$2.00 di tabel `wallets`.
3. Tampilan saldo di menu akun akan membaca saldo riil dari database PostgreSQL Anda.
4. Setiap prompt AI yang dijalankan akan melewati inference proxy Anda, dipotong saldonya secara adil berdasarkan jumlah token, dan menghasilkan keuntungan langsung untuk platform Anda!

---

## 7. Menghubungkan Aethel Studio & Developer CLI (Omnipresent Access)

Satu akun pengguna dapat digunakan di berbagai platform yang Anda izinkan:

### A. Menggunakan Personal Access Token (`sk_boson_...`)
Pengguna dapat meng-generate API Key dari endpoint atau antarmuka akun:
```bash
curl -X POST https://api.boson.id/api/v0/api-keys \
  -H "Authorization: Bearer <user_session_token>" \
  -H "Content-Type: application/json" \
  -d '{"key_name": "Laptop Coding", "allowed_platforms": ["*"]}'
```
Kunci yang dikembalikan berupa `sk_boson_...` yang di-hash dengan SHA-256 di database (Zero-Trust).

### B. Konfigurasi di Aethel Studio / OpenDesign Daemon
Di lingkungan daemon OpenDesign:
```bash
export STUDIO_GATEWAY_URL="https://api.boson.id/v1"
export STUDIO_API_KEY="sk_boson_..."
export MYBRAND_GATEWAY_URL="https://api.boson.id/v1"
export MYBRAND_API_KEY="sk_boson_..."
```

### C. Menentukan Platform yang Diizinkan (Owner Allowlist)
Anda memiliki kendali penuh atas platform mana saja yang boleh terhubung. Buka Supabase Studio di `http://ip_vps:3001` → Tabel `allowed_platforms`:
- Tambah atau nonaktifkan platform (misal: aktifkan `boson-desktop`, `aethel-web`, `boson-vscode`, dll.).
- Request dari client di luar allowlist akan seketika ditolak dengan `403 Forbidden: Platform not authorized`.

