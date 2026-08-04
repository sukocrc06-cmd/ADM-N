// api/delete-user.js
//
// Vercel Sunucu Fonksiyonu (Serverless Function) — TAMAMEN ÜCRETSİZ, kart
// istemez (Vercel'in Hobby planında Serverless Functions dahildir).
//
// NEDEN GEREKLİ: admin.html'deki JavaScript kodu bir TARAYICIDA çalışıyor —
// ve tarayıcıdan çalışan hiçbir kod, BAŞKA birinin Firebase Authentication
// hesabını silemez (bu, Firebase'in bilinçli güvenlik kısıtı). Bunu sadece
// "Firebase Admin SDK" yapabiliyor, o da sadece güvenilir bir SUNUCU
// ortamında (burada: bu Vercel fonksiyonu) çalıştırılabiliyor. Bu dosya
// olmadan, admin panelindeki "SİSTEMDEN SİL" sadece başvuru kaydını ve
// OPLab'daki canlı veri izlerini temizleyebiliyordu — kişinin GERÇEK
// Firebase hesabı (e-posta+şifre) sistemde kalıyor, bu da aynı e-postayla
// tekrar başvurulmak istendiğinde "e-posta zaten kullanılıyor" hatasına yol
// açıyordu.
//
// GÜVENLİK: Bu uç noktayı ÇAĞIRAN kişinin gerçekten admin.html'e Firebase
// Authentication ile giriş yapmış olması ZORUNLU. admin.html, isteğe kendi
// güncel "ID token"ını ekliyor (Authorization: Bearer <token>); bu fonksiyon
// önce o token'ın GERÇEKTEN geçerli bir Firebase oturumuna ait olduğunu
// doğruluyor, SONRA o oturumun e-postasının ADMIN_ALLOWED_EMAILS ortam
// değişkenindeki (Vercel proje ayarlarında tanımlanan) izinli admin
// listesinde olup olmadığına bakıyor. İkisi de doğrulanmadan HİÇBİR hesap
// silinmiyor — yetkisiz biri bu adresi doğrudan çağırsa bile hiçbir şey
// yapamaz.
//
// KURULUM (bir kereye mahsus, ücretsiz):
//   1) Firebase Console → Proje Ayarları → Servis Hesapları → "Yeni özel
//      anahtar oluştur" → bir JSON dosyası iner.
//   2) O JSON içindeki "project_id", "client_email", "private_key"
//      değerlerini, Vercel projenin (adm-n-one) Ayarlar → Environment
//      Variables bölümüne şu isimlerle ekle:
//        FIREBASE_PROJECT_ID
//        FIREBASE_CLIENT_EMAIL
//        FIREBASE_PRIVATE_KEY   (JSON'daki "private_key" değerini OLDUĞU
//                                 GİBİ, \n karakterleriyle birlikte yapıştır)
//        ADMIN_ALLOWED_EMAILS   (admin.html'e giriş yaptığın gerçek
//                                 e-posta(lar), virgülle ayırarak — örn:
//                                 "suko.crc06@gmail.com")
//   3) Bu dosyayı ve yanındaki package.json'ı proje klasörüne ekleyip
//      git commit + push yap — Vercel otomatik deploy eder.
//
// Bu ayarlar yapılmadan bu dosya devreye girmez; admin.html tarafı, backend
// çağrısı başarısız olursa sessizce loglar ve eskisi gibi (sadece yerel
// silme ile) çalışmaya devam eder — "hiçbir şey bozulmaz".

const admin = require('firebase-admin');

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

module.exports = async function handler(req, res) {
  // Admin panelinin file:// (yerel dosya) olarak açılabilmesi de desteklensin
  // diye CORS herkese açık — asıl güvenlik aşağıdaki token+e-posta kontrolünde.
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

  try {
    getAdminApp();
  } catch (e) {
    console.error('[delete-user] Firebase Admin başlatılamadı:', e.message);
    res.status(500).json({ error: 'server_misconfigured', message: e.message });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!idToken) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }

  let callerEmail;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    callerEmail = (decoded.email || '').toLowerCase();
  } catch (e) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const allowedAdmins = (process.env.ADMIN_ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedAdmins.length || !allowedAdmins.includes(callerEmail)) {
    res.status(403).json({ error: 'not_admin' });
    return;
  }

  const body = req.body || {};
  const emails = Array.isArray(body.emails) ? body.emails : [];
  if (!emails.length) {
    res.status(400).json({ error: 'missing_emails' });
    return;
  }

  const results = [];
  for (const rawEmail of emails) {
    const email = String(rawEmail || '').trim();
    if (!email) continue;
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      await admin.auth().deleteUser(userRecord.uid);
      results.push({ email, deleted: true });
    } catch (e) {
      if (e && e.code === 'auth/user-not-found') {
        // Zaten yok (ya hiç Firebase hesabı olmamış ya da önceden silinmiş) —
        // bu bir hata değil, hedeflenen sonuca zaten ulaşılmış demek.
        results.push({ email, deleted: true, note: 'already_gone' });
      } else {
        console.error('[delete-user] Hesap silinemedi:', email, e && e.code, e && e.message);
        results.push({ email, deleted: false, error: (e && e.code) || 'unknown_error' });
      }
    }
  }

  res.status(200).json({ results });
};
