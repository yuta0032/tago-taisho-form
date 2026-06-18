/**
 * 契約者ゲート（Cloudflare Pages Functions middleware）
 *
 * 役割: Cloudflare Access（メールOTP）で本人確認済みのメールアドレスを取得し、
 *       Stripeの契約状態（KV: SUBS）で出し分ける。
 *
 * 不変条件: ここを通るのは「契約者のメールと契約状態」だけ。患者データは一切通らない。
 *           Function/KV は患者データを保存も中継もしない。
 *
 * 環境変数 / バインディング:
 *   - SUBS                  : KV namespace（契約状態。キー sub:<email> = active/trialing/... ）
 *   - CF_TEAM_DOMAIN        : https://<team>.cloudflareaccess.com
 *   - CF_ACCESS_AUD         : Access アプリの AUD タグ
 *   - STRIPE_PAYMENT_LINK   : Stripe Payment Link URL
 *   - SUPPORT_EMAIL         : 問い合わせ先（任意）
 *   - ALLOW_EMAILS          : 常に通す安全弁メール（カンマ区切り・任意。ロックアウト防止用）
 */

const ACTIVE_STATUSES = ['active', 'trialing'];

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // /api/* はゲート対象外（Stripe Webhook はログインできず、独自に署名検証する）
  if (url.pathname.startsWith('/api/')) {
    return next();
  }

  // 契約者メールを Access から取得
  const email = await getAccessEmail(request, env);

  // メールが取得できない（Access未設定/検証失敗）→ フェイルクローズ（再ログイン案内）
  if (!email) {
    return messagePage(
      'ログインが必要です',
      'ご契約者の確認ができませんでした。一度ログアウトして、登録メールで再度ログインしてください。',
      env,
      401
    );
  }

  const key = 'sub:' + email.toLowerCase();

  // 安全弁: ALLOW_EMAILS に含まれるメールは常に通す（初期設定時のロックアウト防止）
  if (isAllowlisted(email, env)) {
    return next();
  }

  // KV で契約状態を確認
  let status = null;
  try {
    if (env.SUBS) status = await env.SUBS.get(key);
  } catch (e) {
    // KV 障害時は安全側（未契約扱い）。ログのみ。
    console.error('KV get failed', e);
  }

  if (status && ACTIVE_STATUSES.includes(status)) {
    return next();
  }

  // 未契約 → 申込ページ（402 Payment Required）
  return subscribePage(env, email, status);
}

/* ============ Access 認証メールの取得 ============ */

async function getAccessEmail(request, env) {
  // 1) Access JWT（ヘッダ or Cookie）を検証
  let token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    if (m) token = m[1];
  }
  if (token && env.CF_TEAM_DOMAIN) {
    try {
      const payload = await verifyAccessJwt(token, env);
      if (payload && payload.email) return String(payload.email);
    } catch (e) {
      console.error('JWT verify failed', e && e.message);
    }
  }
  // 2) フォールバック: Access が注入するヘッダ
  const h = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (h) return h;
  return null;
}

let _certsCache = { url: null, at: 0, keys: null };

async function getCerts(env) {
  const base = String(env.CF_TEAM_DOMAIN).replace(/\/+$/, '');
  const url = base + '/cdn-cgi/access/certs';
  const now = Date.now();
  if (_certsCache.keys && _certsCache.url === url && now - _certsCache.at < 3600_000) {
    return _certsCache.keys;
  }
  const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error('certs fetch ' + res.status);
  const data = await res.json();
  _certsCache = { url, at: now, keys: data.keys || [] };
  return _certsCache.keys;
}

async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const header = JSON.parse(b64urlToString(parts[0]));
  const payload = JSON.parse(b64urlToString(parts[1]));

  // aud 検証
  if (env.CF_ACCESS_AUD) {
    const aud = payload.aud;
    const ok = Array.isArray(aud) ? aud.includes(env.CF_ACCESS_AUD) : aud === env.CF_ACCESS_AUD;
    if (!ok) throw new Error('aud mismatch');
  }
  // 有効期限
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && nowSec > payload.exp + 60) throw new Error('token expired');
  if (payload.iss && env.CF_TEAM_DOMAIN) {
    const iss = String(payload.iss).replace(/\/+$/, '');
    const team = String(env.CF_TEAM_DOMAIN).replace(/\/+$/, '');
    if (iss !== team) throw new Error('iss mismatch');
  }

  // 署名検証（RS256）
  const certs = await getCerts(env);
  const jwk = certs.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const sig = b64urlToBytes(parts[2]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
  if (!valid) throw new Error('bad signature');
  return payload;
}

