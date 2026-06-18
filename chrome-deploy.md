# Chrome向け作業指示書 — 契約者ゲート（Cloudflare Access + Stripe）の設定

> 役割分担：**コードはクロコ（Claude Code）が実装・push済み**（`functions/_middleware.js` と `functions/api/stripe-webhook.js`）。
> このドキュメントは **ダッシュボード操作（Cloudflare / Stripe）**を Chrome 上で行うための手順です。
> 対象サイト：`https://keamane-kiroku.cb-cloud.net/` ／ Pages プロジェクト：`tago-taisho-form`

---

## 全体像（何をするか）
1. KV を作って Pages に `SUBS` でバインド
2. Pages に環境変数を5〜7個セット（**既存メアドは `ALLOW_EMAILS` に入れる＝ロックアウト防止**）
3. Stripe で価格＋Payment Link を作成
4. Cloudflare Access の AUD を取得＆ポリシー確認
5. `/api/stripe-webhook` を Access の **Bypass** にし、Stripe の Webhook を登録
6. テスト（テストカードで契約→解約）

> コードの不変条件：このゲートを通るのは「契約者メールと契約状態」だけ。**患者データは一切通りません**（Function/KV は保存も中継もしない）。

---

## 手順1. KV を作成して Pages にバインド
1. Cloudflare ダッシュボード → **Workers & Pages → KV** → **Create namespace**
   - 名前：`care_subs`
2. **Workers & Pages → tago-taisho-form → Settings → Functions → KV namespace bindings → Add binding**
   - **Variable name：`SUBS`**（★この名前で固定。コードが `env.SUBS` を参照）
   - **KV namespace：`care_subs`**
   - Production（必要なら Preview も同じ）に追加して保存

---

## 手順2. 環境変数 / シークレットを設定（★既存メアドの例外もここ）
**tago-taisho-form → Settings → Environment variables → Production** に追加：

| 変数名 | 値 | 種別 |
|---|---|---|
| `CF_TEAM_DOMAIN` | `https://＜チーム名＞.cloudflareaccess.com` | 通常 |
| `CF_ACCESS_AUD` | Access アプリの AUD タグ（手順4で取得） | 通常 |
| `STRIPE_PAYMENT_LINK` | Stripe の Payment Link URL（手順3で取得） | 通常 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`（手順5で取得） | **Secret（暗号化）** |
| `SUPPORT_EMAIL` | 問い合わせ先メール（任意） | 通常 |
| `ALLOW_EMAILS` | **既存の許可メアド（カンマ区切り）** | 通常 |

### ★ `ALLOW_EMAILS`（既存メアドの例外）について
- ここに入れたメールは**契約状態に関係なく常に通過**します（初期設定中・自分のロックアウト防止）。
- **値：現在 Cloudflare Access で許可している4アドレスをそのまま貼る**（カンマ区切り、空白可・大文字小文字は無視）。
  - 確認場所：**Zero Trust → Access → Applications → 対象アプリ → Policies → Include** に並んでいるメール。
- 記入例（実際のアドレスに置き換え）：
  ```
  ＜あなたのメール＞, staff2@example.com, staff3@example.com, staff4@example.com
  ```
- ※ 本番運用が安定し、全員を Stripe 契約に載せ替えたら、この変数は**空にするか削除**してOK（その時点から全員が契約必須になる）。

> 変更後は **Pages を再デプロイ**（環境変数はデプロイ時に反映）。Deployments → 最新を **Retry deployment** でも可。

---

## 手順3. Stripe：価格と Payment Link
1. Stripe ダッシュボード → **商品(Products)** → 月額サブスクの価格を作成（例：月額○○円／継続課金）
2. **Payment Links** → その価格でリンク作成
   - **「お客様情報でメールを収集」を ON**（契約者メールの突き合わせに必須）
   - 無料トライアルを付けるなら価格 or リンクで設定
3. 生成 URL を **手順2の `STRIPE_PAYMENT_LINK`** に設定
   - ゲートは申込時に `?prefilled_email=<ログイン中のメール>` を自動付与します

---

## 手順4. Cloudflare Access：AUD取得 & ポリシー
1. **Zero Trust → Access → Applications → 対象アプリ（keamane-kiroku.cb-cloud.net）**
2. **Application Audience (AUD) Tag** をコピー → **手順2の `CF_ACCESS_AUD`** に設定
3. `CF_TEAM_DOMAIN` は **Zero Trust → Settings → Custom Pages / Team domain** などで確認できる
   `https://＜チーム名＞.cloudflareaccess.com`
