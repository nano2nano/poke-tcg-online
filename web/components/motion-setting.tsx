import { MotionConfig } from "motion/react";
import {
  createContext,
  use,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MOVE_SECONDS } from "../lib/motion.js";

/** 画面で OS の設定と違うほうを選んだことを覚えておく localStorage のキー。値は `on` か `off`。 */
const MOTION_KEY = "poke-motion";

/** 画面で選んでいなければ null。localStorage が使えないブラウザでも、切り替えはそのページのあいだ効かせる。 */
function storedAnimate(): boolean | null {
  try {
    const stored = localStorage.getItem(MOTION_KEY);
    return stored === "on" ? true : stored === "off" ? false : null;
  } catch {
    return null;
  }
}

function storeAnimate(animate: boolean | null): void {
  try {
    if (animate === null) localStorage.removeItem(MOTION_KEY);
    else localStorage.setItem(MOTION_KEY, animate ? "on" : "off");
  } catch {
    // 覚えておけなくても、切り替えはそのページのあいだ効く。
  }
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** 開いているあいだに OS の設定を変えても追う。Motion の `useReducedMotion` は最初の値のままになる。 */
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const MotionSetting = createContext<{ animate: boolean; setAnimate: (animate: boolean) => void }>({
  animate: true,
  setAnimate: () => {},
});

/** カードや結果を動かして見せるか。 */
export function useMotionOn(): boolean {
  return use(MotionSetting).animate;
}

/**
 * 画面で選んでいなければ、OS で動きを減らす設定にしている人には演出を出さない。
 * 画面で選んだほうを OS の設定より先にする。OS の設定で止めるだけだと、切り替えに印が付いたまま何も動かず、
 * 画面から演出を出す手段が無い。OS の設定と同じほうを選び直したら、また OS の設定に従う。
 */
export function MotionSettingProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState(storedAnimate);
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => matchMedia(REDUCED_MOTION).matches,
  );
  const animate = chosen ?? !reduced;
  const setting = useMemo(
    () => ({
      animate,
      setAnimate: (next: boolean) => {
        const choice = next === !reduced ? null : next;
        setChosen(choice);
        storeAnimate(choice);
      },
    }),
    [animate, reduced],
  );
  // 結果の枠やコインの CSS のアニメーションも止める。最初の描画から効かせる。
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-no-motion", !animate);
  }, [animate]);
  return (
    <MotionSetting value={setting}>
      <MotionConfig
        reducedMotion={animate ? "never" : "always"}
        transition={{ duration: MOVE_SECONDS, ease: "easeOut" }}
      >
        {children}
      </MotionConfig>
    </MotionSetting>
  );
}

/** 演出を出すかの切り替え。卓ごとに置くので、`id` は呼ぶ側が決める。 */
export function MotionToggle({ id }: { id: string }) {
  const { animate, setAnimate } = use(MotionSetting);
  return (
    <label className="motion-toggle">
      <input
        id={id}
        type="checkbox"
        checked={animate}
        onChange={(event) => setAnimate(event.currentTarget.checked)}
      />
      演出を出す
    </label>
  );
}
