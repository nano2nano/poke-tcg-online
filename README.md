# poke-tcg-online

ポケモンカードゲームの、人間同士のオンライン対戦サーバ。
ルールの判定は [poke-tcg-engine](https://github.com/nano2nano/poke-tcg-engine) が行い、
このリポジトリはその上に、対戦の進行、情報の秘匿、通信、対局ログを載せる。

対局は AI の学習に使える形で残す。ログは seed と手の列だけを唯一の情報源とし、
局面もイベントも保存しない。エンジンの決定性がそれを保証する。

## 文書

- 仕様: `docs/spec/battle-server.md`
- ルールエンジンの仕様: `engine/docs/spec/engine-core.md`

決定とその理由はすべて仕様にある。この README には書き写さない。

## 動かす

Cloudflare Workers で動く。手元では `wrangler dev` が同じものを動かすので、Cloudflare のアカウントは要らない。

```sh
git clone --recurse-submodules https://github.com/nano2nano/poke-tcg-online
cd poke-tcg-online
npm ci
npm run dev         # http://localhost:8787
```

`--recurse-submodules` を忘れた場合は `npm run engine:sync` でエンジンを取り込む。
Cloudflare へ出す手順は `docs/deploy.md` にある。

ブラウザで開くと、名前とルームコードを入れて対戦に入れる。
ルームコードを空にするとマッチングキューへ入り、先に待っていた人と繋がる。
対戦中の画面に出る観戦のリンクを渡すと、ほかの人がその対戦を観戦できる。

`public/` の画面は盤面を卓の配置で描き（カードの画像は仕様 3.7 節）、
サーバが送ってきた合法手をそのまま並べる。**盤面の判断を一切持たない。**
横に広い画面では、両者の盤面と手札をスクロールせずに見られるよう、指せる手とできごとを右の欄へ寄せ、
カードの大きさを画面の高さと盤面の幅から決める。

## AI と対戦する

学習した方策（`poke-tcg-engine` の `harness/train.ts` が書く重み）と、画面の「AI と対戦する」から指せる。
重みは R2 の `bots/` に置き、キーの `bots/` より後ろが画面に出る名前になる（仕様 7.3 節）。
AI との対戦はレーティングを動かさない。

```sh
# 手元（npm run dev）へ置く
npx wrangler r2 object put poke-tcg-online-matches/bots/s0-g50 --file ../poke-tcg-engine/runs/ppo/s0/ppo-clip-g50.weights --local
# Cloudflare へ置く
npx wrangler r2 object put poke-tcg-online-matches/bots/s0-g50 --file ../poke-tcg-engine/runs/ppo/s0/ppo-clip-g50.weights --remote
```

重みは、`engine/` と同じ特徴の語彙を持つエンジンで作ったものしか読めない。語彙が違うと、選んだときに断られる。
エンジンを上げて語彙が変わったら、エンジンの `tools/migrate-ppo-weights.ts` で重みを今の語彙へ写してから置き直す。
伏せたカードの知識を使わずに学習した重みは `--knowledge=zero` で写す。増えた入力の重みが 0 になるので、写す前と同じ確率で手を選ぶ。

```sh
cd ../poke-tcg-engine
npx tsx tools/migrate-ppo-weights.ts --in=runs/ppo/s0/ppo-clip-g50.weights --out=migrated/ppo-clip-g50.weights --knowledge=zero
```

R2 へ置くのは写したほうのファイル（この例なら `migrated/ppo-clip-g50.weights`）にする。

### 学習の途中の方策と指す

走っている学習のいまの方策を、決まった名前へアップロードし続ける。学習と同じ機械の別の端末で回す。
いまの方策は、ゲートが昇格を決める走り（`--gate=filter`）ではゲートを通った世代で、ゲートを測るだけの走り
（`--gate=measure`）では見るたびにそのときの最新の更新である。

```sh
npx tsx tools/publish-bots.ts ../poke-tcg-engine/runs/x --name=learning           # Cloudflare へ。5 分ごとに見る
npx tsx tools/publish-bots.ts ../poke-tcg-engine/runs/x --name=learning --local   # 手元（npm run dev）へ
```

画面の「AI と対戦する」で `learning` を選ぶと、そのときのいまの方策と指せる。10 世代ごとの世代も
`learning-g10`、`learning-g20` のように残る（`--keep-every=0` で残さない）。見る間隔は `--every=<秒>`、1 回だけアップロードするなら `--once`。
アップロードする前にこのリポジトリのエンジンで重みを読むので、`engine/` が学習を回しているエンジンと同じ特徴の語彙でなければ止まる。
Cloudflare へアップロードした重みを本番で読むには、本番の Worker もこの `engine/` で出ている必要がある。

## 検査

```sh
npm run verify:all        # 型検査、書式、テスト
npm test
npm run test:e2e          # ブラウザで画面を動かす
npm run replay:verify matches    # R2 から落とした対局ログを再生して検証する（docs/deploy.md）
```

`replay:verify` はログの健全性の検査であると同時に、エンジンの検査でもある。
人間の対局は、一様ランダムの自己対戦が踏まない筋を踏む。
定期に回せば、実際に指された盤面が未知の誤りを探す標本になる。

## CI

`.github/workflows/verify.yml` が push と pull request で `npm run verify:all` を回す。
job の名前は `verify` で、ブランチ保護の required check はこれを指す。
main では、そのあと deploy の job が本番へ出す（`docs/deploy.md`）。

エンジンは private なので、submodule の取得だけ deploy key（読み取り専用の SSH 秘密鍵）で行う。
鍵は Actions secret の `ENGINE_DEPLOY_KEY` に置く。リポジトリ自身の checkout には既定の
トークンを使い、鍵を渡さない。**fork から来た pull request にはシークレットが渡らないため、
エンジンを取得できず検査が落ちる。** その変更を検査するには、このリポジトリのブランチへ push すること。

## 手を入れるときに気をつけること

- **座席へ出る値は `src/hub.ts` の `syncFor` と `deltaFor` だけが、観戦者へ出る値は
  `spectatorSyncFor` と `spectatorDeltaFor` だけが組み立てる。**
  `GameState` と生の `DomainEvent` を送る経路を増やさない。
  `tests/leak.test.ts` が、配信される値とイベントに隠れたカードが混じらないことを全局面で検査する。
- **下の層は現在時刻を引数で受け取る。** `Date.now()` を呼ぶのは、`now` を差し替えられる入口の既定値だけである。
- **エンジンへの import は `src/engine.ts` に集める。** 取り込み方を変えるときに直すのが 1 箇所で済む。
  例外は `src/engine-invariants.ts` だけで、こちらは検証の道具しか使わない別の入口である。
- **カードの識別子をこのリポジトリへ書かない。** サンプルデッキもテストの `defId` も、
  登録済みのカードから実行時に引く（`src/sample-deck.ts`）。カードの定義はエンジンの側にある。
- **`Move` に投了と時間切れを足さない。** 行動空間に投了があると、学習する方策がそれを選べるようになる。
- **プレイヤーについて、識別子と表示名とレーティングより多くを保存しない。** メールアドレスもパスワードも
  置かない。シークレットは控えを持たず、公開の識別子とは別の値にする。
- **カードの名前から `defId` を推測しない。** 同じ名前で定義が違うカードが正規データの過半にある。
  `src/decklist.ts` は選べないときに候補を返して拒否する。黙って 1 つ選ぶと、
  例外も出ないまま別のデッキで対戦が始まる。
