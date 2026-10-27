import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  getRescue,
  getRescueItems,
  saveRescueItem,
  setRescue,
  setRescueItems,
  subscribeRescue,
  unsavedRescueItems,
  type RescueItem,
} from "./rescue";
import { CancelClose, CloseWithSession, HoldClose } from "../wailsjs/go/main/App";
import { EventsOn } from "../wailsjs/runtime";

// Keeps a rendering error inside the part of the screen that hit it. Without
// a boundary React unmounts the whole tree on any render error — in v1.2.0 an
// empty folder in a log bundle blanked the entire window (toolbar, tabs and
// all). Inside the App, tabs, unsaved text and the session live above the
// boundary, so they are untouched and 「다시 시도」 just draws the part again.
// The top-level boundary (main.tsx, `top`) is different: the App itself is
// gone. It saved the session from the editors as it went (rescue.ts), and
// 「다시 시도」 starts it again from that session — the message says which.
// Edited tabs the session did not get (big tabs: only their path is kept) are
// listed with 「파일로 저장」, and 「다시 시도」 / closing the window ask first.
interface Props {
  what: string; // which part, in the message: "로그 묶음 트리", "3번 칸" …
  resetKey?: unknown; // a change (another file, another bundle) clears the error
  top?: boolean;
  children: ReactNode;
}
interface State {
  error: unknown;
}

// Sizes without toLocaleString: the error being shown may be a broken
// formatter (the headless test breaks Number.prototype.toLocaleString).
function sizeOf(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + "MB";
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + "KB";
  return n + "자";
}

function names(list: RescueItem[]): string {
  const shown = list.slice(0, 5).map((i) => i.name);
  return shown.join(", ") + (list.length > 5 ? ` 외 ${list.length - 5}개` : "");
}

// The edited tabs the error screen lists: the ones the session did not get.
function listed(): RescueItem[] {
  const st = getRescue();
  if (st === "saving" || st === "") return [];
  return getRescueItems().filter((i) => !(st === "saved" && i.inSession));
}

function rescueText(): string {
  const all = listed();
  const open = all.filter((i) => i.state !== "saved");
  // what to say about the listed tabs: still to save, or all saved now
  const what = (kind: string) =>
    open.length
      ? `${kind} ${all.length}개(${names(all)})는 저장되지 않았습니다 — 아래 「파일로 저장」으로 오류가 난 순간의 내용을 파일에 쓰세요. 저장하지 않고 「↻ 다시 시도」하거나 창을 닫으면 그 내용은 사라집니다.`
      : `${kind} ${all.length}개(${names(all)})는 파일로 저장했습니다.`;
  switch (getRescue()) {
    case "saving":
      return "오류가 난 순간의 열린 탭과 고친 내용을 세션에 저장하는 중입니다…";
    case "saved":
      if (all.length)
        return (
          (getRescueItems().some((i) => i.inSession)
            ? "열린 탭과 작은 탭의 고친 내용은 세션에 저장했습니다. "
            : "열린 탭 목록은 세션에 저장했습니다. ") +
          "세션에 담기지 않는 " +
          what("큰 탭") +
          (open.length ? "" : " 「↻ 다시 시도」를 누르면 그 상태로 다시 엽니다.")
        );
      return "오류가 난 순간의 열린 탭과 고친 내용을 세션에 저장했습니다. 「↻ 다시 시도」를 누르면 그 상태로 다시 엽니다.";
    case "failed":
      return (
        "오류가 난 순간의 내용을 세션에 저장하지 못했습니다. 「↻ 다시 시도」를 누르면 마지막 자동 저장 상태로 다시 엽니다 — 그 뒤에 고친 내용은 없을 수 있습니다." +
        (all.length ? "\n" + what("고친 탭") : "")
      );
    default:
      if (all.length) return "이번 실행은 세션을 저장하지 않습니다(안내 막대 참고). " + what("고친 탭");
      return "세션은 건드리지 않았습니다. 「↻ 다시 시도」를 누르면 마지막 자동 저장 상태로 다시 엽니다.";
  }
}

const lostText = (lost: RescueItem[]) => lost.map((i) => `- ${i.name} (${sizeOf(i.size)})`).join("\n");

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private unsub: (() => void) | null = null;
  private offClose: (() => void) | null = null;

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error("알 수 없는 오류") };
  }

  componentDidMount() {
    if (this.props.top) this.unsub = subscribeRescue(() => this.forceUpdate());
  }

  componentWillUnmount() {
    this.unsub?.();
    this.stopCloseWatch();
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[${this.props.what}] 그리기 오류`, error, info.componentStack);
    // The App's own close handler went with it: answer Go's close here, and
    // ask first when edits would be lost (as the App does for big tabs).
    if (this.props.top && !this.offClose) {
      this.offClose = EventsOn("chipper:flush-before-close", async () => {
        const lost = unsavedRescueItems();
        if (lost.length) {
          await HoldClose().catch(() => {});
          const ok = window.confirm(
            "저장하지 않은 고친 내용이 있습니다:\n" +
              lostText(lost) +
              "\n지금 닫으면 이 내용은 사라집니다.\n\n[확인] 그래도 닫기   [취소] 돌아가서 「파일로 저장」하기"
          );
          if (!ok) {
            CancelClose().catch(() => {});
            return;
          }
        }
        // "" = keep what Go has: the session the App saved as it went down.
        CloseWithSession("").catch(() => {});
      });
    }
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private stopCloseWatch() {
    this.offClose?.();
    this.offClose = null;
  }

  private retry = () => {
    if (this.props.top) {
      const lost = unsavedRescueItems();
      if (
        lost.length &&
        !window.confirm(
          "저장하지 않은 고친 내용이 있습니다:\n" +
            lostText(lost) +
            "\n「다시 시도」하면 이 내용은 사라집니다(파일은 마지막으로 저장된 내용으로 다시 열립니다).\n\n[확인] 다시 시도   [취소] 돌아가서 「파일로 저장」하기"
        )
      )
        return;
      this.stopCloseWatch();
      setRescueItems([]);
      setRescue("");
    }
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const msg = error instanceof Error ? error.message : String(error);
    const top = this.props.top;
    const saving = top && (getRescue() === "saving" || getRescueItems().some((i) => i.state === "saving"));
    const rows = top ? listed() : [];
    return (
      <div className="render-error" role="alert">
        <div className="render-error-title">이 부분({this.props.what})을 그리다 오류가 났습니다</div>
        <div className="render-error-msg">{msg}</div>
        <div className="render-error-sub">
          {top ? rescueText() : "열린 탭과 저장하지 않은 내용은 그대로 있습니다."}
        </div>
        {rows.length > 0 && (
          <div className="render-error-items">
            {rows.map((i) => (
              <div key={i.id} className="render-error-item">
                <span className="rei-name" title={i.path || "저장한 적 없는 탭"}>
                  {i.name} ({sizeOf(i.size)})
                </span>
                {i.state === "saved" ? (
                  <span className="rei-done">✔ 저장함</span>
                ) : i.state === "saving" ? (
                  <span className="rei-busy">저장하는 중…</span>
                ) : (
                  <>
                    {i.state === "failed" && <span className="rei-fail">저장하지 못했습니다: {i.error}</span>}
                    <button
                      className="tb-btn"
                      title={i.path ? `${i.path} 에 오류가 난 순간의 내용을 씁니다` : "저장할 위치를 고릅니다"}
                      onClick={() => void saveRescueItem(i.id)}
                    >
                      💾 파일로 저장
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <button className="tb-btn" disabled={saving} onClick={this.retry}>
          ↻ 다시 시도
        </button>
      </div>
    );
  }
}