4. ログイン方式の方針：
   - **当面（自分中心でテスト）**：今の「4アドレス許可」のままでOK（`ALLOW_EMAILS` と併用で安全）
   - **将来セルフ申込**：ポリシーを **Include = Everyone**／ログイン方法 **One-time PIN** に。
     → 「誰でもOTPで本人確認はできるが、契約が無いとアプリは出ない（402で申込ページ）」になる

---

## 手順5. Webhook を Access 対象外にして Stripe に登録
### 5-1. `/api/stripe-webhook` を Access の Bypass にする（重要）
- **Zero Trust → Access → Applications → Add an application → Self-hosted**
  - **Application name**：`stripe-webhook-bypass`（任意）
  - **Domain**：`keamane-kiroku.cb-cloud.net` ／ **Path**：`api/stripe-webhook`
  - **Policy**：**Action = Bypass**、**Include = Everyone**
  - 保存。これで Stripe（ログイン不可）が叩けるようになる。
- ※ パスを絞ったこのアプリが、サイト全体アプリより先に評価されればOK。

### 5-2. Stripe で Webhook エンドポイント登録
- Stripe → **開発者(Developers) → Webhooks → エンドポイントを追加**
  - **URL**：`https://keamane-kiroku.cb-cloud.net/api/stripe-webhook`
  - **監視するイベント**：
    - `checkout.session.completed`
    - `customer.subscription.created`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
    - `invoice.payment_failed`
  - 作成後の **署名シークレット `whsec_...`** を **手順2の `STRIPE_WEBHOOK_SECRET`（Secret）** に設定
  - ※ テストモードと本番モードで `whsec_` は別物。今はテストモードのものを使う。

> `STRIPE_WEBHOOK_SECRET` を入れたら **再デプロイ** を忘れずに。

---

## 手順6. テスト（テストモード）
1. Stripe を **テストモード** にする
2. **未契約の確認**：`ALLOW_EMAILS` に入っていないメールでOTPログイン → **申込ページ(402)** が出ればOK
   （自分のメールは `ALLOW_EMAILS` に入れているので通過する。テスト用に別アドレスで試すか、一時的に自分を外す）
3. 申込ページの「お申し込み・お支払いへ」→ **テストカード `4242 4242 4242 4242`**（期限：未来日、CVC任意）で決済
   - ※ Payment Link のメールは**ログインしたメールと同一**にする（突き合わせのため）
4. 決済後、**ページを再読み込み** → アプリが開けばOK
5. **KV 確認**：Workers & Pages → KV → `care_subs` に **`sub:＜そのメール＞` が `active`** で入っているか
   （`cust:cus_xxx` のマッピングも入る）
6. **解約テスト**：Stripe で当該サブスクを解約 → `customer.subscription.deleted` 受信 → 再読み込みで**申込ページに戻る**ことを確認
   （KV の `sub:＜メール＞` が `canceled` になる）

---

## 動作の早見表（コード仕様）
- 通過条件：`SUBS` の `sub:<email>` が **`active` または `trialing`**、または `ALLOW_EMAILS` に含まれる
- それ以外：**402 申込ページ**（`STRIPE_PAYMENT_LINK` に `prefilled_email` 付き）
- メールが取れない：**401**（再ログイン案内）※Accessが前段にあるので通常は発生しない
- `/api/*` はゲート対象外（Webhook用）
- Webhook：`Stripe-Signature` を HMAC-SHA256 で検証（±5分のタイムスタンプ許容）。署名NG=400／secret未設定=500／GET=405

---

## よくある詰まり
- **Webhookが401/403**：5-1 の Bypass ができていない／パス指定ミス（`api/stripe-webhook`）。
- **決済したのに開けない**：申込メール≠ログインメール。Payment Link のメールをログインと同一に。または KV バインド名が `SUBS` でない。
- **署名エラー(400)**：`STRIPE_WEBHOOK_SECRET` の取り違え（テスト用/本番用は別）。入れ替えたら**再デプロイ**。
- **設定したのに反映されない**：環境変数はデプロイ時反映。**Retry deployment** で再デプロイ。
- **自分がロックアウト**：`ALLOW_EMAILS` に自分のメールが入っているか確認（大文字小文字は無視されるが、別アドレスは別物）。

---

## 本番移行メモ（将来）
- 本番モードに切替時：`STRIPE_PAYMENT_LINK`（本番リンク）と `STRIPE_WEBHOOK_SECRET`（本番 `whsec_`）を本番用に差し替え。
- 顧客が増えたら `ALLOW_EMAILS` を空にして「全員契約必須」へ。
- AI要約等をサーバ側で行う場合は「クラウド例外」を抜けるため、別途 委託契約＋安全管理措置が必要（ブラウザ内でAI APIを直接呼ぶ設計なら例外を維持できる）。
