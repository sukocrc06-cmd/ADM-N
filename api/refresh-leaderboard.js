// api/refresh-leaderboard.js
//
// Vercel Sunucu Fonksiyonu (Serverless Function) — ÜCRETSİZ, kart istemez
// (Vercel'in Hobby planında Serverless Functions dahildir). Yanındaki
// api/delete-user.js ile AYNI ortam değişkenlerini kullanır, yeni kurulum
// GEREKTİRMEZ.
//
// ============================= NEDEN GEREKLİ =============================
//
// Herkese açık site (index.html) yarış pistini ve genel sıralamayı
// finteclub/public_leaderboard belgesinden okur. O belgeyi bugüne kadar
// SADECE açık bir admin paneli yazıyordu: admin.html içindeki
// schedulePublicLeaderboard(), oplab_live_portfolio belgesine kurulmuş bir
// onSnapshot tetiklendikçe, en fazla 20 saniyede bir. Panel kapandığında
// yazım tamamen duruyordu — ama yarışma shared_state'te
// "competitionActive: true" olarak sürdüğü için site son yazılan satırları
// göstermeye devam ediyordu. 16–18 Ekim 2026'da site ~36 saatlik veriyi
// canlı sıralama gibi sundu.
//
// O olayın İLK yarısı index.html'de düzeltildi (bkz. PIST_BAYAT_MS): veri
// bayatsa site artık "CANLI" demiyor, griye düşüp "GÜNCELLENMİYOR" diyor.
// Bu dosya İKİNCİ yarısı: veriyi gerçekten tazeliyor.
//
// Neden zamanlanmış bir iş (cron) değil: Vercel'in Hobby planında cron
// günde EN FAZLA bir kez çalışabiliyor (daha sık yazılmış bir ifade deploy
// sırasında hata veriyor), dakikalık bir sıralama için işe yaramıyor.
// Firebase'in zamanlanmış işlevleri ise Blaze (kullandıkça öde) planı
// istiyor, yani Firebase projesine kart bağlamak gerekiyor.
//
// Bunun yerine İSTEK ÜZERİNE çalışıyor: index.html, okuduğu belgeyi
// bayat görünce (yarışma sürüyor ama damga 1 dakikadan eski) bu ucu
// tetikliyor, uç belgeyi tazeliyor, site birkaç saniye sonra tazelenmiş hâlini okuyor. Kimse siteye bakmıyorsa sıralama yazılmıyor — ki o an
// kimse de görmüyor. Kota açısından da en ucuzu bu.
//
// ========================== GÜVENLİK / KÖTÜYE KULLANIM ==========================
//
// Bu uç kimlik doğrulaması İSTEMEZ, çünkü çağıranın verdiği HİÇBİR ŞEYİ
// kullanmaz: girdiyi yok sayar, veriyi yalnızca yetkili kaynaklardan
// (shared_state + oplab_live_portfolio) okur ve yazdığı belge zaten
// herkese açık. Yani kimse buradan veri sızdıramaz ya da sıralamayı
// yönlendiremez. Geriye tek risk Firestore kotasını boşa harcatmak
// kalıyor; ona karşı iki fren var:
//   1) Belge MIN_WRITE_GAP_MS'den tazeyse hiçbir şey okunmadan/yazılmadan
//      204 dönülür (çağrı başına maliyet: 1 okuma).
//   2) Aynı lambda örneği içinde INSTANCE_COOLDOWN_MS boyunca o 1 okuma
//      bile yapılmaz.
// Admin paneli açıkken belge 20 sn'de bir yazıldığı için bu uç fiilen hiç
// çalışmaz — panel varsa söz panelin, çakışma olmaz.
//
// ===================== SIRALAMA MANTIĞI NEREDEN GELİYOR =====================
//
// Aşağıdaki buildRows(), admin.html'deki şu zincirin bire bir aynısıdır:
//   buildPublicLeaderboard() -> weekRoster() -> rankingPool()
//     -> buHaftaninYarismacisiMi() / isBoardHidden() / isRankExcluded()
//     -> LIG.applyPenalties() / penaltyFor() -> pctReturn()
//   + LIG.extendPublic()'in yalnızca "stats" kısmı.
// KURAL: admin.html'de bu fonksiyonlardan birini değiştirirsen BURAYI DA
// değiştir. İkisi ayrışırsa site ile panel farklı sıralama gösterir ve bu
// fark kimsenin gözüne çarpmaz. PAYLASILAN_SEMA.md'de de not var.
//
// extendPublic()'in geri kalanı (series, idx, lead, duel, spark, prevRank)
// bilerek atlanmıştır: onlar admin sekmesinin dakikalarca biriktirdiği
// örneklerden üretiliyor, sunucuda yeniden üretilemez. Zaten
// buildPublicLeaderboard() o alanları herkese açık belgeye yazmadan ÖNCE
// siliyor, yani belgede hiç bulunmuyorlar. Yazım {merge:true} ile
// yapıldığı için panelin yazdığı diğer alanlar (weeklyWinners, session,
// ceremonyAt, objectionDeadline, finalized…) olduğu gibi korunur.
//
// ============================== KURULUM ==============================
//
// Yeni bir şey yok. api/delete-user.js için Vercel'de tanımlı olan
// FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
// değişkenleri bu dosya için de yeterli; firebase-admin da package.json'da
// zaten var. Değişkenler eksikse uç 500 döner, index.html bunu sessizce
// yutar ve sayfa eskisi gibi (bayat uyarısıyla) çalışmaya devam eder —
// "hiçbir şey bozulmaz".

