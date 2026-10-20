# FinteLig / ADM-N Proje Kuralları

## 1. Mimari & Stack

- **Yapı:** Framework yok — tek parça HTML/CSS/JS (`index.html`, `admin.html`) + Vercel Node.js serverless (`api/`) + Firebase Firestore.
- **Derleme yok.** Dosyaları düzenle, push et, Vercel deploy eder.
- **Python kurulu değil.** Dosya işlemleri için Node CJS script kullan.

## 2. Token & Kota Tasarrufu (Zorunlu)

- **Asla tüm dosyayı yazma.** `grep -n` ile satırı bul, `sed -n 'X,Yp'` ile yalnızca o aralığı oku, sonra yerinde düzenle.
- Uzun açıklama yapma, temel mantığı anlatma. Çalışan kod + ne değişti özeti.
- Projenin tamamını tarama; önce grep, sonra gereken satır aralığı.

## 3. Doğrulama Zorunluluğu

Bir şeyi değiştirmeden önce **canlı Firestore'a bakarak doğrula, tahmin yürütme.**

Salt okunur REST (herkese açık):
```
https://firestore.googleapis.com/v1/projects/finte-bf5f7/databases/(default)/documents/finteclub/shared_state?key=AIzaSyA9OmfHaqZizxVB1ATnBDedU1YV0a7aiWQ
https://firestore.googleapis.com/v1/projects/finte-bf5f7/databases/(default)/documents/finteclub/public_leaderboard?key=AIzaSyA9OmfHaqZizxVB1ATnBDedU1YV0a7aiWQ
```
`oplab_live_portfolio` ve `oplab_portfolios/*` **admine özel → 403.** Bunlara public anahtarla erişme.

Değişiklikten sonra değiştirilen fonksiyonları Node altında gerçek Firestore anlık görüntüsüne karşı test et.

## 4. Teslim Yöntemi

Ayrı dala commit + push, sonra PR aç. **main'e dokunma, merge etme** — karar Berkay'da.

```bash
git push -u origin <dal>
```

PR'ı `mcp__github__*` araçlarıyla açmak gerekiyor (`gh` CLI kurulu değil). PR **Jimenfolk** hesabı adına açılır; bunu Berkay'a söyle.

Aynı dala ikinci commit gidince PR başlığını/gövdesini de güncelle.

## 5. HANGİ DOSYA NEYİ YAPIYOR

| Dosya | Ne yapar |
|---|---|
| `index.html` (~401 KB, 3 787 satır) | Herkese açık site: sıralama pisti, başvuru formu, kurallar, geçmiş |
| `admin.html` (~732 KB, 10 839 satır) | Admin paneli: yarışma yönetimi, `public_leaderboard` yazımı (`schedulePublicLeaderboard`) |
| `api/refresh-leaderboard.js` (~13 KB) | Vercel uç: panel kapalıyken sıralamayı tazeler, Firebase Admin SDK kullanır |
| `api/delete-user.js` (~10 KB) | Kullanıcı silme (Firebase Admin SDK) |
| `api/send-email.js` | E-posta gönderme |
| `PAYLASILAN_SEMA.md` | Firestore şema sözleşmesi — ikinci yazar, alan listesi, kurallar burada |
| `oplabRules.js` | OPLab kural motoru — **admin.html henüz yüklemiyor** |

## 6. DOSYA BOYUTLARI — bütünü okuma

```
admin.html          732 KB   10 839 satır   9 satır içi <script> bloğu
index.html          401 KB    3 787 satır
api/refresh-leaderboard.js  13 KB  318 satır
api/delete-user.js  11 KB   221 satır
PAYLASILAN_SEMA.md  18 KB   306 satır
```

Yöntem: `grep -n` ile satırı bul → `sed -n 'X,Yp'` ile aralığı oku → Node CJS ile yerinde yaz.

## 7. CRLF Satır Sonları

`index.html` ve `admin.html` **CRLF** satır sonlu. Çok satırlı dizi eşleştirmelerinde kalıbı CRLF'e normalize et:

