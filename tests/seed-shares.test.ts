/**
 * 座席のシェアをシャッフルへ混ぜる（`docs/spec/battle-server.md` 6.4 節）。
 *
 * サーバだけが `nonce` を引く形では、対戦の前に引き直して並びを選べる。座席が
 * シェアのコミットを先に送り、サーバのコミットを受け取ってからシェアを開けば、
 * サーバは並びを決める値の一部を知らないまま `nonce` に縛られる。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "../src/accounts.js";
import { commitSeed, commitShare, type SeedShares } from "../src/fingerprint.js";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { Lobby, type Seated } from "../src/lobby.js";
import type { MatchRecord } from "../src/log.js";
import { SHARE_REVEAL_DEADLINE_MS, type PendingMatch } from "../src/pending.js";
import type { ServerMessage } from "../src/protocol.js";
import { MatchRegistry } from "../src/registry.js";
import { seedCommitmentHolds } from "../src/replay.js";
import { joinRequestSchema } from "../src/requests.js";
import { ensureCards, legalDecks } from "./helpers.js";

const SHARE_A = "a".repeat(64);
const SHARE_B = "b".repeat(64);

describe("シェアを混ぜた seed", () => {
  it("シェアが無ければ、シェアを混ぜる前と同じ seed になる", () => {
    expect(commitSeed("n", [null, null])).toEqual(commitSeed("n"));
  });

  it("シェアは seed だけを動かし、座席の位置も区別する", () => {
    const none = commitSeed("n");
    const first = commitSeed("n", [SHARE_A, null]);
    const second = commitSeed("n", [null, SHARE_A]);
    expect(new Set([none.seed, first.seed, second.seed]).size).toBe(3);
    // コミットはシェアを開く前に配るので、シェアに依ってはいけない。
    expect(first.commit).toBe(none.commit);
  });

  it("参加の要求は、シェアのコミットを 16 進 64 桁でだけ受ける", () => {
    const body = { secret: "s", deck: { cards: [] } };
    expect(joinRequestSchema.safeParse({ ...body, seedShareCommit: "x" }).success).toBe(false);
    expect(joinRequestSchema.parse({ ...body, seedShareCommit: commitShare(SHARE_A) })).toEqual({
      ...body,
      seedShareCommit: commitShare(SHARE_A),
    });
  });
});

interface Arena {
  lobby: Lobby;
  registry: MatchRegistry;
  hub: MatchHub;
  accounts: AccountStore;
  clock: { now: number };
  finished: MatchRecord[];
}

function newArena(): Arena {
  const dir = mkdtempSync(join(tmpdir(), "poke-online-shares-"));
  const registry = new MatchRegistry(dir);
  const accounts = new AccountStore(dir);
  const clock = { now: 0 };
  const finished: MatchRecord[] = [];
  const lobby = new Lobby(registry, accounts, () => clock.now);
  const hub = new MatchHub({
    registry,
    now: () => clock.now,
    onFinish: (record) => finished.push(record),
  });
  return { lobby, registry, hub, accounts, clock, finished };
}

/**
 * 2 人を同じルームコードで入れ、両方の席を返す。シェアのコミットは渡されたものだけ送る。
 * 先に待っていた側は対戦が始まる前に引き換えるので、始まる前の席も引き換えられることをここで通す。
 */
function seatBoth(arena: Arena, commits: SeedShares): [Seated, Seated] {
  ensureCards();
  const request = (name: string, commit: string | null) => ({
    secret: arena.accounts.create(name, 0).secret,
    deck: legalDecks()[0],
    roomCode: "へや",
    ...(commit === null ? {} : { seedShareCommit: commit }),
  });
  const first = arena.lobby.join(request("a", commits[0]));
  const second = arena.lobby.join(request("b", commits[1]));
  if (!first.ok || !second.ok || !("seat" in second)) throw new Error("席が決まっていない");
  const claimed = arena.lobby.claim(first.ticket);
  if (claimed.kind !== "seated") throw new Error(`席が取れていない: ${claimed.kind}`);
  return [claimed.seat, second.seat];
}

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

