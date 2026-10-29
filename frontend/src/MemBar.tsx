import { useEffect, useRef, useState } from "react";
import { MemInfo } from "../wailsjs/go/main/App";

// 「🧠」 in the status bar: how much memory the app (Go) and the window (the
// WebView's JS memory, which has a hard limit of about 4GB per window — past it
// the window dies white) use, and how much of the editing budget
// (WHOLE_BUDGET: text read into the editor) is taken. Every 2 seconds and
// whenever a tab changes state; yellow from 60%, red from 85% of a limit.
// Clicked: the tabs with their view and what they hold.

export interface MemTab {
  id: string;
  title: string;
  mode: "read" | "lines" | "edit" | "wait" | "save" | "other";
  held: number; // characters held for the editor (0 = none)
}

const MODE_TEXT: Record<MemTab["mode"], string> = {
  read: "📖 읽기",
  lines: "🏷 줄만",
  edit: "✏️ 편집",
  wait: "⏳ 편집용으로 여는 중",
  save: "💾 저장 중",
  other: "—",
};

const GB = 1 << 30;
export const fmtMem = (n: number) => (n >= GB ? (n / GB).toFixed(1) + "GB" : Math.round(n / (1 << 20)) + "MB");

// The window's JS memory: performance.memory (Chromium / WebView2).
export function jsHeap(): { used: number; limit: number } | null {
  const m = (performance as any).memory;
  if (!m || typeof m.usedJSHeapSize !== "number") return null;
  return { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit || 4 * GB };
}

export function memLevel(ratio: number): "" | "warn" | "high" {
  return ratio >= 0.85 ? "high" : ratio >= 0.6 ? "warn" : "";
}

export default function MemBar(p: { tabs: () => MemTab[]; held: () => number; budget: number; tick: unknown }) {
  const [go, setGo] = useState<{ ws: number; web: number; procs: number } | null>(null);
  const [, setNow] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      MemInfo()
        .then((m) => {
          if (alive && m) setGo({ ws: m.goWorkingSet, web: m.webView, procs: m.webViewProcs });
        })
        .catch(() => {});
      setNow((n) => (n + 1) & 0xffff);
    };
    poll();
    const t = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const heap = jsHeap();
  const held = p.held();
  const heapRatio = heap ? heap.used / heap.limit : 0;
  const editRatio = held / p.budget;
  const level = memLevel(Math.max(heapRatio, editRatio));
  const filled = Math.round(Math.min(1, heapRatio) * 4);
  const bar = "▓".repeat(filled) + "░".repeat(4 - filled);
  const text =
    `🧠 앱(Go) ${go ? fmtMem(go.ws) : "…"} · 화면 ${heap ? fmtMem(heap.used) + " / 약 " + fmtMem(heap.limit) : "?"} ${bar}` +
    ` · 편집 ${Math.round(held / (1 << 20))}/${Math.round(p.budget / (1 << 20))}MB`;
  const tabs = open ? p.tabs() : [];
  return (
    <span className="st-mem-wrap" ref={rootRef}>
      <button
        className={"st-mem" + (level ? " " + level : "")}
        data-level={level || "ok"}
        data-heap={heap ? Math.round(heap.used) : ""}
        data-held={held}
        title={
          "메모리 — 앱(Go) = 이 프로그램, 화면 = 창의 JS 메모리(한계에 닿으면 창이 하얗게 죽음), 편집 = 편집기로 읽어 들인 파일 합계/한도. 2초마다 갱신, 60% 노랑·85% 빨강. 누르면 탭별 목록" +
          (go && go.procs ? `\nWebView 프로세스 ${go.procs}개 합 ${fmtMem(go.web)}` : "")
        }
        onMouseDown={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {text}
      </button>
      {open && (
        <div className="mem-pop" role="dialog" aria-label="메모리 — 탭별">
          <div className="mem-head">
            앱(Go) {go ? fmtMem(go.ws) : "…"} · 화면 JS {heap ? `${fmtMem(heap.used)} / ${fmtMem(heap.limit)}` : "?"}
            {go && go.procs ? ` · WebView 프로세스 ${go.procs}개 ${fmtMem(go.web)}` : ""}
            <br />편집으로 연 것 {fmtMem(held)} / {fmtMem(p.budget)}
          </div>
          <table className="mem-tabs">
            <tbody>
              {tabs.map((t) => (
                <tr key={t.id} data-mode={t.mode}>
                  <td className="mem-t">{t.title}</td>
                  <td>{MODE_TEXT[t.mode]}</td>
                  <td className="mem-n">{t.held ? fmtMem(t.held) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </span>
  );
}
