import { Component, type ErrorInfo, type ReactNode } from "react";

// Keeps a rendering error inside the part of the screen that hit it. Without
// a boundary React unmounts the whole tree on any render error — in v1.2.0 an
// empty folder in a log bundle blanked the entire window (toolbar, tabs and
// all). Tabs, unsaved text and the session live above the boundary, so they
// are untouched; 「다시 시도」 just draws the part again.
interface Props {
  what: string; // which part, in the message: "로그 묶음 트리", "3번 칸" …
  resetKey?: unknown; // a change (another file, another bundle) clears the error
  children: ReactNode;
}
interface State {
  error: unknown;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error("알 수 없는 오류") };
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
    return (
      <div className="render-error" role="alert">
        <div className="render-error-title">이 부분({this.props.what})을 그리다 오류가 났습니다</div>
        <div className="render-error-msg">{msg}</div>
        <div className="render-error-sub">열린 탭과 저장하지 않은 내용은 그대로 있습니다.</div>
        <button className="tb-btn" onClick={() => this.setState({ error: null })}>
          ↻ 다시 시도
        </button>
      </div>
    );
  }
}
