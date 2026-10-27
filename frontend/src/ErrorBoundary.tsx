import { Component, type ErrorInfo, type ReactNode } from "react";
import { getRescue, setRescue, subscribeRescue } from "./rescue";

// Keeps a rendering error inside the part of the screen that hit it. Without
// a boundary React unmounts the whole tree on any render error — in v1.2.0 an
// empty folder in a log bundle blanked the entire window (toolbar, tabs and
// all). Inside the App, tabs, unsaved text and the session live above the
// boundary, so they are untouched and 「다시 시도」 just draws the part again.
// The top-level boundary (main.tsx, `top`) is different: the App itself is
// gone. It saved the session from the editors as it went (rescue.ts), and
// 「다시 시도」 starts it again from that session — the message says which.
interface Props {
  what: string; // which part, in the message: "로그 묶음 트리", "3번 칸" …
  resetKey?: unknown; // a change (another file, another bundle) clears the error
  top?: boolean;
  children: ReactNode;
}
interface State {
  error: unknown;
}

function rescueText(): string {
  switch (getRescue()) {
    case "saving":
      return "오류가 난 순간의 열린 탭과 고친 내용을 세션에 저장하는 중입니다…";
    case "saved":
      return "오류가 난 순간의 열린 탭과 고친 내용을 세션에 저장했습니다. 「↻ 다시 시도」를 누르면 그 상태로 다시 엽니다.";
    case "failed":
      return "오류가 난 순간의 내용을 세션에 저장하지 못했습니다. 「↻ 다시 시도」를 누르면 마지막 자동 저장 상태로 다시 엽니다 — 그 뒤에 고친 내용은 없을 수 있습니다.";
    default:
      return "세션은 건드리지 않았습니다. 「↻ 다시 시도」를 누르면 마지막 자동 저장 상태로 다시 엽니다.";
  }
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private unsub: (() => void) | null = null;

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error("알 수 없는 오류") };
  }

  componentDidMount() {
    if (this.props.top) this.unsub = subscribeRescue(() => this.forceUpdate());
  }

  componentWillUnmount() {
    this.unsub?.();
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[${this.props.what}] 그리기 오류`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const msg = error instanceof Error ? error.message : String(error);
    const saving = this.props.top && getRescue() === "saving";
    return (
      <div className="render-error" role="alert">
        <div className="render-error-title">이 부분({this.props.what})을 그리다 오류가 났습니다</div>
        <div className="render-error-msg">{msg}</div>
        <div className="render-error-sub">
          {this.props.top ? rescueText() : "열린 탭과 저장하지 않은 내용은 그대로 있습니다."}
        </div>
        <button
          className="tb-btn"
          disabled={saving}
          onClick={() => {
            if (this.props.top) setRescue("");
            this.setState({ error: null });
          }}
        >
          ↻ 다시 시도
        </button>
      </div>
    );
  }
}
