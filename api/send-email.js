// api/send-email.js
//
// Vercel Sunucu Fonksiyonu (Serverless Function) — TAMAMEN ÜCRETSİZ, kart
// istemez (Vercel'in Hobby planında Serverless Functions dahildir), tıpkı
// yanındaki api/delete-user.js gibi.
//
// (22 Eylül 2026 — Madde 3 kök neden düzeltmesi: EmailJS'ten Resend'e geçiş)
// index.html ve admin.html önceden e-postayı DOĞRUDAN TARAYICIDAN, EmailJS
// ile gönderiyordu — bu hem herkese açık bir "public key" tarayıcı kodunda
// açıkta duruyordu, hem de EmailJS'in ücretsiz planının düşük aylık kotası
// (20 kişilik tek bir canlı test bile — 20 başvuran + 20 admin bildirimi =
// 40 e-posta — bu kotayı kolayca tüketebiliyordu) yüzünden gönderimler
// sessizce başarısız oluyordu. Bu dosya, gönderimi SUNUCU tarafına taşıyor:
// API anahtarı hiçbir zaman tarayıcıya inmiyor, ve Resend'in ücretsiz planı
// ayda 3000 e-postaya izin veriyor (EmailJS'in tipik ücretsiz kotasının kat
// kat üstünde).
//
// KURULUM (bir kereye mahsus, ücretsiz, kart istemez):
//   1) resend.com'da ücretsiz bir hesap aç (kart istemiyor).
//   2) Resend panelinden "API Keys" → yeni bir anahtar oluştur.
//   3) ÖNEMLİ — alan adı doğrulaması: Resend'in ücretsiz "onboarding@
//      resend.dev" gönderen adresiyle SADECE kendi Resend hesap e-postana
//      test maili gönderebilirsin — öğrencilere/gerçek alıcılara mail
//      gitmesi için KENDİ SAHİP OLDUĞUN bir alan adını doğrulaman şart:
//        a) Resend panelinde "Domains" → "Add Domain" → alan adını gir
//           (ör. fintelig.com — *.vercel.app burada KULLANILAMAZ).
//        b) Resend birkaç DNS kaydı (TXT/CNAME — SPF+DKIM için) gösterir.
//           Bunları alan adının DNS ayarlarının yönetildiği yere (alan
//           adını satın aldığın yerin DNS paneli, ya da alan adını Vercel
//           DNS'ine taşıdıysan Vercel'in Domains ekranı) ekle. BU ADIM,
//           alan adını Vercel'e SİTE OLARAK bağlamaktan TAMAMEN BAĞIMSIZ —
//           site hâlâ *.vercel.app adresinde yayınlanıyor olsa bile, DNS
//           kayıtları eklendiği sürece Resend alan adını doğrular (genelde
//           birkaç dakika, bazen birkaç saat sürebilir).
//        c) Resend panelinde alan adı "Verified" olunca, o alan adından bir
//           gönderen adresi (ör. bildirim@fintelig.com) kullanmaya
//           hazırsın.
//   4) Vercel projenin (bu projenin, adm-n-one) Ayarlar → Environment
//      Variables bölümüne şunları ekle:
//        RESEND_API_KEY    (2. adımdaki anahtar)
//        RESEND_FROM_EMAIL (3c'deki doğrulanmış adres — alan adı henüz
//                            doğrulanmadıysa GEÇİCİ OLARAK bu değişkeni
//                            HİÇ EKLEME/BOŞ BIRAK, aşağıdaki kod otomatik
//                            olarak "onboarding@resend.dev" sandbox
//                            adresine düşer — ama o modda SADECE Resend
//                            hesabını açtığın e-postaya gönderebilirsin,
//                            öğrencilere gitmez. Alan adı doğrulanana kadar
//                            bunu bir TEST/hazırlık aşaması olarak düşün.)
//        RESEND_FROM_NAME  (isteğe bağlı, gönderen görünen adı — örn.
//                            "FinteLig", verilmezse bu isim kullanılır)
//   5) Bu dosyayı proje klasörüne ekleyip git commit + push yap — Vercel
//      otomatik deploy eder. Ekstra bir npm paketi GEREKMEZ (fetch, Vercel'in
//      Node 18+ çalışma zamanında yerleşik olarak geliyor).
//
// Bu ortam değişkenleri ayarlanmadan bu uç nokta 500 döner; index.html/
// admin.html tarafı bunu sessizce loglar ve kullanıcıya/admine "gönderileme-
// di" olarak doğru şekilde bildirir — "hiçbir şey bozulmaz", sadece e-posta
// kurulana kadar gitmez.

const RESEND_API_URL = 'https://api.resend.com/emails';

module.exports = async function handler(req, res) {
  // index.html/admin.html'in kendi origin'inden çağrılması yeterli — ama
  // delete-user.js'deki gibi admin panelinin file:// olarak da açılabilmesi
  // ihtimaline karşı CORS herkese açık bırakıldı. Bu uç nokta yıkıcı bir
  // işlem yapmıyor (sadece e-posta gönderiyor), bu yüzden delete-user.js'deki
  // gibi bir Firebase token doğrulaması gerektirmiyor — mevcut EmailJS
  // kurulumuyla AYNI güven seviyesinde (o da herkese açık bir anahtarla
  // tarayıcıdan çağrılıyordu); asıl spam/kötüye kullanım koruması zaten
  // başvuru formundaki reCAPTCHA'da.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[send-email] RESEND_API_KEY tanımlı değil — bkz. bu dosyanın başındaki kurulum notları.');
    res.status(500).json({ error: 'server_misconfigured', message: 'RESEND_API_KEY ayarlanmamış.' });
    return;
  }
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const fromName = process.env.RESEND_FROM_NAME || 'FinteLig';

  const body = req.body || {};
  const to = String(body.to_email || '').trim();
  const toName = String(body.to_name || '').trim();
  const subject = String(body.subject_line || '').trim();
  const html = String(body.message_body || '').trim();
  if (!to || !subject || !html) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }

  try {
    const r = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [toName ? `${toName} <${to}>` : to],
        subject,
        html,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // En sık görülen neden: fromEmail hâlâ "onboarding@resend.dev"
      // sandbox adresiyken, "to" adresi Resend hesabının kendi e-postası
      // DEĞİLSE Resend bunu 403 ile reddeder — bkz. yukarıdaki kurulum
      // notları, alan adı doğrulaması gerekiyor demektir.
      console.error('[send-email] Resend hatası:', r.status, data);
      res.status(502).json({ error: 'resend_failed', status: r.status, detail: data });
      return;
    }
    res.status(200).json({ ok: true, id: data && data.id });
  } catch (e) {
    console.error('[send-email] istisna:', e && e.message);
    res.status(500).json({ error: 'unknown_error', message: (e && e.message) || 'bilinmeyen hata' });
  }
};
