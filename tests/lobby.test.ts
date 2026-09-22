/** 相手を見つける（`docs/spec/battle-server.md` 7 節）と、座席の接続（3.3 節）。 */

import { describe, expect, it } from "vitest";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { Lobby } from "../src/lobby.js";
import { AccountStore } from "../src/accounts.js";
import { MatchRegistry } from "../src/registry.js";
import type { ServerMessage } from "../src/protocol.js";
import { ensureCards, legalDecks } from "./helpers.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function recorder(): SeatSocket & { sent: ServerMessage[]; closed: boolean } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    closed: false,
    send(data: string) {
      sent.push(JSON.parse(data) as ServerMessage);
    },
    close() {
      this.closed = true;
    },
  };
}

interface Arena {
  lobby: Lobby;
  registry: MatchRegistry;
  hub: MatchHub;
  accounts: AccountStore;
}

function newArena(seatedLimit?: number): Arena {
  const dir = mkdtempSync(join(tmpdir(), "poke-online-"));
  const registry = new MatchRegistry(dir);
  const accounts = new AccountStore(dir);
  return {
    registry,
    accounts,
    lobby: new Lobby(registry, accounts, () => 0, seatedLimit),
    hub: new MatchHub({ registry, now: () => 0 }),
  };
}

/** 待っていた側が取りに行って、座れた席を返す。座れていなければテストを落とす。 */
function seatOf(lobby: Lobby, ticket: string) {
  const claimed = lobby.claim(ticket);
  if (claimed.kind !== "seated") throw new Error(`席が取れていない: ${claimed.kind}`);
  return claimed.seat;
}

/** プレイヤーを 1 人作り、そのシークレットで入る要求を組む。 */
function player(arena: Arena, name: string, roomCode?: string) {
  const deck = legalDecks()[0];
  const { secret } = arena.accounts.create(name, 0);
  return roomCode === undefined ? { secret, deck } : { secret, deck, roomCode };
}

