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
2. ダッシュボードの R2 を開き、有効にする。支払い方法の登録を求められる。 10 GB までは課金されない。
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

main へ入れると、GitHub Actions が検査のあとに出す（`.github/workflows/verify.yml` の deploy の job）。
**出すと、指している最中の対戦は消える**（仕様 10 節）。終わった対戦とプレイヤーは残る。
そこで deploy の job は、本番の `/api/status` が返す対戦の数が 0 になるまで待ってから出す。

- 待つのは 60 分まで。過ぎたら出さずに失敗する。本番から数が読めないとき（落ちている、形の違う応答が返る）も、
  同じく待ってから失敗する。
- 待たずに出すなら、Actions で verify を main に対して手動実行し、`wait_for_idle` を外す。main の実行は
  1 つずつしか走らないので、対戦が終わるのを待っている実行があれば、先にそれを取り消す。
- main へ続けて入れると、走っている実行が出し終えてから、最後に入れたものの実行が走る。間のものは取り消される。
- 数えるのは始まった対戦と、席が決まって始まるのを待っている対戦である。マッチングを待っている人は数えない。
  消えると、画面はもう一度「対戦をさがす」を押すよう出す。
- 0 を見てから入れ替わるまでの間に始まった対戦は消える。マッチングを止める仕組みは置いていない。
- 本番が `/api/status` を持たない版なら、待たずに出す。持たない版から上げる 1 回だけ起きる。

### 自動で出すための準備

1. Cloudflare のダッシュボードで API トークンを作る（My Profile > API Tokens > Create Token > Custom token）。
   権限は次の 2 つにし、Account Resources は出す先のアカウントだけにする。

   | 種類    | 対象            | 権限 |
   | ------- | --------------- | ---- |
   | Account | Workers Scripts | Edit |
   | Account | D1              | Read |

   D1 の読み取りは、`wrangler.jsonc` が名前だけで指しているデータベースを、動いている Worker のものと
   突き合わせるのに使う。R2 のバケットは動いている Worker の設定をそのまま引き継ぐので、権限は要らない。
   これで断られたら、テンプレートの「Edit Cloudflare Workers」で作り直す。

2. アカウント ID を控える。ダッシュボードの Workers & Pages の画面に出ている。
3. GitHub のリポジトリの Settings > Environments で `production` を作る。
   Deployment branches and tags を「Selected branches and tags」にし、`main` だけを足す。
   main 以外のブランチの実行からは、下のシークレットを読めなくなる。
4. その environment の Environment secrets に 2 つ登録する。

   | 名前                    | 値                      |
   | ----------------------- | ----------------------- |
   | `CLOUDFLARE_API_TOKEN`  | 1 で作ったトークン      |
   | `CLOUDFLARE_ACCOUNT_ID` | 2 で控えたアカウント ID |

エンジンを取る鍵は、検査と同じ `ENGINE_DEPLOY_KEY` を使う。

### 手元から出す

```sh
git pull
npm run engine:sync
npm ci
npm run deploy
```

自動のデプロイと違い、対戦が終わるのを待たない。誰も指していない時間に出すこと。

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

- Durable Object の稼働時間。 対戦か開いた接続がある間だけ動く。見積もりは仕様 3.1 節にある。
- Durable Object へのリクエスト。 WebSocket で受ける 20 通が 1 リクエストに数えられる。
  画面は 20 秒ごとに `ping` を送る。対戦がある間は 1 分ごとにアラームも鳴り、これも 1 リクエストに数えられる。
- Durable Object の書き込み行数。 アラームを置くたびに 1 行と数えられる。
- R2 の容量。 1 局の大きさは仕様 6.5 節にある。

Workers、Durable Objects、D1 は、無料プランのまま超えた日はその日の残りが断られる。課金には切り替わらない。
**R2 だけは、超えたぶんが登録した支払い方法へ課金される。** ダッシュボードの R2 で使っている量を見られる。
