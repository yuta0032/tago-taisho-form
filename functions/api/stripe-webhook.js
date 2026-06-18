/**
 * Stripe Webhook → KV（契約状態）反映
 *
 * このエンドポイント（/api/stripe-webhook）は Cloudflare Access の Bypass 対象にすること。
 * Stripe はログインできないため、署名（Stripe-Signature）で正当性を検証する。
 *
 * 取り扱うのは「契約者メールと契約状態」だけ。患者データは扱わない。
 *
 * 環境変数 / バインディング:
 *   - SUBS                   : KV namespace
 *   - STRIPE_WEBHOOK_SECRET  : whsec_...（署名シークレット）
 *
 * KV キー:
 *   - sub:<email>      = active / trialing / past_due / canceled ...
 *   - cust:<customerId> = <email>   （customer id しか持たないイベントの解決用）
 */

const ACTIVE = ['active', 'trialing'];
const SIG_TOLERANCE_SEC = 60 * 5; // 署名タイムスタンプの許容ずれ

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'webhook secret not configured' }, 500);
  }

  const payload = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') || '';

  const ok = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) {
    return json({ error: 'invalid signature' }, 400);
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }

  try {
    await handleEvent(event, env);
  } catch (e) {
    console.error('handleEvent failed', e && e.message);
    // 500 を返すと Stripe が再送する。処理側の一時障害として再送を促す。
    return json({ error: 'processing error' }, 500);
  }

  return json({ received: true }, 200);
}

// POST 以外は 405
export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}

/* ============ イベント処理 ============ */

export async function handleEvent(event, env) {
  const type = event && event.type;
  const obj = event && event.data && event.data.object ? event.data.object : {};

  switch (type) {
    case 'checkout.session.completed': {
      const email = pickEmail(obj.customer_details && obj.customer_details.email, obj.customer_email);
      const customerId = asId(obj.customer);
      // サブスク作成直後は active 扱い（後続の subscription.* で正となる状態に上書きされる）
      if (email) await setStatus(env, email, 'active');
      if (email && customerId) await mapCustomer(env, customerId, email);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const customerId = asId(obj.customer);
      const status = obj.status || 'active';
      const email = await resolveEmail(env, obj, customerId);
      if (email) await setStatus(env, email, status);
      break;
    }
    case 'customer.subscription.deleted': {
      const customerId = asId(obj.customer);
      const email = await resolveEmail(env, obj, customerId);
      if (email) await setStatus(env, email, 'canceled');
      break;
    }
    case 'invoice.payment_failed': {
      const customerId = asId(obj.customer);
      const email = await resolveEmail(env, obj, customerId, obj.customer_email);
      if (email) await setStatus(env, email, 'past_due');
      break;
    }
    default:
      // 未対応イベントは無視（200 を返す）
      break;
  }
}

async function setStatus(env, email, status) {
  if (!env.SUBS) return;
  const key = 'sub:' + String(email).toLowerCase();
  await env.SUBS.put(key, status);
}

async function mapCustomer(env, customerId, email) {
  if (!env.SUBS) return;
  await env.SUBS.put('cust:' + customerId, String(email).toLowerCase());
}

async function resolveEmail(env, obj, customerId, fallbackEmail) {
  // 1) イベント本体にメールがあれば使う
  const direct = pickEmail(fallbackEmail, obj.customer_email);
  if (direct) return direct;
  // 2) customer id → email マッピングを KV から引く
  if (customerId && env.SUBS) {
    const mapped = await env.SUBS.get('cust:' + customerId);
    if (mapped) return mapped;
  }
  return null;
}

function pickEmail() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v && typeof v === 'string') return v.toLowerCase();
  }
  return null;
}

function asId(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.id) return v.id; // expanded object
  return null;
}

/* ============ 署名検証（Stripe v1 / HMAC-SHA256） ============ */

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = {};
  sigHeader.split(',').forEach((kv) => {
    const idx = kv.indexOf('=');
    if (idx > 0) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  });
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  // タイムスタンプ許容チェック
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SIG_TOLERANCE_SEC) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(t + '.' + payload));
  const expected = bytesToHex(new Uint8Array(sigBuf));
  return timingSafeEqual(expected, v1);
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  });
}