describe("相手を見つける", () => {
  it("同じルームコードの 2 人を繋ぐ", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const first = lobby.join(player(arena, "a", "あいことば"));
    expect(first).toEqual({ ok: true, ticket: expect.any(String) });

    const second = lobby.join(player(arena, "b", "あいことば"));
    expect(second.ok && "seat" in second && second.seat.seat).toBe(1);
    expect(first.ok ? seatOf(lobby, first.ticket).seat : null).toBe(0);
  });

  it("ルームコードが違えば繋がない", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    lobby.join(player(arena, "a", "ひとつめ"));
    const second = lobby.join(player(arena, "b", "ふたつめ"));
    expect(second.ok && "seat" in second).toBe(false);
    expect(lobby.waitingCount()).toBe(2);
  });

  /**
   * 別のタブを開いたり、待っている間に読み込み直すと、同じプレイヤーが 2 回入ってくる。
   * 自分と自分の対戦が 1 局として記録に残り、そのプレイヤーに 1 勝 1 敗が付いてしまう。
   */
  it("同じプレイヤーは自分と当たらない", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const deck = legalDecks()[0]!;
    const { secret } = arena.accounts.create("ふたつのタブ", 0);

    const first = lobby.join({ secret, deck });
    const second = lobby.join({ secret, deck });
    // 2 回目で対戦が始まっていない。待っているのは 1 つだけである。
    expect(second.ok && "seat" in second).toBe(false);
    expect(lobby.waitingCount()).toBe(1);
    // 古いほうは降りている。**「待っている」と答えてはいけない。** 古いタブが待ち続ける。
    expect(first.ok ? lobby.claim(first.ticket).kind : null).toBe("dropped");

    // 別の人が来れば、生きているほうのタブと繋がる。
    const other = lobby.join(player(arena, "ほかのひと"));
    expect(other.ok && "seat" in other).toBe(true);
    expect(lobby.waitingCount()).toBe(0);
  });

  it("ルームコードでも自分と当たらない", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const deck = legalDecks()[0]!;
    const { secret } = arena.accounts.create("ふたつのタブ", 0);

    lobby.join({ secret, deck, roomCode: "へや" });
    const second = lobby.join({ secret, deck, roomCode: "へや" });
    expect(second.ok && "seat" in second).toBe(false);
    expect(lobby.waitingCount()).toBe(1);
  });

  it("マッチングキューは先に待っていた人から繋ぐ", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const first = lobby.join(player(arena, "a"));
    lobby.join(player(arena, "b"));
    const third = lobby.join(player(arena, "c"));
    // a と b が繋がり、c だけが残る。
    expect(first.ok ? lobby.claim(first.ticket).kind : null).toBe("seated");
    expect(third.ok && "seat" in third).toBe(false);
    expect(lobby.waitingCount()).toBe(1);
  });

  /**
   * 記録に残すのは**対戦が始まった時点**のレーティングである（7.2 節）。待っている間に
   * 別のタブの対戦が終わればレーティングは動く。チケットを取ったときの値を残すと、記録がずれる。
   */
  it("記録に残るレーティングは、待ち始めた時点ではなく対戦が始まった時点のもの", () => {
    ensureCards();
    const arena = newArena();
    const { lobby, accounts } = arena;
    const waiting = accounts.create("さきに待つ人", 0);
    const other = accounts.create("あとから来る人", 0);
    const deck = legalDecks()[0]!;

    lobby.join({ secret: waiting.secret, deck, roomCode: "へや" });
    // 待っている間に、別のところで 1 局終わってレーティングが動く。
    const third = accounts.create("よその人", 0);
    accounts.applyResult([waiting.account.playerId, third.account.playerId], 1, 0);
    const moved = accounts.byPlayerId(waiting.account.playerId)?.rating ?? 0;
    expect(moved).not.toBe(waiting.account.rating);

    const second = lobby.join({ secret: other.secret, deck, roomCode: "へや" });
    const seated = second.ok && "seat" in second ? second.seat : null;
    const match = arena.registry.live().find((live) => live.matchId === seated?.matchId);
    expect(match?.seats[0]?.rating).toBe(moved);
  });

  it("検査を通らないデッキではマッチングキューに入れない", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const outcome = lobby.join({
      secret: arena.accounts.create("a", 0).secret,
      deck: { cards: [] },
    });
    expect(outcome.ok).toBe(false);
    expect(lobby.waitingCount()).toBe(0);
  });

  /**
   * 表示名の変更はストアとそれ以後の対局ログに残り、取り消せない。断られた側から見れば
   * 何も起きていないのに、名前だけが変わっていることになる。
   */
  it("入れなかった人の表示名は書き換えない", () => {
    ensureCards();
    const arena = newArena();
    const { secret, account } = arena.accounts.create("まえ", 0);

    const outcome = arena.lobby.join({ secret, deck: { cards: [] }, displayName: "あと" });

    expect(outcome.ok).toBe(false);
    expect(arena.accounts.byPlayerId(account.playerId)?.displayName).toBe("まえ");
  });

  it("入れた人の表示名は書き換える", () => {
    ensureCards();
    const arena = newArena();
    const { secret, account } = arena.accounts.create("まえ", 0);

    const outcome = arena.lobby.join({ secret, deck: legalDecks()[0], displayName: "あと" });

    expect(outcome.ok).toBe(true);
    expect(arena.accounts.byPlayerId(account.playerId)?.displayName).toBe("あと");
  });
});

/**
 * 引き換え待ちの座席は、待っていた人が座席を受け取る唯一の道である。1 度読んだら消す作りだと、
 * その応答が回線の不調で落ちただけで、**対戦は始まっているのに座れない人**ができる。
 * その人は時間切れで負け、記録には普通の負けとして残る。
 */
