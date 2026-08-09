# OptiPulseLab ↔ FinTeClub — Paylaşılan Firestore Şeması

Bu doküman, iki ayrı kod tabanının (OptiPulseLab demo alım-satım terminali ve
FinTeClub başvuru/admin sitesi) **aynı Firebase projesini** (`finte-bf5f7`,
`finteclub` koleksiyonu) nasıl paylaştığını açıklar. Amaç: iki taraftan biri
değiştirilirken diğerinin sessizce bozulmasını önlemek — buradaki her alan,
gerçekte HANGİ dosyanın YAZDIĞI ve HANGİ dosyanın OKUDUĞU baz alınarak
belgelenmiştir (varsayımla değil, kod okunarak).

Son güncelleme: 9 Ağustos 2026 (kapsamlı güvenlik/entegrasyon turu sırasında).

## Genel model

Tüm paylaşılan veri, `finteclub` koleksiyonu altında **5 sabit belge adı**
içinde tutulur (alt koleksiyon YOK — hepsi tek bir belge içinde, iç içe
map'ler olarak):

| Belge | Yazan | Okuyan | Amaç |
|---|---|---|---|
| `finteclub/shared_state` | admin.html, index.html (FinTeClub) | admin.html, index.html | Başvurular, zirve kayıtları, yarışma ayarları |
| `finteclub/oplab_activity` | OptiPulseLab (finteclubBridge.js) | admin.html | Doğrulanmış ziyaretçi/aktivasyon özeti |
| `finteclub/oplab_live_portfolio` | OptiPulseLab (finteclubBridge.js) | admin.html | Canlı liderlik tablosu / işlem akışı özeti |
| `finteclub/oplab_user_portfolios` | OptiPulseLab (finteclubBridge.js) | OptiPulseLab (finteclubBridge.js) | Çoklu cihaz senkronu (telefon/PC arası GERÇEK portföy) |
| `finteclub/oplab_balance_commands` | admin.html | OptiPulseLab (finteclubBridge.js) | Admin'den öğrenciye tek yönlü bakiye ayarla/sıfırla komutu |

Güvenlik kuralları `optipulselab/firestore.rules` dosyasında tanımlı — bu
dokümandaki her belgenin GERÇEK yazma yetkisi orada kontrol edilir, burada
sadece VERİ ŞEKLİ anlatılıyor.

## Kimlik (id) şeması — ÖNEMLİ

- **applicationId**: FinTeClub tarafında `state.applications` dizisindeki her
  başvurunun `id` alanı (sayısal, `appIdCounter`den artan). Bu, OPLab
  tarafındaki `verifiedApp.id` ile AYNI değerdir — FinTeClub başvurusu
  onaylanınca kişi bu id ile "yarışmacı" olur.
- OPLab tarafı Firestore'a yazarken bu id'yi HER ZAMAN `String(verifiedApp.id)`
  ile map anahtarı olarak kullanır (`oplab_activity.visitors`,
  `oplab_live_portfolio.competitors`, `oplab_user_portfolios.users`,
  `oplab_balance_commands.commands` — dördü de aynı desende).
- **BİLİNEN KISIT**: Bu anahtar Firebase Authentication UID'si DEĞİL,
  application ID'sidir — bu yüzden Firestore güvenlik kuralları "bu kayıt
  gerçekten BU oturumun kendi kaydı mı" diye per-key doğrulayamıyor (bkz.
  `firestore.rules` içindeki `oplab_user_portfolios` notu). E-posta
  (`request.auth.token.email`) ile eşleştirme yapılmıyor.

## `finteclub/shared_state`

```
{
  applicationsOpen: boolean,
  zirveOpen: boolean,
  oplabEnabled: boolean,
  resultsPublished: boolean,          // sadece admin.html
  activityLog: [{ text: string, at: ISOString }],   // en fazla 50 kayıt
  competitionActive: boolean,
  broadcastLive: boolean,
  viewMode: string,                   // sadece admin.html ('LİDERLİK'|'SIRALAMA'|'İLK 3'|...)
  balance: number,                    // sadece admin.html
  compName: string,
  startDate: string, endDate: string,
  applications: [{
    id: number, name, email, org, level, motivation,
    status: 'bekliyor' | 'onayli' | 'reddedildi',
    date, approvedDate,
    disqualified: boolean,            // (9 Ağustos 2026 eklendi, madde #121)
  }],
  zirveRegistrations: [{
    id: number, club, org, contact, contactEmail, area,
    status: 'incelemede' | 'onayli' | 'reddedildi',
    date, approvedDate,
    students: [{ name, phone, email }]   // en fazla 5
  }],
  deletedApplicationIds: { [applicationId]: true },   // mezar taşı — bkz. aşağıda
  deletedZirveIds: { [zirveId]: true },               // (9 Ağustos 2026 eklendi, madde #124)
  appIdCounter: number, zirveIdCounter: number,
  competitionEndsAt: number|null, competitionTotalMs: number|null,
  competitionHistory: [...]           // sadece admin.html
}
```

