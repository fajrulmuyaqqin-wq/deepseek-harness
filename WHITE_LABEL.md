# Dokumentasi White-Label: Boson Studio

Dokumen ini mencatat seluruh konfigurasi, arsitektur slot merek, dan perubahan kode untuk mengubah identitas default DeepSeek Harness menjadi **Boson Studio** di bawah naungan ekosistem induk **BOSON**.

---

## 1. Identitas Merek & Tema Ekosistem

* **Parent Ecosystem**: **BOSON** (Terinspirasi dari fisika partikel fundamental: *Boson, Quark, Photon, Gluon, Hadron*). Menggambarkan peran harness Cordis all-plugin sebagai "force carrier" yang mengikat seluruh kapabilitas multi-agen secara modular.
* **Product Name**: **Boson Studio** (*Autonomous AI Engineering Studio*).
* **Visual Theme**: Quantum Orbital System — Inti partikel bercahaya (*central core*) yang dikelilingi tiga orbit kuantum elips simetris dan simpul-simpul energi (*quantum nodes*).

---

## 2. Arsitektur Brand Slots & UI Injection

DeepSeek Harness menggunakan sistem Cordis Slot Injection untuk rendering merek antarmuka:

```
┌─────────────────────────────────────────────────────────────┐
│ Web Browser / Electron Shell                                │
│ ├─ <title>Boson Studio</title>                              │
│ ├─ Favicon: favicon.svg / favicon-dark.svg (Quantum Mark)   │
│                                                             │
│ ┌───────────────────────┬─────────────────────────────────┐ │
│ │ Left Sidebar          │ Chat / Conversation Area        │ │
│ │                       │                                 │ │
│ │ [Mark] [BOSON STUDIO] │        Empty Hero Screen        │ │
│ │  (24px) (156x24px)    │                                 │ │
│ │                       │           [Hero Mark]           │ │
│ │  sidebar.brand.mark   │             (34px)              │ │
│ │  sidebar.brand.name   │   conversation.hero.brand.mark  │ │
│ │                       │                                 │ │
│ └───────────────────────┴─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

1. **`sidebar.brand.mark`**:
   - Di-render pada [`SidebarRoot.tsx`](file:///var/home/fazdev/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx) saat sidebar melebar (ukuran 24px) dan saat sidebar menciut menjadi rail icon.
   - Diisi oleh komponen `BosonBrandMark`.
2. **`sidebar.brand.name`**:
   - Di-render di samping mark pada [`SidebarRoot.tsx`](file:///var/home/fazdev/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx).
   - Diisi oleh komponen `BosonBrandName` (`viewBox="26 0 156 24"`).
3. **`conversation.hero.brand.mark`**:
   - Di-render di tengah halaman chat baru pada [`EmptyHero.tsx`](file:///var/home/fazdev/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx).
   - Diisi fallback langsung berupa quantum mark dengan animasi pulse saat hover.
4. **Fallback String (`brand.localBuild`)**:
   - String bawaan bila slot tidak aktif diubah dari `DSH Local Build` menjadi `Boson Studio` pada kamus lokalisasi (`en.ts` dan `zh.ts`).
5. **AI Persona & System Prompt (`personaPrefix`)**:
   - Dikonfigurasi pada bundle Web [`cordis.patch.yml`](file:///var/home/fazdev/deepseek-harness/packages/bundle/web-app/cordis.patch.yml):
     `"You are Boson Studio, an AI engineering assistant powered by the {{model}} model."`

---

## 3. Rincian Berkas yang Dimodifikasi

### A. Komponen Visual & Slot Merek
* **[`packages/client/ui-brand-official/src/client/Brand.tsx`](file:///var/home/fazdev/deepseek-harness/packages/client/ui-brand-official/src/client/Brand.tsx)**:
  - Mengimplementasikan `BosonBrandMark` (SVG quantum orbital 24px).
  - Mengimplementasikan `BosonBrandName` (SVG wordmark BOSON + kapsul STUDIO).
  - Mengimplementasikan `BosonHeroMark` (SVG quantum core 34px).
  - Mengekspor alias `OfficialBrandMark` dan `OfficialBrandName` untuk kompatibilitas contract.

* **[`packages/client/ui-brand-official/src/client/index.ts`](file:///var/home/fazdev/deepseek-harness/packages/client/ui-brand-official/src/client/index.ts)**:
  - Menghapus pembatasan profil eksklusif sehingga merek Boson aktif secara default pada web dev/build biasa.
  - Mempertahankan proteksi jika profil eksplisit disetel ke `'local'`.

* **[`packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx`](file:///var/home/fazdev/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx)**:
  - Mengganti fallback SVG maskot ikan paus menjadi logo kuantum Boson interaktif (dengan animasi breathing pulse `3.6 -> 4.4 -> 3.6` saat cursor melayang di atasnya).
  - Menghapus path geometri yang sudah tidak digunakan (`HERO_SWIM_UP_PATH`, `HERO_SWIM_DOWN_PATH`).

### B. Header Halaman, Title & Favicon
* **[`apps/web/index.html`](file:///var/home/fazdev/deepseek-harness/apps/web/index.html)**:
  - Mengubah `<title>DSH Local Build</title>` menjadi `<title>Boson Studio</title>`.
* **[`apps/web/public/favicon.svg`](file:///var/home/fazdev/deepseek-harness/apps/web/public/favicon.svg)**:
  - Mengganti icon hitam untuk mode terang dengan lambang orbital kuantum Boson.
* **[`apps/web/public/favicon-dark.svg`](file:///var/home/fazdev/deepseek-harness/apps/web/public/favicon-dark.svg)**:
  - Mengganti icon putih untuk mode gelap dengan lambang orbital kuantum Boson.

### C. Lokalisasi & Fallback Label
* **[`packages/client/locale/src/locales/en.ts`](file:///var/home/fazdev/deepseek-harness/packages/client/locale/src/locales/en.ts)**:
  - Mengubah `'brand.localBuild': 'Boson Studio'`.
* **[`packages/client/locale/src/locales/zh.ts`](file:///var/home/fazdev/deepseek-harness/packages/client/locale/src/locales/zh.ts)**:
  - Mengubah `'brand.localBuild': 'Boson Studio'`.

### D. Identitas Model & Persona Asisten
* **[`packages/bundle/web-app/cordis.patch.yml`](file:///var/home/fazdev/deepseek-harness/packages/bundle/web-app/cordis.patch.yml)**:
  - Mengubah `personaPrefix` sistem prompt menjadi:
    ```yaml
    - id: system-prompt
      config:
        personaPrefix: >-
          You are Boson Studio, an AI engineering assistant powered by the {{model}} model.
    ```

---

## 4. Cara Pengujian & Verifikasi

### Menjalankan Unit Tests Terkait Merek
```bash
# Uji coba slot merek resmi
pnpm exec vitest run packages/client/ui-brand-official

# Uji coba UI conversation & empty hero
pnpm exec vitest run packages/client/ui-conversation

# Uji coba lokalisasi
pnpm exec vitest run packages/client/locale
```

### Mengompilasi Ulang Artifacts
```bash
pnpm run build:artifacts
```
*Hasil yang diharapkan: 7 gates passed, 453 client artifacts tercatat.*

### Menjalankan Web Server
```bash
node --import tsx/esm apps/cli/src/bin.ts web --no-open
```
Buka URL ber-token yang tercantum di terminal (misal: `http://127.0.0.1:3080/?token=...`).
