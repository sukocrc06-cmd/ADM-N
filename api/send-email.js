// api/send-email.js
//
// Vercel Sunucu Fonksiyonu — e-postaları Resend üzerinden gönderir.
// (Kurulum geçmişi: 22 Eylül 2026'da EmailJS'ten Resend'e geçildi; 23 Eylül'de
// finteclub.com.tr alan adı Resend'de doğrulandı. Gerekli Vercel ortam
// değişkenleri: RESEND_API_KEY, RESEND_FROM_EMAIL, (isteğe bağlı)
// RESEND_FROM_NAME, ve delete-user.js ile ORTAK olan FIREBASE_PROJECT_ID,
// FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, ADMIN_ALLOWED_EMAILS.)
//
// (24 Eylül 2026 — GÜVENLİK KİLİDİ) Bu uç nokta önceden HERKESE AÇIKTI:
// internetteki herhangi biri, bu adrese istediği alıcı/konu/HTML ile istek
// atarak finteclub.com.tr adına (bizim doğrulanmış alan adımızdan!) sahte
// e-posta gönderebilir, günlük 100'lük Resend kotasını dakikalar içinde
// bitirip gerçek başvuru/onay maillerinin gitmesini engelleyebilirdi.
// Artık iki ayrı yol var:
//
//   1) ADMIN YOLU — istek "Authorization: Bearer <Firebase ID token>" taşır,
//      token Firebase Admin SDK ile doğrulanır ve e-posta ADMIN_ALLOWED_EMAILS
//      listesinde olmalıdır (delete-user.js ile AYNI kontrol). Admin serbest
//      metinli e-posta gönderebilir (onay/red bildirimleri).
//
//   2) ZİYARETÇİ YOLU — başvuru/zirve formu gibi, giriş yapmamış (ya da
//      yarışmacı) kişilerin tetiklediği e-postalar. Burada istemci ALICI,
//      KONU veya İÇERİK BELİRLEYEMEZ; sadece bir şablon adı + kayıt kimliği
//      gönderir. Sunucu kaydı Firestore'daki paylaşılan belgeden
//      (finteclub/shared_state) KENDİSİ okur, alıcıyı oradan alır ve içeriği
//      kendi şablonundan üretir (kullanıcı metinleri HTML-kaçışlı). Ayrıca:
//        - Her kayıt için her şablon EN FAZLA BİR KEZ gönderilir (tekrar
//          istekler "zaten gönderildi" olarak başarılı sayılır, mail gitmez);
//          doğrulama bağlantısını yeniden gönderme günde en fazla 3 kez.
//        - Ziyaretçi kaynaklı e-postalar için günlük üst sınır (varsayılan
//          80 — Resend'in 100'lük günlük kotasından adminin onay/red
//          mailleri için pay bırakır) ve IP başına saatlik sınır.
//        - İstek sadece bizim sitelerimizden (Origin kontrolü) kabul edilir.
//
// Sayaç/kilit belgeleri Firestore'da email_send_log ve email_quota
// koleksiyonlarında tutulur; bunlara sadece bu sunucu fonksiyonu (Admin SDK,
// güvenlik kurallarını atlar) erişir — tarayıcıdan okunamaz/yazılamaz.

const crypto = require('crypto');
const admin = require('firebase-admin');

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_SITE_URL = 'https://finteclub.com.tr/fintelig/';
const ALLOWED_ORIGINS = [
  'https://finteclub.com.tr',
  'https://www.finteclub.com.tr',
  'https://fintelig-finteclub.vercel.app',
];
// Vercel'in bu projeye (adm-n) verdiği otomatik adresler (önizleme dahil).
const ALLOWED_ORIGIN_PATTERN = /^https:\/\/adm-n[a-z0-9-]*\.vercel\.app$/i;

const RECORD_WAIT_ATTEMPTS = 4; // kayıt Firestore'a henüz yazılmadıysa
const RECORD_WAIT_MS = 1500; //   kısa aralıklarla tekrar bak (toplam ~4.5 sn)
const VERIFY_RESEND_DAILY_MAX = 3;

function envInt(name, def) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(s);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  const o = String(origin).replace(/\/+$/, '').toLowerCase();
  const extra = (process.env.EMAIL_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  return ALLOWED_ORIGINS.includes(o) || extra.includes(o) || ALLOWED_ORIGIN_PATTERN.test(o);
}

