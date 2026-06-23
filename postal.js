/*
 * 住所 ⇄ 郵便番号 自動入力（共通・双方向）
 *
 * 住所欄: data-zip-lookup  data-zip-target="<〒欄のdata-k>"   … 住所→〒
 * 〒欄  : data-addr-lookup data-addr-target="<住所欄のdata-k>" … 〒→住所（住所が空のときだけ）
 *   <script src="postal.js" defer></script>
 *
 * データ: postal.json … { "<都道府県><市区町村>": [["<町域>","<7桁〒>"], ...] }
 * 手入力だけでなく、病院検索やプログラムでの自動入力（イベントが飛ばないケース）にも
 * 反映されるよう、値の変化を監視（reconcile）して反映する。
 * 判定は町域レベル。住所は都道府県から入れると確実。患者データは扱わない。
 */
(function () {
  var DATA = null, CITY_KEYS = null, ZIPMAP = null, loading = null;
  var addrFields = [], zipFields = [];

  function load() {
    if (DATA) return Promise.resolve(DATA);
    if (loading) return loading;
    loading = fetch('postal.json')
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        DATA = j;
        CITY_KEYS = Object.keys(j).sort(function (a, b) { return b.length - a.length; });
        ZIPMAP = {};
        for (var i = 0; i < CITY_KEYS.length; i++) {
          var ck = CITY_KEYS[i], towns = j[ck];
          for (var t = 0; t < towns.length; t++) {
            var z = towns[t][1];
            if (!ZIPMAP[z]) ZIPMAP[z] = ck + (towns[t][0] || '');
          }
        }
        return j;
      })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }

  function han(s) {
    return (s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  }
  function normAddr(s) { return han(s).replace(/[\s　]/g, ''); }
  function digits(s) { return han(s).replace(/[^0-9]/g, ''); }
  function fmt(z) { return (z && z.length === 7) ? z.slice(0, 3) + '-' + z.slice(3) : z; }

  function addrToZip(addr) {
    if (!DATA) return '';
    addr = normAddr(addr); if (!addr) return '';
    for (var i = 0; i < CITY_KEYS.length; i++) {
      var ck = CITY_KEYS[i];
      if (addr.indexOf(ck) === 0) {
        var towns = DATA[ck], rest = addr.slice(ck.length);
        for (var j = 0; j < towns.length; j++) { if (towns[j][0] && rest.indexOf(towns[j][0]) === 0) return fmt(towns[j][1]); }
        for (var k = 0; k < towns.length; k++) { if (!towns[k][0]) return fmt(towns[k][1]); }
        return '';
      }
    }
    return '';
  }
  function zipToAddr(zip) {
    if (!DATA) return '';
    var z = digits(zip); if (z.length !== 7) return '';
    return ZIPMAP[z] || '';
  }
  function target(el, attr) { var k = el.getAttribute(attr); return k ? document.querySelector('[data-k="' + k + '"]') : null; }

  function runForward(el) {            // 住所 → 〒
    load().then(function () {
      var z = addrToZip(el.value); if (!z) return;
      var t = target(el, 'data-zip-target'); if (t && t.value !== z) t.value = z;
    }).catch(function () {});
  }
  function runReverse(el) {            // 〒 → 住所（住所が空のときだけ）
    load().then(function () {
      var a = zipToAddr(el.value); if (!a) return;
      var t = target(el, 'data-addr-target'); if (t && !t.value.trim()) t.value = a;
    }).catch(function () {});
  }

  function reconcile() {               // オート入力/プログラム変更を取りこぼさない
    for (var i = 0; i < addrFields.length; i++) { var f = addrFields[i]; if (f.el.value !== f.last) { f.last = f.el.value; runForward(f.el); } }
    for (var j = 0; j < zipFields.length; j++) { var g = zipFields[j]; if (g.el.value !== g.last) { g.last = g.el.value; runReverse(g.el); } }
  }

  function init() {
    [].forEach.call(document.querySelectorAll('input[data-zip-lookup]'), function (el) {
      el.addEventListener('input', function () { runForward(el); });
      el.addEventListener('change', function () { runForward(el); });
      el.addEventListener('blur', function () { runForward(el); });
      addrFields.push({ el: el, last: el.value });
    });
    [].forEach.call(document.querySelectorAll('input[data-addr-lookup]'), function (el) {
      el.addEventListener('input', function () { runReverse(el); });
      el.addEventListener('change', function () { runReverse(el); });
      zipFields.push({ el: el, last: el.value });
    });
    load().catch(function () {});      // 先読み
    if (addrFields.length || zipFields.length) setInterval(reconcile, 500);
  }
  window.lookupPostal = addrToZip;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
