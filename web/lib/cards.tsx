/**
 * `defId` から名前や画像を引く表と、カードの画像を出すかの設定。
 *
 * どちらも対戦ごとに変わらないので、ページを開いているあいだは 1 度取ったものを使い続ける。
 * 盤面はこれを待たずに描き始め、届いたら名前と画像で描き直す。対戦の時計は、取りに行っているあいだも流れる。
 */

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CardBrief } from "../../src/card-index.js";

export type { CardBrief };
export type CardTable = Readonly<Record<string, CardBrief>>;

export interface CardData {
  table: CardTable;
  /**
   * 公式のカード画像を出すか。出すかどうかはサーバの設定で決まる（仕様 3.7 節）。
   * 取れなければ出さない。カードは画像が無くても、名前と種類の面で描ける。
   */
  images: boolean;
}

const EMPTY: CardData = { table: {}, images: false };
const CardDataContext = createContext<CardData>(EMPTY);

/** 盤面のカードは 1 枚ずつこの値を読む。取りに行くのはここの 1 か所だけにする。 */
export function CardDataProvider({ children }: { children: ReactNode }) {
  const table = useTableQuery();
  const images = useImagesQuery();
  const data = useMemo(() => ({ table, images }), [table, images]);
  return <CardDataContext value={data}>{children}</CardDataContext>;
}

export function useCardData(): CardData {
  return useContext(CardDataContext);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} が ${response.status} を返した`);
  return (await response.json()) as T;
}

/** 取れるまで間を空けて取り直す。取れないと、盤面にカードの名前が出ない。 */
function useTableQuery(): CardTable {
  const { data } = useQuery({
    queryKey: ["cards"],
    queryFn: () => getJson<CardTable>("/api/cards"),
    staleTime: Infinity,
    retry: true,
    retryDelay: (attempt) => Math.min(5_000 * 2 ** attempt, 60_000),
  });
  return data ?? EMPTY.table;
}

function useImagesQuery(): boolean {
  const { data } = useQuery({
    queryKey: ["config"],
    queryFn: () => getJson<{ cardImages?: unknown }>("/api/config"),
    staleTime: Infinity,
    retry: false,
  });
  return data?.cardImages === true;
}
