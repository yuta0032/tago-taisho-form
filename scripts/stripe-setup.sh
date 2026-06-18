#!/usr/bin/env bash
#
# Stripe 初期設定ワンショット（テストモード想定）
#
# できること:
#   1) 商品＋価格（月額 525円 JPY・継続課金）を作成
#   2) Payment Link を作成（14日間無料トライアル・メールは既定で収集）
#   3) Webhook を https://keamane-kiroku.cb-cloud.net/api/stripe-webhook に登録
#   4) Pages 環境変数に入れる2値（STRIPE_PAYMENT_LINK / STRIPE_WEBHOOK_SECRET）を出力
#
# 使い方（あなたの手元の端末で実行。鍵はこの端末から外に出ません）:
#   export STRIPE_SECRET_KEY=sk_test_xxx        # テスト用シークレットキー
#   bash scripts/stripe-setup.sh
#
# 依存: curl, python3
#
set -euo pipefail

URL="https://keamane-kiroku.cb-cloud.net/api/stripe-webhook"
AMOUNT_JPY=525            # JPY はゼロ小数通貨 → 525 = ¥525
TRIAL_DAYS=14
PRODUCT_NAME="ケアマネ業務ツール 月額"

: "${STRIPE_SECRET_KEY:?環境変数 STRIPE_SECRET_KEY を設定してください（例: export STRIPE_SECRET_KEY=sk_test_...）}"

case "$STRIPE_SECRET_KEY" in
  sk_live_*) echo "⚠️  本番キー(sk_live_)です。テストで試すなら sk_test_ を使ってください。3秒後に続行..."; sleep 3 ;;
  sk_test_*) : ;;
  *) echo "⚠️  STRIPE_SECRET_KEY が sk_test_/sk_live_ で始まっていません。続行しますが確認してください。" ;;
esac

# JSON から1フィールド取り出し（エラーなら表示して終了）
jget() {  # $1=フィールド
  python3 -c '
import sys,json
d=json.load(sys.stdin)
if isinstance(d,dict) and d.get("error"):
    sys.stderr.write("Stripe API error: "+json.dumps(d["error"],ensure_ascii=False)+"\n"); sys.exit(1)
v=d
for k in sys.argv[1].split("."):
    v=v.get(k) if isinstance(v,dict) else None
print(v if v is not None else "")
' "$1"
}

api() {  # $1=path ; 残り = -d 群
  local path="$1"; shift
  curl -s "https://api.stripe.com/v1/$path" -u "$STRIPE_SECRET_KEY:" "$@"
}

echo "▶ 1/4 商品を作成..."
PROD=$(api products -d "name=$PRODUCT_NAME" | jget id)
[ -n "$PROD" ] || { echo "商品作成に失敗"; exit 1; }
echo "   product = $PROD"

echo "▶ 2/4 価格を作成（月額 ${AMOUNT_JPY}円）..."
PRICE=$(api prices \
  -d "unit_amount=$AMOUNT_JPY" \
  -d "currency=jpy" \
  -d "recurring[interval]=month" \
  -d "product=$PROD" | jget id)
[ -n "$PRICE" ] || { echo "価格作成に失敗"; exit 1; }
echo "   price = $PRICE"

echo "▶ 3/4 Payment Link を作成（${TRIAL_DAYS}日トライアル）..."
PAY_URL=$(api payment_links \
  -d "line_items[0][price]=$PRICE" \
  -d "line_items[0][quantity]=1" \
  -d "subscription_data[trial_period_days]=$TRIAL_DAYS" | jget url)
[ -n "$PAY_URL" ] || { echo "Payment Link 作成に失敗"; exit 1; }

echo "▶ 4/4 Webhook を登録..."
WH_JSON=$(api webhook_endpoints \
  -d "url=$URL" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.created" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "enabled_events[]=invoice.payment_failed")
WH_ID=$(printf '%s' "$WH_JSON" | jget id)
WH_SECRET=$(printf '%s' "$WH_JSON" | jget secret)
[ -n "$WH_SECRET" ] || { echo "Webhook 作成に失敗: $WH_JSON"; exit 1; }
echo "   webhook = $WH_ID"

cat <<EOF

============================================================
✅ 完了。以下の2値を Cloudflare Pages の環境変数(Production)へ：

  STRIPE_PAYMENT_LINK   = $PAY_URL
  STRIPE_WEBHOOK_SECRET = $WH_SECRET     ← 種別: Secret(暗号化)

入れたら Pages を再デプロイ（Retry deployment）。
※ これらはテストモードの値です。本番移行時は本番モードで取り直してください。
============================================================
EOF
