import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { MotionToggle } from "./motion-setting.js";

/** 1 つしか答えの無い選択を自動で進めるかを覚えておく localStorage のキー。進めるときだけ `on` を置く。 */
const AUTO_ANSWER_KEY = "poke-auto-answer";

function storedAutoAnswer(): boolean {
  try {
    return localStorage.getItem(AUTO_ANSWER_KEY) === "on";
  } catch {
    return false;
  }
}

function storeAutoAnswer(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_ANSWER_KEY, "on");
    else localStorage.removeItem(AUTO_ANSWER_KEY);
  } catch {
    // 覚えておけなくても、切り替えはそのページのあいだ効く。
  }
}

const SettingsContext = createContext<{ open: () => void; autoAnswer: boolean }>({
  open: () => {},
  autoAnswer: false,
});

/** 答えが 1 つしか無い選択を、押さずに進めるか。 */
export function useAutoAnswer(): boolean {
  return use(SettingsContext).autoAnswer;
}

/** 設定のダイアログ。どの画面の「設定」からも同じものを開くよう、ルートに 1 つ置く。 */
export function Settings({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [autoAnswer, setAutoAnswer] = useState(storedAutoAnswer);
  const open = useCallback(() => dialog.current?.showModal(), []);
  const value = useMemo(() => ({ open, autoAnswer }), [open, autoAnswer]);
  return (
    <SettingsContext value={value}>
      {children}
      <dialog id="settings" className="settings" ref={dialog} aria-labelledby="settings-title">
        <h2 id="settings-title">設定</h2>
        <MotionToggle />
        <label className="setting">
          <input
            id="auto-answer-toggle"
            type="checkbox"
            checked={autoAnswer}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              setAutoAnswer(on);
              storeAutoAnswer(on);
            }}
          />
          答えが 1 つしか無い選択は、押さずに進める
        </label>
        <p className="note">
          {"選べるカードが無いときの「選ばない」や、ほかに出せるポケモンがいないときのバトル場へ出すポケモンなど。" +
            "自分の番を終えるのと、山札や相手の手札を見ているときは自動で進めません。" +
            "すぐに進むので、ほかに選べるものが無かったことが相手に伝わることがあります。"}
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
