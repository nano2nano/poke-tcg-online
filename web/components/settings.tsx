import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { MotionToggle } from "./motion-setting.js";

/** 右クリックで手をすぐ指すかを覚えておく localStorage のキー。既定は指すので、指さないときだけ `off` を置く。 */
const DIRECT_PLAY_KEY = "poke-direct-play";

function storedDirectPlay(): boolean {
  try {
    return localStorage.getItem(DIRECT_PLAY_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeDirectPlay(on: boolean): void {
  try {
    if (on) localStorage.removeItem(DIRECT_PLAY_KEY);
    else localStorage.setItem(DIRECT_PLAY_KEY, "off");
  } catch {
    // 覚えておけなくても、切り替えはそのページのあいだ効く。
  }
}

const SettingsContext = createContext<{ open: () => void; directPlay: boolean }>({
  open: () => {},
  directPlay: true,
});

/** 右クリックした手札のカードでできる手が 1 つだけなら、メニューを出さずにすぐ指すか。 */
export function useDirectPlay(): boolean {
  return use(SettingsContext).directPlay;
}

/** 設定のダイアログ。どの画面の「設定」からも同じものを開くよう、ルートに 1 つ置く。 */
export function Settings({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [directPlay, setDirectPlay] = useState(storedDirectPlay);
  const open = useCallback(() => dialog.current?.showModal(), []);
  const value = useMemo(() => ({ open, directPlay }), [open, directPlay]);
  return (
    <SettingsContext value={value}>
      {children}
      <dialog id="settings" className="settings" ref={dialog} aria-labelledby="settings-title">
        <h2 id="settings-title">設定</h2>
        <MotionToggle />
        <label className="setting">
          <input
            id="direct-play-toggle"
            type="checkbox"
            checked={directPlay}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              setDirectPlay(on);
              storeDirectPlay(on);
            }}
          />
          手札のカードでできる手が 1 つだけなら、右クリックですぐ使う
        </label>
        <p className="note">
          {"対象を取らないサポートやグッズなどを、メニューを出さずに使います。" +
            "場のポケモンと、キーボードで開いたときは、いつもメニューを出します。"}
        </p>
        <form method="dialog">
          <button id="settings-close" className="secondary">
            閉じる
          </button>
        </form>
      </dialog>
    </SettingsContext>
  );
}

/** 設定のダイアログを開くボタン。画面ごとに置くので、`id` は呼ぶ側が決める。 */
export function SettingsButton({ id }: { id: string }) {
  const { open } = use(SettingsContext);
  return (
    <button id={id} type="button" className="secondary" onClick={open}>
      設定
    </button>
  );
}