```js
const crlf = s.includes('\r\n');
const n = t => t.replace(/\r?\n/g, crlf ? '\r\n' : '\n');
```

Aksi halde eşleşme tutmaz, hata çıkmaz ama değişiklik de uygulanmaz.

## 8. KRİTİK FİRESTORE BELGELERİ

| Belge | Boyut | Notlar |
|---|---|---|
| `finteclub/shared_state` | ~1 MB | Tüm yarışma durumu — sık okunur, dikkatli değiştirilir |
| `finteclub/public_leaderboard` | küçük | **İKİ yazar:** `admin.html` (panel açıkken ≤20 sn) + `api/refresh-leaderboard.js` (panel kapalıyken talep üzerine). Her ikisi de aynı mantığı üretmeli — biri değişince diğeri de değiştirilmeli. |
| `finteclub/oplab_live_portfolio` | — | Admine özel (403), sunucu tarafından Firebase Admin SDK ile okunur |

`public_leaderboard` yazımı **`{merge:true}`** — panelin yazdığı `weeklyWinners`, `session`, `ceremonyAt` gibi alanlar korunur.

**Kural 17.1:** `competitionActive === false` iken `public_leaderboard`'a **dokunma** — final kaydı `competitionHistory`'den yayımlanır.

## 9. TEST YÖNTEMİ

Test altyapısı yok. Yöntem: satır içi `<script>` bloğunu ayıkla, Node CJS ile sahte DOM/Firestore stub'ı kur, canlı verinin anlık görüntüsüne karşı çalıştır.

```bash
node scratchpad/test-handler.cjs  # api/ handler testi
node scratchpad/test-tetik.cjs    # index.html tetikleyici testi
```

Firestore anlık görüntüleri kişisel veri (isim/e-posta) taşıyor — **scratchpad'de tut, asla commit etme.**

Söz dizimi denetimi:
```bash
node --check index.html    # çalışmaz, satır içi JS için değil
# Bunun yerine ilgili <script> bloğunu geçici dosyaya kesip:
node --check /tmp/blok.js
```

## 10. DEPLOY

| Değişen | Nasıl yayına girer |
|---|---|
| `index.html`, `admin.html`, `api/*.js` | Push → Vercel otomatik (main'e merge sonrası ~20 sn) |
| Firestore kuralları | Firebase Console'dan elle |
| Vercel env değişkenleri | Vercel Dashboard'dan — `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (zaten kurulu) |

## 11. TEŞHİS YAPARKEN

- `public_leaderboard.updatedAt` değerini kontrol et — bayat mı değil mi buradan anlaşılır.
- `writtenBy: 'api'` damgası varsa son yazan sunucu ucu; yoksa ya panel yazdı ya da eski veri.
- `shared_state.competitionActive`, `tradingHalted`, `resultsPublished` üçlüsünü önce oku.
- Bir UI düzeltmesinde "düzelttim" demeden önce o kodun **gerçekten ekrana çizen yol** olduğunu doğrula — `index.html` ve `admin.html`'de paralel fonksiyonlar var.

## 12. AÇIK KALICI SORUNLAR (henüz çözülmedi)

- **`firestore.rules`:** Kimliksiz `update`'e izin veriyor — yarışmacı `shared_state`'teki kendi yaptırımını silebilir.
- **`oplabRules.js`:** `admin.html` tarafından hiç yüklenmiyor; `rf` bayrağı görmezden geliniyor.
- **`tradingEngine.min.js`:** `applyTrueUp` minified versiyonda yok; `?v=` hâlâ `20261013a`.
- **`ligFlow.weekStarts/weekEnds`:** 2. ve 3. hafta tarihleri `null`.
- **Kural 23:** Geriye dönük 5× kaldıraç değişikliği duyurulmadı.
- **`ftlAcKuralHash()`:** Yüklenmedi (kural popup bağlantısı kırık, görsel hata).
- **20 bekleyen başvuru** — haftalara dağıtılmayı bekliyor.