describe("席の引き換え", () => {
  it("同じチケットで何度取りに来ても同じ座席を返す", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const first = lobby.join(player(arena, "a", "へや"));
    lobby.join(player(arena, "b", "へや"));
    if (!first.ok) throw new Error("入れていない");

    const once = lobby.claim(first.ticket);
    const twice = lobby.claim(first.ticket);

    expect(once.kind).toBe("seated");
    expect(twice).toEqual(once);
  });

  /**
   * 席が決まったあと、取りに行く前に対戦が終わることがある（相手がすぐ投了した、
   * 時間切れになった）。**これを「降りている」と同じ応答にすると嘘になる。**
   * その人は指していないがプレイヤーとしては数えられていて、レーティングも動き、記録も残っている。
   */
  it("引き換えに来る前に終わった対戦は、降りたチケットと区別して答える", () => {
    ensureCards();
    const arena = newArena();
    const { lobby, registry } = arena;
    const first = lobby.join(player(arena, "a", "へや"));
    lobby.join(player(arena, "b", "へや"));
    if (!first.ok) throw new Error("入れていない");
    const seat = seatOf(lobby, first.ticket);

    // 時間切れで終わらせる。持ち時間は 1 手ぶんとバンクで 16 分あるので、そこを越える。
    const [ended] = registry.sweepTimeouts(60 * 60_000);
    if (ended === undefined) throw new Error("対戦が終わっていない");
    registry.retire(ended);
    expect(registry.bySeatToken(seat.seatToken)).toBeUndefined();

    expect(lobby.claim(first.ticket)).toEqual({ kind: "finished", matchId: seat.matchId });
  });

  /**
   * **知らないチケットと、降ろしたチケットは別である。** ロビーはメモリにしか無いので、サーバを
   * 入れ替えればチケットは全部知らないものになる。これを「降りている」と答えると、タブを 1 つしか
   * 開いていない人にまで「別のタブから入り直した」と言うことになる。
   */
  it("知らないチケットは「降りている」ではなく「知らない」と答える", () => {
    const arena = newArena();
    const { lobby } = arena;
    expect(lobby.claim("そんなチケットは無い").kind).toBe("unknown");

    // こちらから降ろしたチケットだけが「降りている」になる。同じプレイヤーが別のタブから入り直す形。
    const deck = legalDecks()[0]!;
    const { secret } = arena.accounts.create("ふたつのタブ", 0);
    const first = lobby.join({ secret, deck, roomCode: "へや" });
    if (!first.ok) throw new Error("入れていない");
    expect(lobby.claim(first.ticket).kind).toBe("waiting");
    const again = lobby.join({ secret, deck, roomCode: "べつのへや" });
    if (!again.ok) throw new Error("入れていない");
    expect(lobby.claim(first.ticket).kind).toBe("dropped");

    // 入れ替えのあと（＝何も覚えていないロビー）は、同じチケットでも「知らない」になる。
    const fresh = newArena();
    expect(fresh.lobby.claim(first.ticket).kind).toBe("unknown");
  });

  /**
   * 席を覚えきれなくなったとき、**まだ対戦中の席を捨てない。** 捨てると、その人は
   * 取りに来ても席をもらえず、画面は入り直せと言う。入り直せば 2 局目が始まり、
   * 1 局目は時間切れの負けとして記録に残る。1 手も指していないのにである。
   */
  it("席が溢れても、まだ対戦中の席は返し続ける", () => {
    const arena = newArena();
    const { lobby } = arena;
    const deck = legalDecks()[0]!;
    const seat = (name: string): string => {
      const a = arena.accounts.create(`${name}-a`, 0).secret;
      const b = arena.accounts.create(`${name}-b`, 0).secret;
      const first = lobby.join({ secret: a, deck, roomCode: name });
      lobby.join({ secret: b, deck, roomCode: name });
      if (!first.ok) throw new Error("入れていない");
      return first.ticket;
    };

    const early = seat("さいしょ");
    expect(lobby.claim(early).kind).toBe("seated");

    // 覚えていられる数を超えるまで、終わらない対戦を積む。
    for (let i = 0; i < 300; i++) seat(`へや-${i}`);

    expect(lobby.claim(early).kind).toBe("seated");
  }, 60_000);

  /**
   * 溢れたときに捨てるのは**溢れたぶんだけ**である。終わっているというだけでまとめて
   * 捨てると、いま終わったばかりの対戦の席まで消える。その人は「もう終わっている」ではなく
   * 「知らない」と言われ、リプレイへの入り口を失う。
   */
  it("溢れても、終わったばかりの席までまとめて捨てない", () => {
    const arena = newArena(4);
    const { lobby, registry } = arena;
    const deck = legalDecks()[0]!;
    const seat = (name: string): string => {
      const a = arena.accounts.create(`${name}-a`, 0).secret;
      const b = arena.accounts.create(`${name}-b`, 0).secret;
      const first = lobby.join({ secret: a, deck, roomCode: name });
      lobby.join({ secret: b, deck, roomCode: name });
      if (!first.ok) throw new Error("入れていない");
      return first.ticket;
    };

    // 終わった席を 2 つ作る。古いほう（さき）から捨てられる。
    const older = seat("さき");
    const newer = seat("あと");
    for (const ended of registry.sweepTimeouts(60 * 60_000)) registry.retire(ended);
    const started = lobby.claim(older);
    if (started.kind !== "finished") throw new Error("終わっていない");
    const olderMatchId = started.matchId;
    expect(lobby.claim(newer).kind).toBe("finished");

    // 上限（4）を 1 つだけ超えさせる。捨てるのは 1 つで足りる。
    seat("いま-1");
    seat("いま-2");
    seat("いま-3");

    /**
     * **席は捨てても、終わった対戦があったことは答え続ける。** ここで「知らない」と
     * 答えると、画面はもう一度さがせと言う。その人は 2 局目を始めてしまうが、
     * 1 局目はレーティングを動かしログにも残っていて、本人はそこへ辿り着けない。
     */
    const gone = lobby.claim(older);
    expect(gone.kind).toBe("finished");
    if (gone.kind !== "finished") throw new Error("終わっていない");
    expect(gone.matchId).toBe(olderMatchId);
    // まだ溢れていないぶんは残っている。
    expect(lobby.claim(newer).kind).toBe("finished");
  });

  /**
   * `leave` は知らないチケットでも呼べる。それを「降ろした」と覚えると、知らないものに
   * 「降りている」と答えるようになり、**呼ばれた回数だけ本物の記録が押し出される。**
   */
  it("知らないチケットに `leave` を呼んでも、「降りている」にはならない", () => {
    const arena = newArena();
    const { lobby } = arena;
    const deck = legalDecks()[0]!;
    const { secret } = arena.accounts.create("ひとり", 0);

    const mine = lobby.join({ secret, deck, roomCode: "へや" });
    if (!mine.ok) throw new Error("入れていない");
    const again = lobby.join({ secret, deck, roomCode: "べつのへや" });
    if (!again.ok) throw new Error("入れていない");
    expect(lobby.claim(mine.ticket).kind).toBe("dropped");

    for (let i = 0; i < 300; i++) lobby.leave(`知らないチケット-${i}`);

    expect(lobby.claim("知らないチケット-0").kind).toBe("unknown");
    // 本物の記録が押し出されていない。
    expect(lobby.claim(mine.ticket).kind).toBe("dropped");
  });
});

