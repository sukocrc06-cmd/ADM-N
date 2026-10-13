/* OPLab yarışma kuralları — ortak, yan etkisiz hesap modülü (13 Ekim 2026)
 *
 * Hem OPLab (tradingEngine.js) hem admin paneli (admin.html, sıralama
 * doğrulaması) AYNI dosyayı kullanır; böylece "yarışmacının ekranındaki" ve
 * "admin'in hesapladığı" düzeltilmiş özkaynak hep aynı formülle çıkar.
 *
 * Neden: Borsa İstanbul verisi Yahoo'da 15 dk gecikmeli. Canlı veriyi başka
 * yerde gören biri, bizde 15 dk ESKİ fiyattan işlem yapıp geleceği bilerek
 * kazanıyordu; 20x VİOP kaldıracı bunu katlıyordu (+%700'ler). Çözüm:
 *   1) Kaldıraç: spot 1x, VİOP en fazla 5x.
 *   2) İşlem kısıtları: günde en fazla 20 emir, tek hisseye özkaynağın en
 *      fazla %30'u, sıralama için haftalık asgari işlem/hacim.
 *   3) Fiyat netleştirme: emir ANINDA gerçekleşir; veri yetişince (≈15 dk)
 *      işlem fiyatı, emrin verildiği dakikadaki GERÇEK fiyata düzeltilir.
 *      Fark nakit/ortalama maliyet olarak yansıtılır — toplam özkaynak birebir
 *      "gerçek fiyattan işlem yapılmış" gibi olur.
 *   4) 1. hafta (12 Ekim'den bu yana) işlemleri geriye dönük: VİOP kaldıracı
 *      5x'e indirgenir (adet × 5/kaldıraç) + fiyatlar netleştirilir.
 */
