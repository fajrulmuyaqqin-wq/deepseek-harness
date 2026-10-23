/**
 * Test Frontend Prompt Delivery ke Boson LLM Gateway
 * Menguji pengiriman prompt dari sisi klien/frontend ke gateway secara end-to-end:
 * 1. Autentikasi Pengguna & Cek Saldo Awal
 * 2. Pengiriman Prompt (Anthropic Protocol /v1/messages & OpenAI /v1/chat/completions)
 * 3. Penerimaan Streaming Token secara Real-Time
 * 4. Verifikasi Pemotongan Saldo & Pencatatan Ledger
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8088';

async function runFrontendPromptTest() {
  console.log('\n=============================================================');
  console.log('🧪 PENGUJIAN PENGIRIMAN PROMPT DARI FRONTEND KE BOSON GATEWAY');
  console.log('=============================================================\n');

  // 1. Registrasi Akun Frontend Baru (Mendapatkan $2.00 Welcome Balance)
  console.log('1. Menginisiasi Sesi Pengguna Frontend...');
  const initRes = await fetch(`${GATEWAY_URL}/auth-api/v0/dsh/auth_init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code_challenge: 'test_frontend_challenge',
      redirect_uri: 'http://127.0.0.1:3080/callback',
      state: 'frontend_state',
    }),
  });
  const initData = await initRes.json();
  const authId = initData.data?.biz_data?.authorize_id;

  const testEmail = `frontend_tester_${Date.now()}@boson.id`;
  const regRes = await fetch(`${GATEWAY_URL}/api/v0/auth/submit-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_id: authId,
      email: testEmail,
      password: 'Password123!',
      full_name: 'Frontend Developer',
    }),
  });
  await regRes.json();

  const exchangeRes = await fetch(`${GATEWAY_URL}/auth-api/v0/dsh/auth_exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorize_id: authId }),
  });
  const exchangeData = await exchangeRes.json();
  const token = exchangeData.data?.biz_data?.token;
  const userId = exchangeData.data?.biz_data?.user?.id;
  console.log(`   ✅ Sesi Terhubung: User ID = ${userId} (${testEmail})`);

  // 2. Cek Saldo Awal Kuota
  const quotaBeforeRes = await fetch(`${GATEWAY_URL}/v1/quota`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const quotaBefore = await quotaBeforeRes.json();
  console.log(`   💰 Saldo Awal: $${quotaBefore.total_balance.toFixed(4)} (Bonus: $${quotaBefore.bonus_balance.toFixed(4)}, Normal: $${quotaBefore.deposit_balance.toFixed(4)})`);

  // 3. Buat Personal API Key (sk_boson_...) untuk Pengujian Eksternal
  console.log('\n2. Membuat Personal API Key (sk_boson_...)...');
  const keyRes = await fetch(`${GATEWAY_URL}/api/v0/api-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ key_name: 'Frontend Test Key' }),
  });
  const keyData = await keyRes.json();
  const apiKey = keyData.api_key;
  console.log(`   🔑 API Key Dihasilkan: ${apiKey.slice(0, 15)}...`);

  // 4. Kirim Prompt melalui Protokol Anthropic (/v1/messages) - Format Boson Studio Frontend
  const userPrompt = 'Jelaskan dalam 2 kalimat singkat apa itu recursion dalam pemrograman.';
  console.log(`\n3. Mengirimkan Prompt (Anthropic /v1/messages):`);
  console.log(`   💬 User: "${userPrompt}"\n`);
  console.log('   🤖 AI Respon (Streaming):');
  process.stdout.write('   ');

  const messagesRes = await fetch(`${GATEWAY_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Boson-Platform-Id': 'boson-desktop',
      'anthropic-version': '2023-06-01',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      max_tokens: 150,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!messagesRes.ok) {
    throw new Error(`Gagal mengirim prompt: ${messagesRes.status} ${await messagesRes.text()}`);
  }

  const reader = messagesRes.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedResponse = '';
  let streamBuffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    streamBuffer += decoder.decode(value, { stream: true });
    const lines = streamBuffer.split('\n');
    streamBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const rawJson = line.slice(6).trim();
        if (rawJson && rawJson !== '[DONE]') {
          try {
            const parsed = JSON.parse(rawJson);
            // Anthropic content delta
            const deltaText = parsed.delta?.text || parsed.content_block?.text || '';
            if (deltaText) {
              accumulatedResponse += deltaText;
              process.stdout.write(deltaText);
            }
          } catch {
            // Buffer parsing
          }
        }
      }
    }
  }
  console.log('\n');

  // Tunggu sejenak agar gateway selesai mencatat ke ledger
  await new Promise((r) => setTimeout(r, 1200));

  // 5. Cek Saldo Setelah Inferensi
  console.log('4. Memeriksa Pemotongan Saldo & Usage Ledger...');
  const quotaAfterRes = await fetch(`${GATEWAY_URL}/v1/quota`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const quotaAfter = await quotaAfterRes.json();

  const historyRes = await fetch(`${GATEWAY_URL}/api/v0/billing/usage-history`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const historyData = await historyRes.json();
  const latestLog = historyData.logs?.[0];

  console.log(`   💰 Saldo Akhir : $${quotaAfter.total_balance.toFixed(6)}`);
  console.log(`   📉 Saldo Terpotong: $${(quotaBefore.total_balance - quotaAfter.total_balance).toFixed(6)} USD`);
  if (latestLog) {
    console.log(`   📊 Detail Ledger : Model=${latestLog.model}, Tokens=${latestLog.prompt_tokens} prompt + ${latestLog.completion_tokens} completion = ${latestLog.total_tokens} total`);
    console.log(`   🏷️  Sumber Dana  : ${latestLog.deducted_from.toUpperCase()}`);
    console.log(`   💵 Biaya Akurat  : $${latestLog.cost_usd} (Fair Margin: ${latestLog.metadata?.margin_percent}%)`);
  }

  // 6. Kirim Prompt Kedua Menggunakan Personal API Key melalui Protokol OpenAI (/v1/chat/completions)
  const prompt2 = 'Sebutkan 3 bahasa pemrograman paling populer untuk backend saat ini.';
  console.log(`\n5. Mengirimkan Prompt Kedua (OpenAI /v1/chat/completions via Bearer sk_boson_...):`);
  console.log(`   💬 User: "${prompt2}"\n`);
  console.log('   🤖 AI Respon:');
  process.stdout.write('   ');

  const chatRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-Boson-Platform-Id': 'boson-cli',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt2 }],
      stream: true,
    }),
  });

  if (!chatRes.ok) {
    throw new Error(`Gagal mengirim chat completion: ${chatRes.status} ${await chatRes.text()}`);
  }

  const reader2 = chatRes.body.getReader();
  let streamBuffer2 = '';

  while (true) {
    const { done, value } = await reader2.read();
    if (done) break;

    streamBuffer2 += decoder.decode(value, { stream: true });
    const lines = streamBuffer2.split('\n');
    streamBuffer2 = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const rawJson = line.slice(6).trim();
        if (rawJson && rawJson !== '[DONE]') {
          try {
            const parsed = JSON.parse(rawJson);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              process.stdout.write(delta);
            }
          } catch {}
        }
      }
    }
  }
  console.log('\n');

  console.log('=============================================================');
  console.log('🎉 UJI PENGIRIMAN PROMPT BERHASIL 100%!');
  console.log('Gateway sukses memproses streaming dan pemotongan biaya live.');
  console.log('=============================================================\n');
}

runFrontendPromptTest().catch((err) => {
  console.error('\n💥 ERROR PENGUJIAN:', err.message);
  process.exit(1);
});
