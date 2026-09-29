import { useCallback, useRef, useState, type ReactNode } from "react";
import { ZoomContext, type ZoomTarget } from "../lib/zoom.js";
import { CardCaption, CardFace } from "./board.js";

/** 押したカードを大きく出す枠。盤面のどの画面からでも開けるよう、ルートに 1 つ置く。 */
export function CardZoom({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ZoomTarget | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // 押し始めと離したところが中と背景に分かれたクリック（文字を選ぶときなど）も、dialog そのものに届く。
  const pressedBackdrop = useRef(false);
  const releasedBackdrop = useRef(false);

  // 開くのは押したその場で行う。閉じてから close イベントが届くまでに同じカードを押すと、`target` は
  // 変わらないので、描き直しを待っていると開かない。
  const open = useCallback((next: ZoomTarget) => {
    setTarget(next);
    const shown = dialog.current;
    if (shown !== null && !shown.open) shown.showModal();
  }, []);

  return (
    <ZoomContext value={open}>
      {children}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- 背景を押して閉じるのはマウスの近道で、キーボードでは Esc で閉じる。 */}
      <dialog
        id="card-zoom"
        className="card-zoom"
        ref={dialog}
        // close イベントは閉じたあとで届く。そのあいだに開き直していたら、開いた中身を消さない。
        onClose={(event) => {
          if (!event.currentTarget.open) setTarget(null);
        }}
        // 枠の外（背景）を押しても閉じる。中身は内側の要素が覆っているので、dialog そのものに当たるのは背景だけである。
        onPointerDown={(event) => {
          pressedBackdrop.current = event.target === event.currentTarget;
        }}
        onPointerUp={(event) => {
          releasedBackdrop.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          const backdrop = pressedBackdrop.current && releasedBackdrop.current;
          if (event.target === event.currentTarget && backdrop) event.currentTarget.close();
        }}
        // 開いたキーを押し続けると、くり返しが「閉じる」を押してしまう。
        onKeyDown={(event) => {
          if (event.repeat && event.key === "Enter") event.preventDefault();
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