(function (root) {
    'use strict';

    var RULES = {
        version: '2026-10-r1',
        spotMaxLeverage: 1,
        viopMaxLeverage: 5,
        maxOrdersPerDay: 20,
        maxSymbolExposurePct: 30,
        minWeekTrades: 5,
        minWeekTurnover: 100000,
        halfSpreadPct: 0.04,
        // Yahoo gecikmesi 15 dk + 1 dk'lık mumun kapanması + pay
        trueUpDelayMs: 17 * 60 * 1000,
        // Yahoo 1 dk'lık veriyi ~7 gün geriye verir
        trueUpMaxAgeMs: 6.5 * 24 * 3600 * 1000,
        // Kurallar 1. haftanın başından itibaren geçerli (geriye dönük düzeltme)
        effectiveFromMs: Date.parse('2026-10-12T00:00:00+03:00')
    };

    function capFor(market) {
        return market === 'VIOP' ? RULES.viopMaxLeverage : RULES.spotMaxLeverage;
    }

    // Türkiye 2016'dan beri sabit UTC+3 — yaz saati yok.
    function trDay(ts) {
        return new Date(Number(ts) + 3 * 3600 * 1000).toISOString().slice(0, 10);
    }

    function fillFromMid(side, mid) {
        return side === 'BUY' ? mid * (1 + RULES.halfSpreadPct / 100) : mid * (1 - RULES.halfSpreadPct / 100);
    }

    function priceKey(symbol, ts) {
        return String(symbol) + '|' + Math.floor(Number(ts));
    }

    function booksOf(p) {
        return [
            { market: 'NORMAL', positions: p.positions || (p.positions = {}), history: p.history || (p.history = []) },
            { market: 'VIOP', positions: p.viopPositions || (p.viopPositions = {}), history: p.viopHistory || (p.viopHistory = []) }
        ];
    }

    function isFill(rec) {
        return rec && (rec.type === 'OPEN' || rec.type === 'CLOSE') && rec.qty > 0 && rec.price > 0 && rec.ts > 0;
    }

    /* Netleştirme bekleyen dolumlar: [{symbol, ts, market, id}] */
    function pendingTrueUps(p, nowMs) {
        var now = nowMs || Date.now();
        var out = [];
        booksOf(p).forEach(function (b) {
            b.history.forEach(function (rec) {
                if (!isFill(rec) || rec.tp) return;
                if (rec.ts < RULES.effectiveFromMs) return;
                var age = now - rec.ts;
                if (age < RULES.trueUpDelayMs || age > RULES.trueUpMaxAgeMs) return;
                out.push({ symbol: rec.symbol, ts: rec.ts, market: b.market, id: rec.id });
            });
        });
        return out;
    }

    /* Tek bir dolumu gerçek orta fiyata netleştirir (p'yi yerinde değiştirir).
     * Dönüş: özkaynağa etkisi (TL, + kazanç / − kayıp). */
    function applyTrueUp(p, market, rec, trueMid) {
        if (!isFill(rec) || rec.tp || !(trueMid > 0)) return 0;
        var b = market === 'VIOP' ? booksOf(p)[1] : booksOf(p)[0];
        var trueFill = fillFromMid(rec.side, trueMid);
        var d = trueFill - rec.price;            // birim fiyat farkı
        var q = rec.qty;
        var pct = rec.price > 0 && q > 0 ? Math.max(0, (rec.commission || 0) / (rec.price * q)) : 0;
        var commDelta = d * q * pct;              // komisyon farkı (yüksek fiyat → yüksek komisyon)
        var effect = 0;
        if (rec.type === 'OPEN') {
            var dir = rec.side === 'BUY' ? 1 : -1;
            var posSide = dir === 1 ? 'LONG' : 'SHORT';
            var pos = b.positions[rec.symbol];
            var belongs = pos && pos.side === posSide && pos.qty > 0 && rec.ts >= (pos.openedAt || 0);
            var openPart = belongs ? Math.min(q, pos.qty) : 0;
            if (openPart > 0) pos.avgPrice = pos.avgPrice + d * openPart / pos.qty;
            var closedPart = q - openPart;
            p.balance += -dir * d * closedPart;
            effect = -dir * d * q;
        } else {
            var posDir = rec.side === 'SELL' ? 1 : -1; // SAT ile LONG kapanır
            var delta = posDir * d * q;
            p.balance += delta;
            if (typeof rec.pnl === 'number') rec.pnl = +(rec.pnl + delta - commDelta).toFixed(2);
            effect = delta;
        }
        p.balance -= commDelta;
        effect -= commDelta;
        if (typeof rec.commission === 'number') rec.commission = +(rec.commission + commDelta).toFixed(2);
        rec.pp = rec.price;
        rec.price = trueFill;
        rec.tp = 1;
        return effect;
    }

    /* Geriye dönük kaldıraç düzeltmesi (bir kez). p yerinde değişir.
     * Kural öncesi (20x'e kadar) açılmış VİOP işlemlerinin adetleri
     * 5/kaldıraç oranında küçültülür: kâr/zarar ve komisyon aynı oranda
     * küçülür, kilitli teminat aynı kalır (5x'te aynı teminatla 5/K kadar
     * adet alınırdı). Spot'ta kaldıraç zaten 1x'ti; yine de >1 bir kayıt
     * varsa aynı mantıkla 1x'e indirgenir. */
    function applyLeverageFix(p) {
        var report = { cash: 0, scaled: 0, partial: false };
        booksOf(p).forEach(function (b) {
            var cap = capFor(b.market);
            var chrono = b.history.slice().reverse(); // en eski → en yeni
            var lots = {};                             // sembol → {qty, lev}
            var knownLevs = [];
            chrono.forEach(function (r) { if (r && r.type === 'OPEN' && r.leverage) knownLevs.push(r.leverage); });
            var fallbackLev = knownLevs.length ? knownLevs.reduce(function (a, c) { return a + c; }, 0) / knownLevs.length : 1;
            chrono.forEach(function (rec) {
                if (!isFill(rec)) return;
                var lot = lots[rec.symbol] || (lots[rec.symbol] = { qty: 0, lev: 1 });
                var L, s;
                if (rec.type === 'OPEN') {
                    L = Math.max(1, Number(rec.leverage) || 1);
                    var nq = lot.qty + rec.qty;
                    lot.lev = nq > 0 ? (lot.lev * lot.qty + L * rec.qty) / nq : L;
                    lot.qty = nq;
                } else {
                    if (lot.qty > 0) { L = lot.lev; } else { L = Math.max(1, fallbackLev); if (L > cap) report.partial = true; }
                    lot.qty = Math.max(0, lot.qty - rec.qty);
                }
                if (rec.ts < RULES.effectiveFromMs || rec.rf) return;
                s = L > cap ? cap / L : 1;
                if (s >= 1) { rec.rf = 1; return; }
                if (rec.type === 'OPEN') {
                    report.cash += (1 - s) * (rec.commission || 0); // ödenmeyecek komisyon iade
                    rec.commission = +((rec.commission || 0) * s).toFixed(2);
                    rec.leverage = cap;
                } else {
                    report.cash -= (1 - s) * (rec.pnl || 0);        // fazla kâr geri alınır / fazla zarar iade
                    rec.pnl = +((rec.pnl || 0) * s).toFixed(2);
                    rec.commission = +((rec.commission || 0) * s).toFixed(2);
                }
                rec.origQty = rec.qty;
                rec.qty = +(rec.qty * s).toFixed(4);
                rec.rf = 1;
                report.scaled++;
            });
            Object.keys(b.positions).forEach(function (sym) {
                var pos = b.positions[sym];
                if (!pos || !(pos.qty > 0)) return;
                var L = Math.max(1, Number(pos.leverage) || 1);
                if (L <= cap) return;
                var s = cap / L;
                var newQty = Math.max(1, Math.round(pos.qty * s));
                var oldMargin = typeof pos.lockedMargin === 'number' ? pos.lockedMargin : pos.avgPrice * pos.qty / L;
                var newMargin = pos.avgPrice * newQty / cap;
                report.cash += oldMargin - newMargin;             // yuvarlama farkı kadar teminat
                pos.origQty = pos.qty;
                pos.qty = newQty;
                pos.leverage = cap;
                pos.lockedMargin = newMargin;
                report.scaled++;
            });
        });
        p.balance += report.cash;
        return report;
    }

    /* Tam kural düzeltmesi: kaldıraç (bir kez) + netleştirme (fiyatı olanlar).
     * prices: { 'SYM|ts': orta fiyat } — eksik olanlar sonra tekrar denenir. */
    function applyRuleFix(p, prices, nowMs) {
        var out = { leverage: null, trueUps: 0, trueUpEffect: 0, missing: 0 };
        if (!p || typeof p.balance !== 'number') return out;
        if (!p.ruleFix || p.ruleFix.v !== RULES.version) {
            out.leverage = applyLeverageFix(p);
            p.ruleFix = { v: RULES.version, at: new Date(nowMs || Date.now()).toISOString(), cash: +out.leverage.cash.toFixed(2), partial: !!out.leverage.partial };
        }
        var need = pendingTrueUps(p, nowMs);
        need.forEach(function (n) {
            var mid = prices ? prices[priceKey(n.symbol, n.ts)] : null;
            if (!(mid > 0)) { out.missing++; return; }
            var b = n.market === 'VIOP' ? booksOf(p)[1] : booksOf(p)[0];
            var rec = b.history.filter(function (r) { return r.id === n.id && r.ts === n.ts; })[0];
            if (!rec) return;
            out.trueUpEffect += applyTrueUp(p, n.market, rec, mid);
            out.trueUps++;
        });
        return out;
    }

    /* Haftalık sıralama uygunluğu: en az 5 işlem ve 100.000 TL işlem hacmi. */
    function weekActivity(p, weekStartMs) {
        var start = Number(weekStartMs) || 0;
        var trades = 0, turnover = 0;
        booksOf(p).forEach(function (b) {
            b.history.forEach(function (rec) {
                if (!isFill(rec) || rec.ts < start) return;
                trades++;
                turnover += rec.price * rec.qty;
            });
        });
        return { trades: trades, turnover: Math.round(turnover), eligible: trades >= RULES.minWeekTrades && turnover >= RULES.minWeekTurnover };
    }

    /* Bugün (TRT) verilen emir sayısı */
    function ordersToday(p, nowMs) {
        var day = trDay(nowMs || Date.now());
        var c = p && p.orderCount;
        return c && c.day === day ? (c.n || 0) : 0;
    }
    function bumpOrderCount(p, nowMs) {
        var day = trDay(nowMs || Date.now());
        if (!p.orderCount || p.orderCount.day !== day) p.orderCount = { day: day, n: 0 };
        p.orderCount.n++;
        return p.orderCount.n;
    }

    /* Bir sembole ayrılmış tutar: spotta işlem tutarı, VİOP'ta teminat */
    function symbolExposure(p, symbol, markPrice) {
        var total = 0;
        var sp = (p.positions || {})[symbol];
        if (sp && sp.qty > 0) total += (markPrice > 0 ? markPrice : sp.avgPrice) * sp.qty;
        var vp = (p.viopPositions || {})[symbol];
        if (vp && vp.qty > 0) total += typeof vp.lockedMargin === 'number' ? vp.lockedMargin : vp.avgPrice * vp.qty / Math.max(1, vp.leverage || 1);
        return total;
    }

    var api = {
        RULES: RULES,
        capFor: capFor,
        trDay: trDay,
        priceKey: priceKey,
        fillFromMid: fillFromMid,
        pendingTrueUps: pendingTrueUps,
        applyTrueUp: applyTrueUp,
        applyLeverageFix: applyLeverageFix,
        applyRuleFix: applyRuleFix,
        weekActivity: weekActivity,
        ordersToday: ordersToday,
        bumpOrderCount: bumpOrderCount,
        symbolExposure: symbolExposure
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.OPLabRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
