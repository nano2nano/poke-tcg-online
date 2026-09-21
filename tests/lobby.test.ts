/** 相手を見つける（`docs/spec/battle-server.md` 7 節）と、座席の接続（3.3 節）。 */

import { describe, expect, it } from "vitest";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { Lobby } from "../src/lobby.js";
import { AccountStore } from "../src/accounts.js";
import { MatchRegistry } from "../src/registry.js";
import type { ServerMessage } from "../src/protocol.js";
import { ensureCards, legalDecks } from "./helpers.js";
import { mkdtempSync } from "node:fs";
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

function newArena(): Arena {
  const dir = mkdtempSync(join(tmpdir(), "poke-online-"));
  const registry = new MatchRegistry(dir);
  const accounts = new AccountStore(dir);
  return {
    registry,
    accounts,
    lobby: new Lobby(registry, accounts, () => 0),
    hub: new MatchHub({ registry, now: () => 0 }),
  };
}

/** 待っていた側が取りに行って、座れた席を返す。座れていなければ試験を落とす。 */
function seatOf(lobby: Lobby, ticket: string) {
  const claimed = lobby.claim(ticket);
  if (claimed.kind !== "seated") throw new Error(`席が取れていない: ${claimed.kind}`);
  return claimed.seat;
}

/** 打ち手を 1 人作り、その合言葉で入る要求を組む。 */
function player(arena: Arena, name: string, roomCode?: string) {
  const deck = legalDecks()[0];
  const { secret } = arena.accounts.create(name, 0);
  return roomCode === undefined ? { secret, deck } : { secret, deck, roomCode };
}

describe("相手を見つける", () => {
  it("同じ合言葉の 2 人を繋ぐ", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const first = lobby.join(player(arena, "a", "あいことば"));
    expect(first).toEqual({ ok: true, ticket: expect.any(String) });

    const second = lobby.join(player(arena, "b", "あいことば"));
    expect(second.ok && "seat" in second && second.seat.seat).toBe(1);
    expect(first.ok ? seatOf(lobby, first.ticket).seat : null).toBe(0);
  });

  it("合言葉が違えば繋がない", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    lobby.join(player(arena, "a", "ひとつめ"));
    const second = lobby.join(player(arena, "b", "ふたつめ"));
    expect(second.ok && "seat" in second).toBe(false);
    expect(lobby.waitingCount()).toBe(2);
  });

  /**
   * 別の窓を開いたり、待っている間に読み込み直すと、同じ打ち手が 2 回入ってくる。
   * 自分と自分の対戦が 1 局として記録に残り、その打ち手に 1 勝 1 敗が付いてしまう。
   */
  it("同じ打ち手は自分と当たらない", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const deck = legalDecks()[0]!;
    const { secret } = arena.accounts.create("ふたつの窓", 0);

    const first = lobby.join({ secret, deck });
    const second = lobby.join({ secret, deck });
    // 2 回目で対戦が始まっていない。待っているのは 1 つだけである。
    expect(second.ok && "seat" in second).toBe(false);
    expect(lobby.waitingCount()).toBe(1);
    // 古いほうは降りている。**「待っている」と答えてはいけない。** 古い窓が待ち続ける。
    expect(first.ok ? lobby.claim(first.ticket).kind : null).toBe("dropped");

    // 別の人が来れば、生きているほうの窓と繋がる。
    const other = lobby.join(player(arena, "ほかのひと"));
    expect(other.ok && "seat" in other).toBe(true);
    expect(lobby.waitingCount()).toBe(0);
  });

  it("合言葉でも自分と当たらない", () => {
    ensureCards();
    const arena = newArena();
    const { lobby } = arena;
    const deck = legalDecks()[0]!;
    const { secret } = arena.accounts.create("ふたつの窓", 0);

    lobby.join({ secret, deck, roomCode: "へや" });
    const second = lobby.join({ secret, deck, roomCode: "へや" });
    expect(second.ok && "seat" in second).toBe(false);
    expect(lobby.waitingCount()).toBe(1);
  });

  it("待ち行列は先に待っていた人から繋ぐ", () => {
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

  it("検査を通らないデッキでは待ち行列に入れない", () => {
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
        expect(typeof ended.seed).toBe("number");
      }
    }
    // 終わった対戦は台帳を離れる。
    expect(registry.live()).toHaveLength(0);
  });
});