**Yazma deseni**: `admin.html` VE `index.html` (FinTeClub'ın kendi
`saveShared()` fonksiyonları — iki dosyada AYRI ayrı, ama aynı mantıkla
kopyalanmış) bu belgeyi `runTransaction` + `applications`/`zirveRegistrations`
dizilerini id bazlı UZLAŞTIRARAK (bkz. `reconcileArrayFieldById`) yazar —
düz `{merge:true}` YETERLİ DEĞİL çünkü Firestore bir DİZİ alanını bütün
olarak değiştirir, elemanlarını birleştirmez.

**Mezar taşı (tombstone) deseni**: Bir kayıt "gerçekten silindi" olarak
işaretlenmek istendiğinde, sadece diziden çıkarmak YETERSİZ — arada başka
bir sekme/cihaz kendi eski kopyasıyla yazarsa silineni farkında olmadan geri
ekleyebilir. Bu yüzden silinen id, `deletedApplicationIds`/`deletedZirveIds`
map'ine kalıcı olarak eklenir; `reconcileArrayFieldById` bu id'leri, NEREDEN
geldiğine bakmadan sonuçtan HER ZAMAN çıkarır.

## `finteclub/oplab_activity`

```
{ visitors: { [applicationId]: { name, email, lastVisit: ISOString, visitCount: number } } }
```
OPLab tarafı `.set(payload, {merge:true})` ile SADECE kendi id'sinin altını
yazar (`FieldValue.increment(1)` ile visitCount artırılır). admin.html
`onSnapshot` ile dinler, "Doğrulanmış Ziyaretçiler" listesini besler.

## `finteclub/oplab_live_portfolio`

```
{ competitors: { [applicationId]: {
    name, email, balance, equity, openPnl, positionsCount,
    positions: [{ symbol, market, side, qty, avgPrice, pnl }],
    pendingOrders: [{ symbol, market, upper, lower, qty }],
    recentTrades: [{ symbol, market, side, type, qty, price, pnl }],
    updatedAt: ISOString
} } }
```
OPLab tarafı her ~5 saniyede bir kendi id'sinin altını yazar (sekme arka
planda olsa bile). admin.html'in Canlı İzleme / Kullanıcı Portföyleri /
Yarışma Sonuçları / Yayın (sahne modu) ekranlarının HEPSİ bu TEK belgeden
beslenir (`oplabPortfolioData` — bkz. admin.html).

