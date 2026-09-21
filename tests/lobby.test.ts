/** 相手を見つける（`docs/spec/battle-server.md` 7 節）と、座席の接続（3.3 節）。 */

import { describe, expect, it } from "vitest";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { Lobby } from "../src/lobby.js";
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

function newArena(): { lobby: Lobby; registry: MatchRegistry; hub: MatchHub } {
  const registry = new MatchRegistry(mkdtempSync(join(tmpdir(), "poke-online-")));
  return {
    registry,
    lobby: new Lobby(registry, () => 0),
    hub: new MatchHub({ registry, now: () => 0 }),
  };
}

function player(name: string, roomCode?: string) {
  const deck = legalDecks()[0];
  return roomCode === undefined
    ? { playerId: name, displayName: name, deck }
    : { playerId: name, displayName: name, deck, roomCode };
}

describe("相手を見つける", () => {
  it("同じ合言葉の 2 人を繋ぐ", () => {
    ensureCards();
    const { lobby } = newArena();
    const first = lobby.join(player("a", "あいことば"));
    expect(first).toEqual({ ok: true, ticket: expect.any(String) });

    const second = lobby.join(player("b", "あいことば"));
    expect(second.ok && "seat" in second && second.seat.seat).toBe(1);
    const claimed = first.ok ? lobby.claim(first.ticket) : null;
    expect(claimed?.seat).toBe(0);
  });

  it("合言葉が違えば繋がない", () => {
    ensureCards();
    const { lobby } = newArena();
    lobby.join(player("a", "ひとつめ"));
    const second = lobby.join(player("b", "ふたつめ"));
    expect(second.ok && "seat" in second).toBe(false);
    expect(lobby.waitingCount()).toBe(2);
  });

  it("待ち行列は先に待っていた人から繋ぐ", () => {
    ensureCards();
    const { lobby } = newArena();
    const first = lobby.join(player("a"));
    lobby.join(player("b"));
    const third = lobby.join(player("c"));
    // a と b が繋がり、c だけが残る。
    expect(first.ok ? lobby.claim(first.ticket) : null).not.toBeNull();
    expect(third.ok && "seat" in third).toBe(false);
    expect(lobby.waitingCount()).toBe(1);
  });

  it("検査を通らないデッキでは待ち行列に入れない", () => {
    ensureCards();
    const { lobby } = newArena();
    const outcome = lobby.join({ playerId: "a", displayName: "a", deck: { cards: [] } });
    expect(outcome.ok).toBe(false);
    expect(lobby.waitingCount()).toBe(0);
  });
});

describe("座席の接続", () => {
  it("座席トークンで局面一式を受け取る", () => {
    ensureCards();
    const { lobby, hub } = newArena();
    const first = lobby.join(player("a", "へや"));
    const second = lobby.join(player("b", "へや"));
    const seatA = first.ok ? lobby.claim(first.ticket) : null;
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
    const { lobby, hub } = newArena();
    const first = lobby.join(player("a", "へや"));
    lobby.join(player("b", "へや"));
    const seatA = first.ok ? lobby.claim(first.ticket) : null;

    const old = recorder();
    const fresh = recorder();
    hub.attach(old, seatA?.seatToken ?? "");
    hub.attach(fresh, seatA?.seatToken ?? "");
    expect(old.closed).toBe(true);
    expect(fresh.closed).toBe(false);
  });

  it("知らない座席トークンでは繋がない", () => {
    ensureCards();
    const { hub } = newArena();
    const socket = recorder();
    expect(hub.attach(socket, "でたらめ")).toBe(false);
    expect(socket.sent[0]?.t).toBe("error");
  });

  it("投了すると両座席へ決着が届き、そこで初めて seed が出る", () => {
    ensureCards();
    const { lobby, hub, registry } = newArena();
    const first = lobby.join(player("a", "へや"));
    const second = lobby.join(player("b", "へや"));
    const seatA = first.ok ? lobby.claim(first.ticket) : null;
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
