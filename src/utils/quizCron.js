/**
 * Quiz Event cron tetikleyicisi.
 *
 * Bot always-on olduğu için Vercel cron yerine burada setInterval kullanıyoruz.
 * Web (discoweb-main) tarafında iki endpoint var:
 *   - POST /api/cron/quiz-tick    -> state machine (5sn'de bir tetiklenir)
 *   - POST /api/cron/quiz-payout  -> ödül dağıtımı (60sn'de bir tetiklenir)
 *
 * Gerekli env:
 *   WEB_URL              -> https://discoweb-test.vercel.app gibi
 *   QUIZ_CRON_SECRET     -> web ile aynı string olmalı (yoksa endpoint açık çalışır
 *                           ama production'da mutlaka set edilmeli)
 *
 * Hata davranışı: HTTP hatası loglanır, asla throw etmez (bot'u düşürmez).
 */

const TICK_INTERVAL_MS = Number(process.env.QUIZ_TICK_INTERVAL_MS || 5_000);
const PAYOUT_INTERVAL_MS = Number(process.env.QUIZ_PAYOUT_INTERVAL_MS || 60_000);

function getBase() {
    const base = process.env.WEB_URL || process.env.WEB_BASE_URL || process.env.NEXT_PUBLIC_APP_URL;
    if (!base) return null;
    return base.replace(/\/+$/, '');
}

function buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const secret = process.env.QUIZ_CRON_SECRET;
    if (secret) headers.Authorization = `Bearer ${secret}`;
    return headers;
}

async function hit(path) {
    const base = getBase();
    if (!base) {
        console.warn('[quiz-cron] WEB_URL tanımlı değil, quiz cron atlanıyor');
        return null;
    }
    try {
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: buildHeaders(),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.warn(`[quiz-cron] ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
            return null;
        }
        return await res.json().catch(() => null);
    } catch (err) {
        console.warn(`[quiz-cron] ${path} fetch failed:`, err.message);
        return null;
    }
}

let tickHandle = null;
let payoutHandle = null;
let tickRunning = false;
let payoutRunning = false;

async function runTick() {
    if (tickRunning) return; // overlap koruması (5sn'de bir, endpoint yavaşlarsa atlasın)
    tickRunning = true;
    try {
        const result = await hit('/api/cron/quiz-tick');
        if (result?.summary && (result.summary.started || result.summary.finished || result.summary.locked)) {
            console.log('[quiz-cron] tick:', JSON.stringify(result.summary));
        }
    } finally {
        tickRunning = false;
    }
}

async function runPayout() {
    if (payoutRunning) return;
    payoutRunning = true;
    try {
        const result = await hit('/api/cron/quiz-payout');
        if (Array.isArray(result?.results) && result.results.length > 0) {
            console.log('[quiz-cron] payout:', JSON.stringify(result.results));
        }
    } finally {
        payoutRunning = false;
    }
}

function start() {
    if (tickHandle || payoutHandle) {
        console.warn('[quiz-cron] zaten çalışıyor, tekrar başlatılmadı');
        return;
    }
    const base = getBase();
    if (!base) {
        console.warn('[quiz-cron] WEB_URL yok, quiz cron başlatılmadı');
        return;
    }
    console.log(`[quiz-cron] başlıyor → ${base} (tick=${TICK_INTERVAL_MS}ms, payout=${PAYOUT_INTERVAL_MS}ms, secret=${process.env.QUIZ_CRON_SECRET ? 'set' : 'MISSING'})`);

    tickHandle = setInterval(() => { void runTick(); }, TICK_INTERVAL_MS);
    payoutHandle = setInterval(() => { void runPayout(); }, PAYOUT_INTERVAL_MS);

    // İlk çalıştırma anında bir tick at, böylece kullanıcı beklemeden state ilerler
    setTimeout(() => { void runTick(); }, 1500);
    setTimeout(() => { void runPayout(); }, 4000);
}

function stop() {
    if (tickHandle) clearInterval(tickHandle);
    if (payoutHandle) clearInterval(payoutHandle);
    tickHandle = null;
    payoutHandle = null;
    console.log('[quiz-cron] durduruldu');
}

module.exports = { start, stop, runTick, runPayout };
