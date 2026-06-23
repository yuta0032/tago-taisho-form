/*
 * 医療機関 検索オートコンプリート（共通）
 *
 * 使い方: 名称入力欄に data-hosp-search 属性を付けて、このスクリプトを読み込むだけ。
 *   <input type="text" data-k="hosp" data-hosp-search>
 *   <script src="hospitals.js" defer></script>
 *
 * データ: hospitals.json … [["正式名称","フリガナ","所在地"], ...]（同一ドメインから遅延ロード）
 * 名称・フリガナ（カナ/かな両対応）・所在地のいずれかの部分一致で絞り込み。
 * 患者データは扱わない。公的な医療機関の公開情報のみ。
 */
(function () {
  var DATA = null, loading = null;

  function load() {
    if (DATA) return Promise.resolve(DATA);
    if (loading) return loading;
    loading = fetch('hospitals.json')
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) { DATA = j; return j; })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }

  function norm(s) { return (s || '').toLowerCase(); }
  // カタカナ→ひらがな（フリガナ検索をかな入力でもヒットさせる）
  function k2h(s) {
    return (s || '').replace(/[ァ-ヶ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x60);
    });
  }
  function esc(s) {
    return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function injectCss() {
    if (document.getElementById('hosp-search-css')) return;
    var st = document.createElement('style');
    st.id = 'hosp-search-css';
    st.textContent =
      '.hosp-wrap{position:relative}' +
      '.hosp-suggest{position:absolute;left:0;right:0;top:100%;z-index:80;background:#fff;border:1px solid #cfd8e2;' +
      'border-radius:10px;box-shadow:0 8px 24px rgba(20,40,60,.18);max-height:46vh;overflow:auto;margin-top:4px}' +
      '.hosp-suggest .hs-item{padding:9px 11px;cursor:pointer;border-top:1px solid #eef1f4}' +
      '.hosp-suggest .hs-item:first-child{border-top:0}' +
      '.hosp-suggest .hs-item.on,.hosp-suggest .hs-item:hover{background:#e8f5f1}' +
      '.hosp-suggest .hs-n{font-size:14px;font-weight:700;color:#1d2733;line-height:1.35}' +
      '.hosp-suggest .hs-a{font-size:11.5px;color:#5b6877;margin-top:1px}' +
      '.hosp-suggest .hs-more{padding:7px 11px;font-size:11px;color:#8b97a5;text-align:center}';
    document.head.appendChild(st);
  }

  function attach(input, opts) {
    if (!input || input.__hospAttached) return;
    input.__hospAttached = true;
    opts = opts || {};
    injectCss();
    input.setAttribute('autocomplete', 'off');

    var wrap = document.createElement('div');
    wrap.className = 'hosp-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var box = document.createElement('div');
    box.className = 'hosp-suggest';
    box.style.display = 'none';
    wrap.appendChild(box);

    var items = [], active = -1, truncated = false;

    function hide() { box.style.display = 'none'; active = -1; }
    function fillTarget(k, v) {
      if (!k || v == null || v === '') return;
      var t = document.querySelector('[data-k="' + k + '"]');
      if (t) { t.value = v; t.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    function pick(rec) {
      input.value = rec[0];          // rec = [名称, フリガナ, 所在地, 〒?, 電話?]
      fillTarget(opts.addr, rec[2]);  // 所在地
      fillTarget(opts.zip, rec[3]);   // 郵便番号（データにあれば）
      fillTarget(opts.tel, rec[4]);   // 電話（データにあれば）
      // データに〒が無くても、住所から即時に郵便番号を引いて反映する
      if (opts.zip && rec[2] && (rec[3] == null || rec[3] === '') &&
          typeof window.lookupPostalAsync === 'function') {
        window.lookupPostalAsync(rec[2]).then(function (z) { if (z) fillTarget(opts.zip, z); });
      }
      hide();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function mark() {
      [].forEach.call(box.querySelectorAll('.hs-item'), function (c, i) {
        c.classList.toggle('on', i === active);
      });
    }
    function render(q) {
      if (!DATA || !q) { hide(); return; }
      var ql = norm(q), qh = k2h(q), out = [];
      truncated = false;
      for (var i = 0; i < DATA.length; i++) {
        var r = DATA[i];
        if (norm(r[0]).indexOf(ql) >= 0 || k2h(r[1]).indexOf(qh) >= 0 ||
            norm(r[1]).indexOf(ql) >= 0 || norm(r[2]).indexOf(ql) >= 0) {
          out.push(r);
          if (out.length >= 40) { truncated = true; break; }
        }
      }
      items = out; active = -1;
      if (!out.length) { box.innerHTML = '<div class="hs-more">該当なし</div>'; box.style.display = 'block'; return; }
      var h = out.map(function (r, i) {
        return '<div class="hs-item" data-i="' + i + '"><div class="hs-n">' + esc(r[0]) +
          '</div><div class="hs-a">' + esc(r[2]) + '</div></div>';
      }).join('');
      if (truncated) h += '<div class="hs-more">さらに絞り込んでください…</div>';
      box.innerHTML = h;
      box.style.display = 'block';
    }

    input.addEventListener('focus', function () {
      load().then(function () { if (input.value) render(input.value); }).catch(function () {});
    });
    input.addEventListener('input', function () {
      load().then(function () { render(input.value); }).catch(function () {});
    });
    input.addEventListener('keydown', function (e) {
      if (box.style.display === 'none') return;
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); mark(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); mark(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (active >= 0) { pick(items[active]); e.preventDefault(); } }
      else if (e.key === 'Escape') { hide(); }
    });
    box.addEventListener('mousedown', function (e) {
      var it = e.target.closest('.hs-item');
      if (it) { pick(items[+it.getAttribute('data-i')]); e.preventDefault(); }
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) hide(); });
  }

  function init() {
    var nodes = document.querySelectorAll('input[data-hosp-search]');
    [].forEach.call(nodes, function (el) {
      attach(el, {
        addr: el.getAttribute('data-hosp-addr') || '',
        zip: el.getAttribute('data-hosp-zip') || '',
        tel: el.getAttribute('data-hosp-tel') || ''
      });
    });
  }

  window.attachHospitalSearch = attach;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