function requestOrigin(req) {
  const h = req.headers || {};
  if (h.origin) return h.origin;
  // Origin başlığı yoksa (bazı eski tarayıcılar) Referer'dan türet.
  if (h.referer) {
    try { return new URL(h.referer).origin; } catch (e) { /* yok say */ }
  }
  return '';
}

function clientIp(req) {
  const h = req.headers || {};
  const raw = h['x-vercel-forwarded-for'] || h['x-forwarded-for'] || h['x-real-ip'] || '';
  return String(raw).split(',')[0].trim() || 'unknown';
}

// Doğrulama bağlantısı SADECE bizim sitemizin adresine işaret edebilir —
// istemcinin gönderdiği adres izinli değilse varsayılan adres kullanılır
// (böylece kimse e-postaya kendi sitesine giden bir bağlantı koyduramaz).
function safeVerifyBase(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:' || !isAllowedOrigin(u.origin)) return DEFAULT_SITE_URL;
    if (!/^\/(fintelig\/?)?(index\.html)?$/i.test(u.pathname)) return DEFAULT_SITE_URL;
    return u.origin + u.pathname;
  } catch (e) {
    return DEFAULT_SITE_URL;
  }
}

function adminNotifyEmail() {
  const v = (process.env.ADMIN_NOTIFY_EMAIL || '').trim();
  if (isValidEmail(v)) return v;
  const first = (process.env.ADMIN_ALLOWED_EMAILS || '').split(',').map((s) => s.trim()).filter(isValidEmail)[0];
  return first || 'suko.crc06@gmail.com';
}

function linkHtml(url, label) {
  const u = escapeHtml(url);
  return `<a href="${u}" target="_blank" rel="noopener" style="color:#facc15;text-decoration:underline;font-weight:600;">${escapeHtml(label)}</a><br>(Bağlantı çalışmazsa şu adresi tarayıcına kopyala: ${u})`;
}

