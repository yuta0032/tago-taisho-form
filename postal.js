/*
 * 住所 → 郵便番号 自動入力（共通）
 *
 * 使い方: 住所入力欄に data-zip-lookup と data-zip-target="<〒欄のdata-k>" を付け、
 *   このスクリプトを読み込むだけ。
 *   <input data-k="addr" data-zip-lookup data-zip-target="zip">
 *   <script src="postal.js" defer></script>
 *
 * データ: postal.json … { "<都道府県><市区町村>": [["<町域>","<7桁〒>"], ...] }
 *   日本郵便 郵便番号データ（全国一括 utf_ken_all）から生成。
 * 判定は町域レベル（番地・建物までは〒は決まらない）。住所に都道府県を含めると確実。
 * 患者データは扱わない（公開の郵便番号マスタのみ）。
 */
(function () {
  var DATA = null, CITY_KEYS = null, loading = null;

  function load() {
    if (DATA) return Promise.resolve(DATA);
    if (loading) return loading;
    loading = fetch('postal.json')
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        DATA = j;
        // 市区町村キーを長い順（最も具体的な「政令市＋区」等を優先）に
        CITY_KEYS = Object.keys(j).sort(function (a, b) { return b.length - a.length; });
        return j;
      })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }

  // 全角空白/空白を除去、全角英数を半角へ
  function norm(s) {
    return (s || '')
      .replace(/[\s　]/g, '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  }
  function fmt(z) { return (z && z.length === 7) ? z.slice(0, 3) + '-' + z.slice(3) : z; }

  function lookup(addr) {
    if (!DATA) return '';
    addr = norm(addr);
    if (!addr) return '';
    for (var i = 0; i < CITY_KEYS.length; i++) {
      var ck = CITY_KEYS[i];
      if (addr.indexOf(ck) === 0) {
        var towns = DATA[ck];               // [[town,zip], ...] 町域長い順
        var rest = addr.slice(ck.length);
        for (var j = 0; j < towns.length; j++) {
          var t = towns[j][0];
          if (t && rest.indexOf(t) === 0) return fmt(towns[j][1]);
        }
        // 町域不一致 → 市区町村の代表（町域なし）にフォールバック
        for (var k = 0; k < towns.length; k++) {
          if (!towns[k][0]) return fmt(towns[k][1]);
        }
        return '';
      }
    }
    return '';
  }

  function attach(el) {
    if (el.__zipAttached) return;
    el.__zipAttached = true;
    var targetKey = el.getAttribute('data-zip-target');
    function run() {
      load().then(function () {
        var z = lookup(el.value);
        if (!z) return;
        var t = document.querySelector('[data-k="' + targetKey + '"]');
        if (t) { t.value = z; } // ループ防止のためイベントは発火させない
      }).catch(function () {});
    }
    el.addEventListener('change', run);
    el.addEventListener('input', run);
  }

  function init() {
    [].forEach.call(document.querySelectorAll('input[data-zip-lookup]'), attach);
  }
  window.lookupPostal = lookup;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