**Diskalifikasyon notu (madde #121)**: `disqualified` bayrağı BURADA değil,
`shared_state.applications[i].disqualified`'da tutulur — admin.html render
fonksiyonları ikisini çapraz referans verir (`isRankExcluded(appId)`).

## `finteclub/oplab_user_portfolios`

```
{ users: { [applicationId]: {
    name, email,
    portfolio: { balance: number, positions: {...}, ... },  // tradingEngine.js'in TAM portföy nesnesi
    rev: number,          // monoton artan revizyon sayacı — çoklu cihaz çakışma çözümü
    deviceId: string,
    updatedAt: ISOString
} } }
```
**SADECE OptiPulseLab tarafı** (finteclubBridge.js) okur/yazar — admin.html
bu belgeye HİÇ dokunmuyor (Firestore referansı bile yok). Yazma,
`db.runTransaction()` + `mergeFields: ['users.'+userId]` ile yapılır (9
Ağustos 2026'da eklenen çoklu-cihaz çift-satış kök neden düzeltmesi —
`{merge:true}` KULLANILMAZ, çünkü o iç içe map'lerde eski anahtarları asla
silmez → "hayalet pozisyon" hatası verir).

**OCC (optimistic concurrency control)**: Her yazma önce `rev`i okur; eğer
bulut `rev`i, o cihazın bildiği `rev`den BÜYÜKSE ve yazan BAŞKA bir cihazsa,
yazma REDDEDİLİR ve o cihaz bulutun gerçek durumunu benimser. Bu, aynı
kullanıcının telefon+PC'den aynı anda satış yapıp iki kez ödeme alması
hatasını kökten çözer (bkz. proje dokümanındaki 9 Ağustos oturumu).

## `finteclub/oplab_balance_commands`

```
{ commands: { [applicationId]: {
    newBalance?: number,      // setCompetitorBalance()
    reset?: true,             // resetCompetitorPortfolio()
    requestedAt: ISOString,
    requestedByAdmin: true,
    appliedAt?: ISOString,    // öğrenci tarafı UYGULADIKTAN sonra EKLER
    appliedDeviceId?: string
} } }
```
TEK YÖNLÜ kanal: SADECE admin.html yazar (yeni komut), SADECE OptiPulseLab
tarafı dinler + UYGULAR + `appliedAt/appliedDeviceId` ile "ack" eder (aynı
belge içindeki alt-alan güncellemesi, ayrı bir yazma değil).

## Güvenlik kuralları özeti (9 Ağustos 2026 turu)

Ayrıntılar için `optipulselab/firestore.rules`:

- Admin e-postası (`isFinteClubAdmin()`) kriptografik olarak imzalı
  `request.auth.token.email` claim'ine göre tanınır — sahtelenemez.
- `shared_state`/`oplab_activity`/`oplab_live_portfolio`: TAMAMEN silme
  artık sadece admin'e ait (önceden herhangi bir doğrulanmış kullanıcı
  silebiliyordu — kritik açıktı, kapatıldı).
- `oplab_balance_commands`: yazma artık sadece admin'e ait (önceden
  herhangi bir öğrenci kendine sınırsız bakiye komutu yazabiliyordu).
- `oplab_user_portfolios`: tam "sadece kendi kaydın" kilidi UYGULANAMIYOR
  (anahtar şeması applicationId, Firebase kimliği değil) — kısmi düzeltme
  olarak tek yazmada sadece TEK kaydın değişmesi zorunlu kılındı. Tam çözüm
  (alt koleksiyona geçiş veya anahtar şemasını e-postaya çevirme) kasıtlı
  olarak bu turun kapsamı dışında bırakıldı — bkz. `firestore.rules`
  içindeki ayrıntılı not.
- `oplab_activity`/`oplab_live_portfolio` boyut kuralı düzeltildi: önceden
  `request.resource.data.size() < 20` HİÇBİR ŞEYİ sınırlamıyordu (belge her
  zaman tek bir üst seviye alan içeriyor) — artık iç map'in (`visitors`/
  `competitors`) gerçek eleman sayısı sınırlanıyor.

## Silme akışı (uçtan uca)

1. admin.html'de "SİSTEMDEN SİL" → `deleteApplications()`: diziden çıkarır,
   `deletedApplicationIds`e ekler, 10sn "GERİ AL" penceresi açar.
2. Pencere dolunca `finalizeApplicationDeletion()`: (a) admin'in KENDİ
   tarayıcısından `oplab_activity`/`oplab_live_portfolio`yu temizler
   (`cleanupOplabDataForIds`), (b) Vercel'deki `api/delete-user.js`
   fonksiyonunu çağırır — bu fonksiyon Admin SDK ile hem GERÇEK Firebase
   Authentication hesabını SİLER hem de (9 Ağustos 2026'da eklendi, madde
   #123) `oplab_user_portfolios`/`oplab_balance_commands`taki kayıtları da
   temizler (admin.html'in bu ikisine hiç Firestore erişimi yok, ayrıca bu
   sunucu-taraflı temizlik admin'in sekmesi kapansa bile güvenilir çalışır).

## Bilinen sınırlamalar (bu turda kasıtlı olarak kapsam dışı)

1. `shared_state.applications`/`zirveRegistrations` içindeki TEK BİR
   elemanın (ör. `status`) sahtelenmesini Firestore kuralları
   engelleyemiyor — dizi alanları kural motorunda "hepsi ya da hiçbiri"
   değerlendirilir. Kalıcı çözüm: alt koleksiyona geçiş.
2. `oplab_user_portfolios` için per-kayıt e-posta doğrulaması yok (yukarıda
   açıklandı).
3. OptiPulseLab tarafında (ayrı bir depo/proje) `.rules` dosyasının
   GERÇEKTEN Firebase Console'a yayınlanmış (deploy edilmiş) olması gerekir
   — disk üzerindeki dosyayı güncellemek tek başına yeterli değildir.
