# Cloudflare に出す

対戦サーバは Cloudflare Workers の無料プランで動く。置き方の決めと理由は `docs/spec/battle-server.md`
の 3.1 節（Durable Object 1 つ）と 6.5 節（R2 と D1）にある。

| 使うもの                     | 置くもの                             |
| ---------------------------- | ------------------------------------ |
| Workers と静的アセット       | API と WebSocket の入口、画面        |
| Durable Objects（SQLite 型） | 生きている対戦、マッチングの列、時計 |
| D1                           | プレイヤー、対局ログの索引           |
| R2                           | 対局ログ（1 局 1 オブジェクト）      |

## 初めて出す

1. Cloudflare のアカウントを作る（無料プラン）。
2. ダッシュボードの R2 を開き、有効にする。**支払い方法の登録を求められる。** 10 GB までは課金されない。
3. 手元で取ってくる。エンジンは private なので、読める GitHub アカウントで取ること。

   ```sh
   git clone --recurse-submodules https://github.com/nano2nano/poke-tcg-online
   cd poke-tcg-online
   npm ci
   npx wrangler login
   ```

4. 出す。

   ```sh
   npm run deploy
   ```

   初めての実行で、D1 のデータベース（`poke-tcg-online`）と R2 のバケット（`poke-tcg-online-matches`）が作られる。
   `workers.dev` のサブドメインをまだ持っていなければ、ここで決めるよう聞かれる。
   作った ID を `wrangler.jsonc` へ書き込むことがあるが、残しても捨ててもよい。次からも同じものに繋がる。

   終わると `https://poke-tcg-online.<サブドメイン>.workers.dev` が出る。そこを開けば遊べる。

`npm run deploy` は、`engine/` に commit していない変更があると出さない。対局ログにはエンジンの commit を残すので、
その commit が中身を名乗れない状態では出さない（仕様 6.3 節）。

## 更新する

```sh
git pull
npm run engine:sync
npm ci
npm run deploy
```

**出すと、指している最中の対戦は消える**（仕様 10 節）。終わった対戦とプレイヤーは残る。
誰も指していない時間に出すこと。

## 手元で動かす

```sh
npm run dev      # http://localhost:8787
```

D1 と R2 は手元の偽物で動き、中身は `.wrangler/` に残る。Cloudflare のアカウントは要らない。

## 対局ログを取ってくる

R2 のバケットをそのまま落とせば、`npm run replay:verify` が読める形になる。
落とすには S3 互換の道具（ここでは [rclone](https://rclone.org/)）を使う。

1. ダッシュボードの R2 で API トークンを作る。このバケットだけを読めるものにする
   （権限は「オブジェクト読み取り専用」）。アクセスキー ID、シークレットアクセスキー、エンドポイントが出る。
2. rclone に登録する。`provider` は `Cloudflare` を選ぶ。

   ```sh
   rclone config create r2 s3 provider=Cloudflare \
     access_key_id=<アクセスキー ID> secret_access_key=<シークレットアクセスキー> \
     endpoint=<エンドポイント>
   ```

3. 落として、再生して確かめる。

   ```sh
   rclone copy r2:poke-tcg-online-matches/matches ./matches
   npm run replay:verify matches
   ```

`matches/` は `.gitignore` に入っている。対局ログにはプレイヤーの公開の識別子と表示名が入っているので、
リポジトリへ入れないこと。

## 無料枠

上限の値は Cloudflare の料金の文書（Workers、Durable Objects、D1、R2 の各ページ）にある。気にするのは次の 4 つである。

- **Durable Object の稼働時間。** 対戦か開いた接続がある間だけ動く。見積もりは仕様 3.1 節にある。
- **Durable Object へのリクエスト。** WebSocket で受ける 20 通が 1 リクエストに数えられる。
  画面は 20 秒ごとに `ping` を送る。対戦がある間は 1 分ごとにアラームも鳴り、これも 1 リクエストに数えられる。
- **Durable Object の書き込み行数。** アラームを置くたびに 1 行と数えられる。
- **R2 の容量。** 1 局の大きさは仕様 6.5 節にある。

Workers、Durable Objects、D1 は、無料プランのまま超えた日はその日の残りが断られる。課金には切り替わらない。
**R2 だけは、超えたぶんが登録した支払い方法へ課金される。** ダッシュボードの R2 で使っている量を見られる。