/**
 * 決着の後始末は、持ち時間のスイープと WebSocket の処理から呼ばれる。そこから例外が漏れると
 * 走っているもの全体が止まり、**同じスイープで終わらせるはずだった別の対戦まで残る。**
 * ストアへ書けないことは本番で普通に起こる（読めない場所を渡した、いっぱいになった）。
 */
describe("決着の後始末で落ちない", () => {
  it("レーティングを保存できなくても、対戦は終わって決着は届く", () => {
    ensureCards();
    const dir = mkdtempSync(join(tmpdir(), "poke-online-"));
    const registry = new MatchRegistry(dir);
    const accounts = new AccountStore(dir);
    const hub = new MatchHub({
      registry,
      now: () => 0,
      onFinish: () => {
        throw new Error("ストアへ書けない");
      },
    });
    const lobby = new Lobby(registry, accounts, () => 0);
    const first = lobby.join(player({ lobby, registry, hub, accounts }, "a", "へや"));
    lobby.join(player({ lobby, registry, hub, accounts }, "b", "へや"));
    const seatA = first.ok ? seatOf(lobby, first.ticket) : null;

    const socket = recorder();
    hub.attach(socket, seatA?.seatToken ?? "");
    expect(() => hub.handle(socket, seatA?.seatToken ?? "", { t: "concede" })).not.toThrow();
    expect(socket.sent.at(-1)?.t).toBe("ended");
    expect(registry.live()).toHaveLength(0);
  });

  /**
   * レーティングは対局ログから作り直せる、というのが 7.2 節である。書けなかった対戦で
   * レーティングだけ動かすと、一覧にも出ない対戦のぶん差が付いて、どこから来た差か言えなくなる。
   */
  it("対局ログを書けなかった対戦では、レーティングを動かさない", () => {
    ensureCards();
    const dir = mkdtempSync(join(tmpdir(), "poke-online-"));
    // ストアそのものをファイルにして、その下へ書けないようにする。
    const blocked = join(dir, "書けない");
    writeFileSync(blocked, "");
    const registry = new MatchRegistry(blocked);
    const accounts = new AccountStore(dir);
    let applied = 0;
    const hub = new MatchHub({ registry, now: () => 0, onFinish: () => applied++ });
    const lobby = new Lobby(registry, accounts, () => 0);
    const arena = { lobby, registry, hub, accounts };
    const first = lobby.join(player(arena, "a", "へや"));
    lobby.join(player(arena, "b", "へや"));
    const seatA = first.ok ? seatOf(lobby, first.ticket) : null;

    const socket = recorder();
    hub.attach(socket, seatA?.seatToken ?? "");
    expect(() => hub.handle(socket, seatA?.seatToken ?? "", { t: "concede" })).not.toThrow();

    // 決着は届き、対戦はレジストリを離れる。それでもレーティングは動かさない。
    expect(socket.sent.at(-1)?.t).toBe("ended");
    expect(registry.live()).toHaveLength(0);
    expect(applied).toBe(0);
  });

  it("1 局の後始末で落ちても、同じスイープの別の対戦は終わる", () => {
    ensureCards();
    const dir = mkdtempSync(join(tmpdir(), "poke-online-"));
    const registry = new MatchRegistry(dir);
    const accounts = new AccountStore(dir);
    let seen = 0;
    const hub = new MatchHub({
      registry,
      // 持ち時間（60 秒 + 15 分）を越えるところまで進めて、2 局とも時間切れにする。
      now: () => 60 * 60 * 1000,
      onFinish: () => {
        seen++;
        if (seen === 1) throw new Error("ストアへ書けない");
      },
    });
    const lobby = new Lobby(registry, accounts, () => 0);
    const arena = { lobby, registry, hub, accounts };
    for (const room of ["ひとつめ", "ふたつめ"]) {
      lobby.join(player(arena, `${room}-a`, room));
      lobby.join(player(arena, `${room}-b`, room));
    }
    expect(registry.live()).toHaveLength(2);

    expect(() => hub.sweepTimeouts()).not.toThrow();
    // 1 局目で落ちても 2 局目まで進んでいる。
    expect(seen).toBe(2);
    expect(registry.live()).toHaveLength(0);
  });
});