function matchOf(arena: Arena, seated: Seated) {
  const ref = arena.registry.bySeatToken(seated.seatToken);
  if (ref === undefined) throw new Error("対戦が始まっていない");
  return ref.match;
}

describe("シェアの開示", () => {
  it("両座席が開くまで対戦を始めず、そろったら両方へ局面を送る", () => {
    const arena = newArena();
    const [a, b] = seatBoth(arena, [commitShare(SHARE_A), commitShare(SHARE_B)]);
    // 席を知らせる時点で、両方のコミットが両座席に届いている。
    expect(a.seedShareCommits).toEqual([commitShare(SHARE_A), commitShare(SHARE_B)]);
    expect(b.seedCommit).toBe(a.seedCommit);

    const socketA = recorder();
    expect(arena.hub.attach(socketA, a.seatToken, SHARE_A)).toBe(true);
    expect(socketA.sent.map((message) => message.t)).toEqual(["pending"]);
    expect(arena.registry.live()).toHaveLength(0);

    const socketB = recorder();
    arena.hub.attach(socketB, b.seatToken, SHARE_B);
    expect(socketA.sent.map((message) => message.t)).toEqual(["pending", "sync"]);
    expect(socketB.sent.map((message) => message.t)).toEqual(["pending", "sync"]);

    const match = matchOf(arena, a);
    expect(match.seedCommitment.commit).toBe(a.seedCommit);
    expect(match.seedCommitment.seed).toBe(
      commitSeed(match.seedCommitment.nonce, [SHARE_A, SHARE_B]).seed,
    );
  });

  it("コミットと合わないシェアは受け取らず、繋ぎ直して正しい値を開けば始まる", () => {
    const arena = newArena();
    const [a, b] = seatBoth(arena, [commitShare(SHARE_A), null]);
    const wrong = recorder();
    arena.hub.attach(wrong, a.seatToken, SHARE_B);
    expect(wrong.sent.map((message) => message.t)).toEqual(["pending", "error"]);
    expect(arena.registry.live()).toHaveLength(0);

    arena.hub.attach(recorder(), a.seatToken, SHARE_A);
    expect(matchOf(arena, b).seedCommitment.shares).toEqual([SHARE_A, null]);
  });

  it("期限までに開かなかった座席のシェアは null のまま始め、時計はそこから流れる", () => {
    const arena = newArena();
    const [a] = seatBoth(arena, [commitShare(SHARE_A), commitShare(SHARE_B)]);
    const socketA = recorder();
    arena.hub.attach(socketA, a.seatToken, SHARE_A);

    arena.clock.now = SHARE_REVEAL_DEADLINE_MS - 1;
    arena.hub.sweepTimeouts();
    expect(arena.registry.live()).toHaveLength(0);

    arena.clock.now = SHARE_REVEAL_DEADLINE_MS;
    arena.hub.sweepTimeouts();
    expect(socketA.sent.map((message) => message.t)).toEqual(["pending", "sync"]);
    const match = matchOf(arena, a);
    expect(match.seedCommitment.shares).toEqual([SHARE_A, null]);
    expect(match.turnStartedAtMs).toBe(SHARE_REVEAL_DEADLINE_MS);
    // 記録のレーティングは席が決まった時点で読んだので、`startedAt` もその時点にそろえる。
    expect(match.startedAt).toBe(new Date(0).toISOString());
  });

  /**
   * 始まる前の座席にも答える。「座席が見つからない」と返すと、仕様どおりに `hello` や `ping` を
   * 送るクライアントは、取れている席を失ったと読む。
   */
  it("始まる前の座席には、生存確認とまだ始まっていないことだけを答える", () => {
    const arena = newArena();
    const [a] = seatBoth(arena, [commitShare(SHARE_A), commitShare(SHARE_B)]);
    const socket = recorder();
    arena.hub.attach(socket, a.seatToken, SHARE_A);
    arena.hub.handle(socket, a.seatToken, { t: "ping" });
    arena.hub.handle(socket, a.seatToken, { t: "hello" });
    arena.hub.handle(socket, a.seatToken, { t: "concede" });
    expect(socket.sent.map((message) => message.t)).toEqual([
      "pending",
      "pong",
      "pending",
      "error",
    ]);
    expect(arena.registry.live()).toHaveLength(0);
  });

  /**
   * 始める処理は WebSocket の `connection` の中からも走る。投げればプロセスごと落ち、
   * 残せば次のスイープでも同じ形で失敗して、両座席は始まらない対戦を待ち続ける。
   */
  it("始められなかった対戦は捨て、座席へ知らせて閉じる", () => {
    ensureCards();
    const arena = newArena();
    const pending: PendingMatch = {
      matchId: "broken",
      // 空のデッキでは初手を引けず、エンジンが投げる。
      decks: [{ cards: [] }, { cards: [] }],
      seats: [
        { playerId: "p0", displayName: "a", rating: 1500 },
        { playerId: "p1", displayName: "b", rating: 1500 },
      ],
      seatTokens: ["broken-0", "broken-1"],
      spectatorToken: "broken-watch",
      startedAt: new Date(0).toISOString(),
      server: commitSeed("n"),
      shareCommits: [commitShare(SHARE_A), null],
      shares: [null, null],
      deadlineMs: SHARE_REVEAL_DEADLINE_MS,
    };
    arena.registry.addPending(pending);
    const socket = recorder();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => arena.hub.attach(socket, "broken-0", SHARE_A)).not.toThrow();
    errors.mockRestore();
    expect(socket.sent.map((message) => message.t)).toEqual(["pending", "error"]);
    expect(socket.closed).toBe(true);
    expect(arena.registry.holdsSeat("broken-0")).toBe(false);
  });

  it("決着でシェアを明かし、記録からシェアとコミットを検算できる", () => {
    const arena = newArena();
    const [a, b] = seatBoth(arena, [commitShare(SHARE_A), commitShare(SHARE_B)]);
    const socketA = recorder();
    arena.hub.attach(socketA, a.seatToken, SHARE_A);
    arena.hub.attach(recorder(), b.seatToken, SHARE_B);
    arena.hub.handle(socketA, a.seatToken, { t: "concede" });

    const ended = socketA.sent.at(-1);
    expect(ended?.t === "ended" && ended.seedShares).toEqual([SHARE_A, SHARE_B]);
    const [record] = arena.finished;
    expect(record?.seedShares).toEqual([SHARE_A, SHARE_B]);
    expect(record && seedCommitmentHolds(record)).toBe(true);
  });
});

describe("記録の検算", () => {
  function recordWith(shares: SeedShares, commits: SeedShares): MatchRecord {
    const commitment = commitSeed("n", shares);
    return {
      seed: commitment.seed,
      seedNonce: "n",
      seedCommit: commitment.commit,
      seedShares: shares,
      seedShareCommits: commits,
    } as MatchRecord;
  }

  it("開かなかった座席は、コミットだけあってシェアが null でも通る", () => {
    const record = recordWith([SHARE_A, null], [commitShare(SHARE_A), commitShare(SHARE_B)]);
    expect(seedCommitmentHolds(record)).toBe(true);
  });

  /**
   * seed を導き直すだけでは足りない。サーバがシェアを差し替えて並びを選び、差し替えた
   * 値で seed を作り直せば、記録の中の辻褄は合ってしまう。
   */
  it("コミットと合わないシェアで作り直した記録は断る", () => {
    const record = recordWith([SHARE_B, null], [commitShare(SHARE_A), null]);
    expect(seedCommitmentHolds(record)).toBe(false);
  });

  it("コミットの無い座席にシェアがある記録は断る", () => {
    const record = recordWith([SHARE_A, null], [null, null]);
    expect(seedCommitmentHolds(record)).toBe(false);
  });
});