function dayKey(d) { return d.toISOString().slice(0, 10); }
function hourKey(d) { return d.toISOString().slice(0, 13).replace('T', '_'); }
function safeDocId(s) { return String(s).replace(/[^a-zA-Z0-9_.@-]/g, '_').slice(0, 400); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ziyaretçi şablonları: her biri paylaşılan belgeden kaydı bulur ve
// { to, toName, subject, html, claimId, daily? } döndürür (ya da hata kodu).
const PUBLIC_TEMPLATES = {
  application_received: {
    find: (shared, b) => findApplication(shared, b),
    build: (app, b) => ({
      to: app.email,
      toName: app.name,
      subject: 'FinteLig Başvurun Alındı',
      html: `Merhaba ${escapeHtml(app.name)}, FinteLig yarışması başvurun alındı. E-postanı doğrulamak için lütfen şu bağlantıya tıkla: ${linkHtml(verifyUrl(app, b), 'E-postamı Doğrula')}<br><br>Admin, başvurunu inceledikten sonra onaylayacak; onaydan sonra belirlediğin e-posta ve şifreyle OPLab (alım-satım platformu) üzerinde FinteLig Yarışmacısı olarak giriş yapabileceksin.`,
      claimId: `application_received_${app.id}_${app.emailVerifyToken}`,
    }),
  },
  application_admin_notice: {
    find: (shared, b) => findApplication(shared, b),
    build: (app) => ({
      to: adminNotifyEmail(),
      toName: 'Admin',
      subject: 'Yeni FinteLig Başvurusu',
      html: `${escapeHtml(app.name)} (${escapeHtml(app.email)}) FinteLig yarışmasına başvurdu. Admin panelinden inceleyebilirsin.`,
      claimId: `application_admin_notice_${app.id}_${app.emailVerifyToken}`,
    }),
  },
  verify_resend: {
    find: (shared, b) => findApplication(shared, b),
    check: (app) => (app.emailVerified ? 'already_verified' : null),
    build: (app, b) => ({
      to: app.email,
      toName: app.name,
      subject: 'FinteLig — E-posta Doğrulama Bağlantın',
      html: `Merhaba ${escapeHtml(app.name)}, e-postanı doğrulamak için lütfen şu bağlantıya tıkla: ${linkHtml(verifyUrl(app, b), 'E-postamı Doğrula')}`,
      claimId: `verify_resend_${app.id}_${dayKey(new Date())}`,
      daily: VERIFY_RESEND_DAILY_MAX,
    }),
  },
  zirve_received: {
    find: (shared, b) => findZirve(shared, b),
    build: (z) => ({
      to: z.contactEmail,
      toName: z.contact,
      subject: 'FinTeClub Zirve Kaydın Alındı',
      html: `Merhaba ${escapeHtml(z.contact)}, ${escapeHtml(z.club)} için FinTeClub Zirve kaydın alındı. Admin onayından sonra durumu görebileceksin.`,
      claimId: `zirve_received_${z.id}`,
    }),
  },
  zirve_admin_notice: {
    find: (shared, b) => findZirve(shared, b),
    build: (z) => ({
      to: adminNotifyEmail(),
      toName: 'Admin',
      subject: 'Yeni Zirve Kaydı',
      html: `${escapeHtml(z.club)} kulübü (temsilci: ${escapeHtml(z.contact)}, ${escapeHtml(z.contactEmail)}) FinTeClub Zirve'ye kayıt oldu. Admin panelinden inceleyebilirsin.`,
      claimId: `zirve_admin_notice_${z.id}`,
    }),
  },
};

function verifyUrl(app, b) {
  return safeVerifyBase(b.verify_base) + '?verifyemail=' + encodeURIComponent(String(app.id)) + '.' + encodeURIComponent(String(app.emailVerifyToken));
}

function findApplication(shared, b) {
  const id = String(b.app_id == null ? '' : b.app_id);
  const token = String(b.verify_token || '');
  if (!id || !token) return null;
  return (shared.applications || []).find(
    (a) => a && String(a.id) === id && a.emailVerifyToken && String(a.emailVerifyToken) === token && isValidEmail(a.email)
  ) || null;
}

function findZirve(shared, b) {
  const id = String(b.zirve_id == null ? '' : b.zirve_id);
  const email = String(b.contact_email || '').trim().toLowerCase();
  if (!id || !email) return null;
  return (shared.zirveRegistrations || []).find(
    (z) => z && String(z.id) === id && isValidEmail(z.contactEmail) && z.contactEmail.trim().toLowerCase() === email
  ) || null;
}

async function sendViaResend(msg) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const fromName = process.env.RESEND_FROM_NAME || 'FinteLig';
  const safeName = String(msg.toName || '').replace(/[<>"\r\n,;]/g, ' ').trim().slice(0, 80);
  const r = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [safeName ? `${safeName} <${msg.to}>` : msg.to],
      subject: msg.subject,
      html: msg.html,
    }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function handleAdmin(req, res, idToken) {
  let callerEmail;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    callerEmail = (decoded.email || '').toLowerCase();
  } catch (e) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  const allowedAdmins = (process.env.ADMIN_ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowedAdmins.length || !allowedAdmins.includes(callerEmail)) {
    res.status(403).json({ error: 'not_admin' });
    return;
  }
  const body = req.body || {};
  const to = String(body.to_email || '').trim();
  const subject = String(body.subject_line || '').trim().slice(0, 200);
  const html = String(body.message_body || '').trim();
  if (!isValidEmail(to) || !subject || !html) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  const db = admin.firestore();
  const now = new Date();
  db.collection('email_quota').doc(dayKey(now))
    .set({ admin: admin.firestore.FieldValue.increment(1), updatedAt: now.toISOString() }, { merge: true })
    .catch(() => {});
  const out = await sendViaResend({ to, toName: body.to_name, subject, html });
  if (!out.ok) {
    console.error('[send-email] Resend hatası (admin):', out.status, out.data);
    res.status(502).json({ error: 'resend_failed', status: out.status, detail: out.data });
    return;
  }
  res.status(200).json({ ok: true, id: out.data && out.data.id });
}

async function handlePublic(req, res) {
  const origin = requestOrigin(req);
  if (!isAllowedOrigin(origin)) {
    res.status(403).json({ error: 'origin_not_allowed' });
    return;
  }
  const body = req.body || {};
  const tpl = PUBLIC_TEMPLATES[String(body.template || '')];
  if (!tpl) {
    res.status(400).json({ error: 'unknown_template' });
    return;
  }

  const db = admin.firestore();
  const sharedRef = db.collection('finteclub').doc('shared_state');

  // Kayıt, istemcideki saveShared() transaction'ı bitmeden gelmiş olabilir —
  // kısa aralıklarla birkaç kez daha bak.
  let record = null;
  for (let i = 0; i < RECORD_WAIT_ATTEMPTS; i++) {
    const snap = await sharedRef.get();
    record = tpl.find(snap.exists ? (snap.data() || {}) : {}, body);
    if (record) break;
    if (i < RECORD_WAIT_ATTEMPTS - 1) await sleep(RECORD_WAIT_MS);
  }
  if (!record) {
    res.status(404).json({ error: 'record_not_found' });
    return;
  }
  const blocked = tpl.check ? tpl.check(record) : null;
  if (blocked) {
    res.status(409).json({ error: blocked });
    return;
  }
  const msg = tpl.build(record, body);
  if (!isValidEmail(msg.to)) {
    res.status(400).json({ error: 'invalid_recipient' });
    return;
  }

  const now = new Date();
  const dailyCap = envInt('EMAIL_PUBLIC_DAILY_CAP', 80);
  const ipHourlyCap = envInt('EMAIL_IP_HOURLY_CAP', 120);
  const ipHash = crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16);
  const claimRef = db.collection('email_send_log').doc(safeDocId(msg.claimId));
  const quotaRef = db.collection('email_quota').doc(dayKey(now));
  const ipRef = db.collection('email_quota').doc(`ip_${hourKey(now)}_${ipHash}`);

  let verdict;
  try {
    verdict = await db.runTransaction(async (tx) => {
      const [claimSnap, quotaSnap, ipSnap] = await Promise.all([tx.get(claimRef), tx.get(quotaRef), tx.get(ipRef)]);
      const claim = claimSnap.exists ? (claimSnap.data() || {}) : null;
      const limit = msg.daily || 1;
      const used = claim ? (Number(claim.count) || 0) : 0;
      if (used >= limit) return { duplicate: true, limitReached: limit > 1 };
      const publicUsed = quotaSnap.exists ? (Number((quotaSnap.data() || {}).public) || 0) : 0;
      if (publicUsed >= dailyCap) return { quota: 'daily' };
      const ipUsed = ipSnap.exists ? (Number((ipSnap.data() || {}).count) || 0) : 0;
      if (ipUsed >= ipHourlyCap) return { quota: 'ip' };
      tx.set(claimRef, { count: used + 1, template: String(body.template), to: msg.to, lastAt: now.toISOString() }, { merge: true });
      tx.set(quotaRef, { public: publicUsed + 1, updatedAt: now.toISOString() }, { merge: true });
      tx.set(ipRef, { count: ipUsed + 1, day: dayKey(now) }, { merge: true });
      return { ok: true, prevCount: used };
    });
  } catch (e) {
    console.error('[send-email] kota transaction hatası:', e && e.message);
    res.status(500).json({ error: 'quota_check_failed' });
    return;
  }

  if (verdict.duplicate) {
    if (verdict.limitReached) {
      res.status(429).json({ error: 'resend_limit_reached' });
    } else {
      // Aynı e-posta zaten gönderildi (ör. istemcinin otomatik yeniden
      // denemesi) — tekrar göndermiyoruz ama istemci "başarısız" sanmasın.
      res.status(200).json({ ok: true, duplicate: true });
    }
    return;
  }
  if (verdict.quota) {
    console.warn('[send-email] ziyaretçi e-posta sınırı doldu:', verdict.quota);
    res.status(429).json({ error: verdict.quota === 'daily' ? 'daily_limit_reached' : 'ip_limit_reached' });
    return;
  }

  const out = await sendViaResend(msg).catch((e) => ({ ok: false, status: 0, data: { message: e && e.message } }));
  if (!out.ok) {
    // Gönderilemediyse "gönderildi" işaretini geri al ki yeniden deneme
    // (istemcinin 4 sn sonraki tekrarı) gerçekten tekrar gönderebilsin.
    await claimRef.set({ count: verdict.prevCount }, { merge: true }).catch(() => {});
    console.error('[send-email] Resend hatası:', out.status, out.data);
    res.status(502).json({ error: 'resend_failed', status: out.status, detail: out.data });
    return;
  }
  res.status(200).json({ ok: true, id: out.data && out.data.id });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    console.error('[send-email] RESEND_API_KEY tanımlı değil.');
    res.status(500).json({ error: 'server_misconfigured', message: 'RESEND_API_KEY ayarlanmamış.' });
    return;
  }
  try {
    getAdminApp();
  } catch (e) {
    console.error('[send-email] Firebase Admin başlatılamadı:', e.message);
    res.status(500).json({ error: 'server_misconfigured', message: e.message });
    return;
  }

  const authHeader = (req.headers && req.headers.authorization) || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  try {
    if (idToken) await handleAdmin(req, res, idToken);
    else await handlePublic(req, res);
  } catch (e) {
    console.error('[send-email] istisna:', e && e.message);
    res.status(500).json({ error: 'unknown_error', message: (e && e.message) || 'bilinmeyen hata' });
  }
};