describe("座席の接続", () => {
  it("座席トークンで局面一式を受け取る", () => {
    ensureCards();
    const arena = newArena();
    const { lobby, hub } = arena;
    const first = lobby.join(player(arena, "a", "へや"));
    const second = lobby.join(player(arena, "b", "へや"));
    const seatA = first.ok ? seatOf(lobby, first.ticket) : null;
    const seatB = second.ok && "seat" in second ? second.seat : null;

    const socket = recorder();
    expect(hub.attach(socket, seatA?.seatToken ?? "")).toBe(true);
    const sync = socket.sent[0];
    expect(sync?.t).toBe("sync");
    if (sync?.t === "sync") {
      expect(sync.seat).toBe(0);
      expect(sync.stateVersion).toBe(0);
      expect(sync.seedCommit).toHaveLength(64);
    }
    expect(seatB).not.toBeNull();
  });

  it("同じ座席に 2 本目が繋がったら古いほうを閉じる", () => {
    ensureCards();
    const arena = newArena();
    const { lobby, hub } = arena;
    const first = lobby.join(player(arena, "a", "へや"));
    lobby.join(player(arena, "b", "へや"));
    const seatA = first.ok ? seatOf(lobby, first.ticket) : null;

    const old = recorder();
    const fresh = recorder();
    hub.attach(old, seatA?.seatToken ?? "");
    hub.attach(fresh, seatA?.seatToken ?? "");
    expect(old.closed).toBe(true);
    expect(fresh.closed).toBe(false);
  });

  it("知らない座席トークンでは繋がない", () => {
    ensureCards();
    const arena = newArena();
    const { hub } = arena;
    const socket = recorder();
    expect(hub.attach(socket, "でたらめ")).toBe(false);
    expect(socket.sent[0]?.t).toBe("error");
  });

  it("投了すると両座席へ決着が届き、そこで初めて seed が出る", () => {
    ensureCards();
    const arena = newArena();
    const { lobby, hub, registry } = arena;
    const first = lobby.join(player(arena, "a", "へや"));
    const second = lobby.join(player(arena, "b", "へや"));
    const seatA = first.ok ? seatOf(lobby, first.ticket) : null;
    const seatB = second.ok && "seat" in second ? second.seat : null;

    const socketA = recorder();
    const socketB = recorder();
    hub.attach(socketA, seatA?.seatToken ?? "");
    hub.attach(socketB, seatB?.seatToken ?? "");
    // 対戦中の sync に seed は入っていない。
    expect(JSON.stringify(socketA.sent)).not.toContain('"seed"');

    hub.handle(socketA, seatA?.seatToken ?? "", { t: "concede" });
    for (const socket of [socketA, socketB]) {
      const ended = socket.sent.at(-1);
      expect(ended?.t).toBe("ended");
      if (ended?.t === "ended") {
        expect(ended.matchResult).toEqual({ kind: "concede", winner: 1, conceded: 0 });
        // 明かすのは 128 ビットぶんそのまま（6.4 節）。幅を削ると初手から総当たりで開く。
        expect(ended.seed).toMatch(/^[0-9a-f]{32}$/);
      }
    }
    // 終わった対戦はレジストリを離れる。
    expect(registry.live()).toHaveLength(0);
  });
});
