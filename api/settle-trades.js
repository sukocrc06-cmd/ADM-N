// api/settle-trades.js
//
// Vercel Sunucu Fonksiyonu — yarışma kuralı 6.13 "fiyat netleştirme"yi
// SUNUCUDA yapar. api/delete-user.js ve api/refresh-leaderboard.js ile AYNI
// ortam değişkenlerini kullanır; yeni kurulum GEREKTİRMEZ.
//
// ============================= NEDEN GEREKLİ =============================
//
// OPLab emirleri anında, ekrandaki (15 dk gecikmeli) fiyattan gerçekleştirir;
// ~17 dk sonra veri yetişince işlem fiyatı, emrin verildiği dakikanın GERÇEK
// fiyatına düzeltilir (oplabRules.js applyTrueUp). Bu düzeltme bugüne kadar
// SADECE yarışmacının tarayıcısında, sayfa açıkken yapılıyordu. Yarışmacı
// işlemden hemen sonra sayfayı kapatırsa düzeltme ertesi girişe kalıyor,
// bakiye "işlem yapmadığı halde" bir gün sonra değişiyordu (24 Ekim 2026,
// 3. hafta: Zülal Aktaş — 98.700 → 97.507 TL). Ayrıca o arada sıralamada
// netleşmemiş değer görünüyordu.
//
// Bu uç, sayfası KAPALI yarışmacıların bekleyen işlemlerini aynı formülle
// sunucuda netleştirir ve canlı sıralama özetini de günceller. Sayfası AÇIK
// olanlara dokunmaz (onların tarayıcısı zaten 1 dk'da bir netleştiriyor;
// iki yazarın çakışıp yarışmacının yeni emrini ezmesini önlemek için).
//
// ============================ NASIL TETİKLENİR ============================
//
// Vercel Hobby'de cron günde bir kez çalışabildiği için (bkz.
// refresh-leaderboard.js) zamanlayıcı OPLab backend'inde (Render, ücretli plan,
// hiç uyumuyor): main.py seans günlerinde 10:05–19:30 arası 5 dakikada bir bu
// ucu çağırır. Elle de çağrılabilir: POST /api/settle-trades
//
// ========================== GÜVENLİK / KÖTÜYE KULLANIM ==========================
//
// Kimlik doğrulaması İSTEMEZ, çünkü çağıranın verdiği hiçbir şeyi kullanmaz:
// girdiyi yok sayar; fiyatları yalnızca OPLab backend'inden, portföyleri
// yalnızca Firestore'dan okur ve yalnızca kurala göre zaten yapılması gereken
// düzeltmeyi yapar. Tek risk kota harcatmak; frenler:
//   1) finteclub/oplab_settle_state.lastRunAt — MIN_GAP_MS'den sık çalışmaz
//      (çağrı başına maliyet: 1 okuma).
//   2) Aynı lambda örneğinde INSTANCE_COOLDOWN_MS boyunca o 1 okuma da yok.
//
// ============================ YAZMA SÖZLEŞMESİ ============================
//
// oplab_portfolios/{e-posta}: finteclubBridge.js buildCloudRecord() ile AYNI
// alanlar; rev+1, deviceId 'server-settle', contentHash = bridge'in
// hashPortfolio() algoritmasının birebir kopyası. Tarayıcı bunu "başka bir
// cihazdan gelen daha yeni sürüm" olarak benimser. Transaction içinde rev
// değişmişse (yarışmacı o an işlem yaptıysa) yazılmaz, sonraki tura kalır.
// oplab_live_portfolio.competitors.{id}: equity/balance/openPnl güncellenir,
// `settledAt` damgası eklenir.

const admin = require('firebase-admin');
const R = require('../oplabRules.js');

const BACKEND = process.env.OPLAB_BACKEND || 'https://rekabet-testi.onrender.com';
const MIN_GAP_MS = 4 * 60 * 1000;
const INSTANCE_COOLDOWN_MS = 60 * 1000;
const ONLINE_MS = 5 * 60 * 1000;     // canlı özet bundan tazeyse sayfa açık say
const MAX_PORTFOLIOS = 60;
const PRICE_BATCH = 150;
const SERVER_DEVICE = 'server-settle';

let lastRunAt = 0;

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    throw new Error('Firebase servis hesabı ortam değişkenleri eksik (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).');
  }
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
}

// finteclubBridge.js stableStringify()/hashPortfolio() — BİREBİR kopya.
// Biri değişirse diğeri de değişmeli; aksi halde tarayıcı her turda içeriği
// "farklı" sanıp gereksiz senkron yapar.
function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function hashPortfolio(p) {
  if (!p) return null;
  const s = stableStringify(p);
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0;
    h2 = ((h2 << 5) + h2 + c) | 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + ':' + s.length;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Bekleyen netleştirmeleri verilen fiyatlarla uygular; toplam özkaynak etkisini döner.
function settle(p, prices, now) {
  let effect = 0, count = 0;
  R.pendingTrueUps(p, now).forEach((n) => {
    const mid = prices[R.priceKey(n.symbol, n.ts)];
    if (!(mid > 0)) return;
    const hist = n.market === 'VIOP' ? (p.viopHistory || []) : (p.history || []);
    const rec = hist.find((r) => r.id === n.id && r.ts === n.ts);
    if (!rec) return;
    effect += R.applyTrueUp(p, n.market, rec, mid);
    count++;
  });
  return { effect, count };
}

async function fetchPrices(items, fetchImpl) {
  const out = {};
  for (let i = 0; i < items.length; i += PRICE_BATCH) {
    const r = await fetchImpl(BACKEND + '/api/v1/prices-at', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.slice(i, i + PRICE_BATCH) }),
    });
    if (!r.ok) throw new Error('prices-at ' + r.status);
    const j = await r.json();
    Object.assign(out, (j && j.prices) || {});
  }
  return out;
}

