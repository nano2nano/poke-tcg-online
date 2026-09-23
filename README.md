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