const admin = require('firebase-admin');

// Belge bu süreden tazeyse hiç dokunma. Admin paneli açıkken 20 sn'de bir
// yazıyor; 30 sn, panelle yarışa girmeden "panel kapalı" durumunu yakalar.
const MIN_WRITE_GAP_MS = 30000;
// Aynı lambda örneğine arka arkaya gelen çağrılar için ek fren.
const INSTANCE_COOLDOWN_MS = 15000;
const DEFAULT_BALANCE = 100000;
// admin.html: buildPublicLeaderboard() de ilk 60 satırı yazıyor.
const MAX_ROWS = 60;

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

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const ort = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - ort) * (b - ort), 0) / (arr.length - 1));
}

// admin.html: haftaFiltresiAktif() = ligSeasonOn() || !!state.ligFlow.
// ligSeasonOn() 27 Eylül 2026'dan beri kalıcı olarak false döndürüyor, o
// yüzden burada yalnızca ligFlow'a bakmak yeterli — ama sebebi bu, "ligFlow
// var mı" kuralı değil. ligSeasonOn tekrar açılırsa burayı da aç.
function haftaFiltresiAktif(s) {
  return !!s.ligFlow;
}

// admin.html: buHaftaninYarismacisiMi(a)
function buHaftaninYarismacisiMi(s, a) {
  if (!haftaFiltresiAktif(s)) return true;
  const c = Number(a && a.cohortId);
  if (!isFinite(c) || c <= 0) return true;
  return c === (Number(s.currentCohortId) || 1);
}

// admin.html: isRankExcluded(appId) — diskalifiye/kilitli kişi sıralamada
// GÖRÜNÜR ama dereceye giremez (şeffaflık, madde #121).
function isRankExcluded(a) {
  return !!(a && (a.disqualified || (a.lockedOut && !a.lockOverride)));
}

// admin.html: buildPublicLeaderboard() + weekRoster() + rankingPool()
function buildRows(s, competitors) {
  const base = Number(s.balance) || DEFAULT_BALANCE;
  const silinmis = s.deletedApplicationIds || {};
  const apps = Array.isArray(s.applications) ? s.applications : [];
  const aktif = !!s.competitionActive;

  // rankingPool(): aktif haftanın onaylı, geçmişe alınmamış, kilitli olmayan,
  // sıralamadan çıkarılmamış yarışmacıları.
  const uygun = apps.filter((a) =>
    a && a.status === 'onayli' && !a.pastCompetitor && buHaftaninYarismacisiMi(s, a)
    && !(a.lockedOut && !a.lockOverride) && !a.hiddenFromBoard
    && !silinmis[String(a.id)]);
  const uygunById = new Map(uygun.map((a) => [String(a.id), a]));

  const pool = [];
  Object.keys(competitors || {}).forEach((id) => {
    const a = uygunById.get(String(id));
    if (!a) return;
    const c = competitors[id] || {};
    // LIG.applyPenalties() / penaltyFor(): kural 21.2 ihlal kesintisi
    // sıralamaya yansır (equityRaw = yarışmacının bildirdiği değer).
    const kesinti = Number(a.penaltyTotal) || 0;
    let equity = Number(c.equity);
    if (!isFinite(equity)) equity = base;
    if (kesinti) equity = r2(equity - kesinti);
    pool.push({ id: String(id), name: c.name || a.name, equity: equity, app: a });
  });

  // weekRoster(): OPLab'a henüz giriş yapmamış onaylı yarışmacılar da
  // başlangıç bakiyesiyle listeye girer (waiting) — yalnızca yarışma sürerken.
  if (aktif) {
    const var_ = new Set(pool.map((c) => c.id));
    uygun.forEach((a) => {
      if (var_.has(String(a.id))) return;
      pool.push({ id: String(a.id), name: a.name, equity: base, app: a, waiting: true });
    });
  }

  const rows = pool
    .slice()
    .sort((x, y) => (y.equity || 0) - (x.equity || 0))
    .slice(0, MAX_ROWS)
    .map((c, i) => {
      const row = {
        rank: i + 1,
        name: String(c.name || 'İsimsiz').slice(0, 60),
        equity: r2(c.equity),
        // pctReturn(): başlangıç bakiyesine göre getiri
        pct: r2(base ? ((c.equity - base) / base) * 100 : 0),
      };
      // Firestore undefined kabul etmiyor; admin tarafı da bu alanları
      // yalnızca doğruyken yazıyor.
      if (isRankExcluded(c.app)) row.dq = true;
      if (c.waiting) row.waiting = true;
      return row;
    });

  // LIG.extendPublic(): istatistikler yalnızca dereceye girebilenlerden.
  const temiz = rows.filter((r) => !r.dq);
  let stats = null;
  if (temiz.length) {
    const pcts = temiz.map((r) => Number(r.pct) || 0);
    stats = {
      count: temiz.length,
      profitable: pcts.filter((x) => x > 0).length,
      losing: pcts.filter((x) => x < 0).length,
      avgPct: r2(pcts.reduce((a, b) => a + b, 0) / pcts.length),
      bestPct: Math.max.apply(null, pcts),
      worstPct: Math.min.apply(null, pcts),
      median: r2(median(pcts)),
      std: r2(std(pcts)),
      total: Math.round(temiz.reduce((a, r) => a + (Number(r.equity) || 0), 0)),
    };
  }

  return {
    v: 1,
    compName: s.compName || 'FinteLig',
    weekLabel: 'Hafta ' + (Number(s.currentCohortId) || 1),
    competitionActive: aktif,
    competitionEndsAt: s.competitionEndsAt || null,
    competitionStartedAt: s.competitionStartedAt || null,
    competitionTotalMs: s.competitionTotalMs || null,
    tradingHalted: !!s.tradingHalted,
    broadcastLive: !!s.broadcastLive,
    resultsPublished: !!s.resultsPublished,
    startBalance: base,
    participantCount: pool.length,
    rows: rows,
    stats: stats,
    scene: s.yayinScene || 'auto',
    announcement: s.yayinAnnouncement || '',
  };
}