function isAllowlisted(email, env) {
  if (!env.ALLOW_EMAILS) return false;
  const set = String(env.ALLOW_EMAILS)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return set.includes(email.toLowerCase());
}

/* ============ base64url ============ */

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

/* ============ 画面 ============ */

function pageShell(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:"Meiryo UI","Yu Gothic UI","Hiragino Kaku Gothic ProN","MS PGothic",sans-serif;
  background:radial-gradient(1200px 500px at 50% -8%,#fff 0%,rgba(255,255,255,0) 60%),#eef1f5;color:#1d2733;padding:24px}
.box{background:#fff;border:1px solid #dde3ea;border-radius:18px;box-shadow:0 8px 28px rgba(40,60,90,.12);
  max-width:440px;width:100%;padding:30px 26px;text-align:center}
.mark{width:54px;height:54px;border-radius:15px;margin:0 auto 16px;background:linear-gradient(135deg,#0d8f7e,#34507c);
  display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:22px}
h1{font-size:19px;margin:0 0 10px}
p{font-size:14px;color:#5b6877;line-height:1.7;margin:0 0 18px}
.btn{display:inline-block;text-decoration:none;background:#0d8f7e;color:#fff;font-weight:700;font-size:15px;
  border:0;border-radius:12px;padding:14px 22px;cursor:pointer;box-shadow:0 4px 12px rgba(13,143,126,.3)}
.btn.sub{background:#635bff}
.btn2{display:inline-block;margin-top:12px;background:#eef1f4;color:#5b6877;text-decoration:none;
  border-radius:10px;padding:11px 18px;font-size:13px;font-weight:700}
.mail{font-size:13px;color:#0a6e61;font-weight:700;word-break:break-all}
.foot{margin-top:18px;font-size:12px;color:#8b97a5}
.foot a{color:#5b6877}
</style></head><body><div class="box"><div class="mark">ケ</div>${bodyHtml}</div></body></html>`;
}

function subscribePage(env, email, status) {
  const link = env.STRIPE_PAYMENT_LINK || '';
  let applyUrl = '#';
  if (link) {
    const sep = link.includes('?') ? '&' : '?';
    applyUrl = link + sep + 'prefilled_email=' + encodeURIComponent(email);
  }
  const expired = status && !ACTIVE_STATUSES.includes(status);
  const lead = expired
    ? 'ご契約が現在有効ではありません（状態: ' + escapeHtml(status) + '）。下記からお手続きください。'
    : 'このツールのご利用には契約が必要です。下記からお申し込みください。';
  const support = env.SUPPORT_EMAIL
    ? `<div class="foot">お困りの場合: <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a></div>`
    : '';
  const body = `
    <h1>ケアマネ業務ツール</h1>
    <p>${lead}<br>ログイン中のアカウント：<br><span class="mail">${escapeHtml(email)}</span></p>
    ${link ? `<a class="btn sub" href="${escapeHtml(applyUrl)}">お申し込み・お支払いへ</a>` : `<p style="color:#b9772a">申込リンクが未設定です。管理者にお問い合わせください。</p>`}
    <div><a class="btn2" href="javascript:location.reload()">支払い後に再読み込み</a></div>
    ${support}`;
  return new Response(pageShell('ご契約のお願い', body), {
    status: 402,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function messagePage(title, msg, env, statusCode) {
  const support = env.SUPPORT_EMAIL
    ? `<div class="foot">お困りの場合: <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a></div>`
    : '';
  const body = `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p>
    <div><a class="btn2" href="javascript:location.reload()">再読み込み</a></div>${support}`;
  return new Response(pageShell(title, body), {
    status: statusCode || 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
