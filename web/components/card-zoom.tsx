import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ZoomContext, type ZoomTarget } from "../lib/zoom.js";
import { CardCaption, CardFace } from "./board.js";

/** 押したカードを大きく出す枠。盤面のどの画面からでも開けるよう、ルートに 1 つ置く。 */
export function CardZoom({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ZoomTarget | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const shown = dialog.current;
    if (target !== null && shown !== null && !shown.open) shown.showModal();
  }, [target]);

  return (
    <ZoomContext value={setTarget}>
      {children}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- 背景を押して閉じるのはマウスの近道で、キーボードでは Esc で閉じる。 */}
      <dialog
        id="card-zoom"
        className="card-zoom"
        ref={dialog}
        onClose={() => setTarget(null)}
        // 枠の外（背景）を押しても閉じる。中身は内側の要素が覆っているので、dialog そのものに当たるのは背景だけである。
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="card-zoom-body">
          <h2 id="card-zoom-title">{target?.title}</h2>
          <div id="card-zoom-cards" className="card-zoom-cards">
            {target?.defIds.map((defId, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- 同じカードが何枚も並ぶので、位置のほかに見分けがない。
              <figure key={index}>
                <CardFace defId={defId} />
                <figcaption>
                  <CardCaption defId={defId} />
                </figcaption>
              </figure>
            ))}
          </div>
          <form method="dialog">
            <button id="card-zoom-close" className="secondary">
              閉じる
            </button>
          </form>
        </div>
      </dialog>
    </ZoomContext>
  );
}