module.exports = async function handler(req, res) {
  // index.html file:// olarak da açılabildiği için CORS açık; yukarıdaki
  // "GÜVENLİK" notunda anlatıldığı gibi burada korunacak bir sır yok.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (Date.now() - lastRunAt < INSTANCE_COOLDOWN_MS) {
    res.status(204).end();
    return;
  }
  lastRunAt = Date.now();

  try {
    getAdminApp();
  } catch (e) {
    console.error('[refresh-leaderboard] Firebase Admin başlatılamadı:', e.message);
    res.status(500).json({ error: 'server_misconfigured', message: e.message });
    return;
  }

  const db = admin.firestore();
  const lbRef = db.collection('finteclub').doc('public_leaderboard');

  try {
    // 1. fren: belge yeterince tazeyse hiçbir şey okumadan çık.
    const lbSnap = await lbRef.get();
    const lb = lbSnap.exists ? (lbSnap.data() || {}) : {};
    const yas = lb.updatedAt ? Date.now() - Date.parse(lb.updatedAt) : Infinity;
    if (isFinite(yas) && yas >= 0 && yas < MIN_WRITE_GAP_MS) {
      res.status(204).end();
      return;
    }

    const sharedSnap = await db.collection('finteclub').doc('shared_state').get();
    const s = sharedSnap.exists ? (sharedSnap.data() || {}) : {};

    // Yarışma bitmişse dokunma: kural 17.1 gereği bitiş sonrası sıralama
    // canlı değerlerden değil, adminin doğruladığı final kaydından
    // (competitionHistory) yayımlanır. Burada yazmak o kaydı ezebilirdi.
    if (!s.competitionActive) {
      res.status(204).end();
      return;
    }

    const portSnap = await db.collection('finteclub').doc('oplab_live_portfolio').get();
    const competitors = portSnap.exists ? ((portSnap.data() || {}).competitors || {}) : {};

    const payload = buildRows(s, competitors);
    payload.updatedAt = new Date().toISOString();
    // Belgeyi kimin yazdığı: admin paneli bu alanı yazmıyor, dolayısıyla
    // "api" damgası yalnızca panel kapalıyken yazılan sürümlerde kalır.
    payload.writtenBy = 'api';

    // {merge:true}: panelin yazdığı ama burada üretilemeyen alanlar
    // (weeklyWinners, session, ceremonyAt, objectionDeadline, finalized…)
    // silinmesin. rows/stats dizi ve nesne olarak bütün hâlinde değişir.
    await lbRef.set(payload, { merge: true });

    res.status(200).json({
      ok: true,
      rows: payload.rows.length,
      weekLabel: payload.weekLabel,
      updatedAt: payload.updatedAt,
    });
  } catch (e) {
    console.error('[refresh-leaderboard] Sıralama tazelenemedi:', e);
    res.status(500).json({ error: 'refresh_failed', message: (e && e.message) || 'bilinmeyen hata' });
  }
};

// Testler bu fonksiyonu doğrudan çağırabilsin diye dışa açılıyor.
module.exports.buildRows = buildRows;
module.exports.MIN_WRITE_GAP_MS = MIN_WRITE_GAP_MS;
