import { MotionConfig, useReducedMotion } from "motion/react";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { MOVE_SECONDS } from "../lib/motion.js";

/** 画面で演出を切ったことを覚えておく localStorage のキー。 */
const MOTION_KEY = "poke-motion";

/** localStorage が使えないブラウザでも、演出を出して開き、切り替えはそのページのあいだ効かせる。 */
function storedAnimate(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeAnimate(animate: boolean): void {
  try {
    if (animate) localStorage.removeItem(MOTION_KEY);
    else localStorage.setItem(MOTION_KEY, "off");
  } catch {
    // 覚えておけなくても、切り替えはそのページのあいだ効く。
  }
}

const MotionSetting = createContext<{ animate: boolean; setAnimate: (animate: boolean) => void }>({
  animate: true,
  setAnimate: () => {},
});

/** 演出を出すか。画面の設定で切ったときだけ false になる。OS の設定は `MotionConfig` と CSS が見る。 */
export function useAnimate(): boolean {
  return use(MotionSetting).animate;
}

/** カードや結果を動かして見せるか。画面の設定で切ったときと、OS で動きを減らす設定にしているときは動かさない。 */
export function useMotionOn(): boolean {
  const reduced = useReducedMotion() === true;
  return useAnimate() && !reduced;
}

export function MotionSettingProvider({ children }: { children: ReactNode }) {
  const [animate, setAnimateState] = useState(storedAnimate);
  const setting = useMemo(
    () => ({
      animate,
      setAnimate: (next: boolean) => {
        setAnimateState(next);
        storeAnimate(next);
      },
    }),
    [animate],
  );
  // 結果の枠やコインの CSS のアニメーションも止める。
  useEffect(() => {
    document.documentElement.toggleAttribute("data-no-motion", !animate);
  }, [animate]);
  return (
    <MotionSetting value={setting}>
      {/* 演出を切った人と、OS で動きを減らす設定にしている人には、カードを動かさずに置き換える。 */}
      <MotionConfig
        reducedMotion={animate ? "user" : "always"}
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