async function run(db, opts) {
  const now = opts.now || Date.now();
  const fetchImpl = opts.fetch || fetch;
  const stateRef = db.collection('finteclub').doc('oplab_settle_state');
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(stateRef);
    const last = s.exists ? Number((s.data() || {}).lastRunAt) || 0 : 0;
    if (!opts.force && now - last < MIN_GAP_MS) return false;
    tx.set(stateRef, { lastRunAt: now }, { merge: true });
    return true;
  });
  if (!claimed) return { skipped: 'recent' };

  const liveRef = db.collection('finteclub').doc('oplab_live_portfolio');
  const live = await liveRef.get();
  const competitors = (live.exists && (live.data() || {}).competitors) || {};
  const candidates = Object.keys(competitors).map((id) => ({ id, c: competitors[id] || {} })).filter(({ c }) => {
    const t = Date.parse(c.updatedAt || '') || 0;
    return c.email && t && now - t > ONLINE_MS && now - t < R.RULES.trueUpMaxAgeMs + 86400000;
  }).slice(0, MAX_PORTFOLIOS);

  // 1) Bekleyenleri topla
  const loaded = [];
  for (const cand of candidates) {
    const ref = db.collection('oplab_portfolios').doc(String(cand.c.email).trim().toLowerCase());
    const snap = await ref.get();
    if (!snap.exists) continue;
    const rec = snap.data() || {};
    if (!rec.portfolio || typeof rec.portfolio.balance !== 'number') continue;
    const need = R.pendingTrueUps(rec.portfolio, now);
    if (need.length) loaded.push({ cand, ref, rec, need });
  }
  if (!loaded.length) return { candidates: candidates.length, settled: 0 };

  // 2) Gerçek fiyatlar (tek seferde)
  const items = [];
  loaded.forEach((l) => l.need.forEach((n) => items.push({ symbol: n.symbol, ts: n.ts })));
  const prices = await fetchPrices(items, fetchImpl);

  // 3) Her portföyü transaction içinde netleştir
  const results = [];
  for (const l of loaded) {
    const res = await db.runTransaction(async (tx) => {
      const snap = await tx.get(l.ref);
      if (!snap.exists) return null;
      const rec = snap.data() || {};
      if ((rec.rev || 0) !== (l.rec.rev || 0)) return { busy: true }; // yarışmacı o an yazdı → sonraki tur
      const p = JSON.parse(JSON.stringify(rec.portfolio));
      const out = settle(p, prices, now);
      if (!out.count) return null;
      tx.set(l.ref, Object.assign({}, rec, {
        portfolio: p,
        rev: (rec.rev || 0) + 1,
        deviceId: SERVER_DEVICE,
        updatedAt: new Date(now).toISOString(),
        contentHash: hashPortfolio(p),
      }));
      return { count: out.count, effect: out.effect, balance: p.balance };
    });
    if (!res || res.busy) { if (res) results.push({ id: l.cand.id, busy: true }); continue; }
    // Canlı sıralama özeti: özkaynak etkisi kadar kaydır (açık pozisyonların
    // piyasa değeri değişmediği için fark birebir bu etkidir).
    const c = l.cand.c;
    const patch = {};
    const base = `competitors.${l.cand.id}`;
    if (typeof c.equity === 'number') patch[`${base}.equity`] = r2(c.equity + res.effect);
    patch[`${base}.balance`] = r2(res.balance);
    if (typeof c.openPnl === 'number' && typeof c.equity === 'number') {
      // openPnl açık pozisyonların ort. maliyetine bağlı; netleştirme onu da kaydırır.
      patch[`${base}.openPnl`] = r2(c.openPnl + res.effect - (res.balance - (Number(c.balance) || 0)));
    }
    patch[`${base}.settledAt`] = new Date(now).toISOString();
    try { await liveRef.update(patch); } catch (e) { /* özet ikincil — sıralama bir sonraki tazelemede düzelir */ }
    results.push({ id: l.cand.id, count: res.count, effect: r2(res.effect) });
  }
  return { candidates: candidates.length, settled: results.filter((r) => r.count).length, results };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (Date.now() - lastRunAt < INSTANCE_COOLDOWN_MS) { res.status(204).end(); return; }
  lastRunAt = Date.now();
  try {
    const out = await run(getAdminApp().firestore(), {});
    if (out.skipped) { res.status(204).end(); return; }
    // Kişisel veri (isim/e-posta) dönmez — yalnızca sayılar.
    res.status(200).json({ ok: true, candidates: out.candidates, settled: out.settled, trades: (out.results || []).reduce((a, r) => a + (r.count || 0), 0) });
  } catch (e) {
    console.error('[settle-trades]', e);
    res.status(500).json({ error: 'settle_failed' });
  }
};

// Testler için
module.exports._run = run;
module.exports._hashPortfolio = hashPortfolio;
