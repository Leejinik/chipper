import { useMemo, useState } from "react";
import type { main } from "../wailsjs/go/models";

// Drag payload type for a tree file dropped onto a multi-view pane.
export const TREE_DRAG_TYPE = "application/x-chipper-bundle-file";

// Explorer-style tree of a log bundle: server folders → sub-folders → files.
// Clicking a file shows it in that server's pane; "⇉" shows the same log in
// every pane. Rotated logs (3+ files differing only by date/number) fold into
// one node.

interface Node {
  key: string;
  name: string;
  server: string;
  rel?: string; // files only
  size?: number;
  compressed?: boolean;
  children?: Node[]; // folders, servers and rotated series
  series?: boolean;
}

interface Props {
  scan: main.Bundle;
  shown: Map<string, number[]>; // "server\u0000rel" → panes (0-based) showing it
  paneOfServer: Map<string, number[]>; // server → panes following it
  onOpen: (server: string, rel: string) => void;
  onOpenAll: (rel: string) => void;
  onHide: () => void;
  rotationKey: (rel: string) => string;
  fmtSize: (n: number) => string;
  bigFile: number;
}

function buildServer(srv: main.BundleServer, rotationKey: (rel: string) => string, q: string): Node {
  const root: Node = { key: "s:" + srv.name, name: srv.name, server: srv.name, children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  const dirOf = (path: string): Node => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf("/");
    const parent = dirOf(cut < 0 ? "" : path.slice(0, cut));
    const n: Node = { key: `d:${srv.name}/${path}`, name: path.slice(cut + 1), server: srv.name, children: [] };
    parent.children!.push(n);
    dirs.set(path, n);
    return n;
  };
  // An empty server folder came as files: null before v1.2.1 and blanked the
  // whole window ("t.files is not iterable").
  for (const f of srv.files ?? []) {
    if (q && !f.rel.toLowerCase().includes(q)) continue;
    const cut = f.rel.lastIndexOf("/");
    dirOf(cut < 0 ? "" : f.rel.slice(0, cut)).children!.push({
      key: `f:${srv.name}/${f.rel}`,
      name: f.rel.slice(cut + 1),
      server: srv.name,
      rel: f.rel,
      size: f.size,
      compressed: f.compressed,
    });
  }
  const tidy = (n: Node) => {
    if (!n.children) return;
    const folders = n.children.filter((c) => !c.rel);
    const files = n.children.filter((c) => c.rel);
    const bySeries = new Map<string, Node[]>();
    for (const f of files) {
      const k = rotationKey(f.rel!);
      bySeries.set(k, [...(bySeries.get(k) ?? []), f]);
    }
    const out: Node[] = [];
    for (const [k, group] of bySeries) {
      if (group.length >= 3 && k !== group[0].rel) {
        out.push({
          key: `r:${srv.name}/${k}`,
          name: k.slice(k.lastIndexOf("/") + 1),
          server: srv.name,
          series: true,
          children: group.sort((a, b) => a.name.localeCompare(b.name)),
        });
      } else out.push(...group);
    }
    folders.forEach(tidy);
    folders.sort((a, b) => a.name.localeCompare(b.name));
    out.sort((a, b) => Number(!!a.series) - Number(!!b.series) || a.name.localeCompare(b.name));
    n.children = [...folders, ...out];
  };
  tidy(root);
  return root;
}

export default function BundleTree(p: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set((p.scan.servers ?? []).map((s) => "s:" + s.name)));
  const q = filter.trim().toLowerCase();
  const tree = useMemo(
    () => (p.scan.servers ?? []).map((s) => buildServer(s, p.rotationKey, q)),
    [p.scan, p.rotationKey, q]
  );
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const render = (n: Node, depth: number): JSX.Element | null => {
    const pad = { paddingLeft: 6 + depth * 12 };
    if (n.rel) {
      const panes = p.shown.get(n.server + "\u0000" + n.rel) ?? [];
      return (
        <div
          key={n.key}
          className={"bt-row file" + (panes.length ? " shown" : "") + (n.compressed ? " off" : "")}
          style={pad}
          title={
            n.compressed
              ? "압축 파일은 열 수 없습니다"
              : `${n.server}/${n.rel} — 눌러서 ${n.server} 칸에 열기, 또는 원하는 칸으로 끌어다 놓기`
          }
          draggable={!n.compressed}
          onDragStart={(e) => {
            e.dataTransfer.setData(TREE_DRAG_TYPE, JSON.stringify({ server: n.server, rel: n.rel }));
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => !n.compressed && p.onOpen(n.server, n.rel!)}
        >
          <span className="bt-name">{n.name}</span>
          {panes.map((i) => (
            <span key={i} className="bt-pane">
              {i + 1}
            </span>
          ))}
          {!n.compressed && (
            <button
              className="bt-all"
              title="모든 서버의 칸에서 같은 로그 열기"
              onClick={(e) => {
                e.stopPropagation();
                p.onOpenAll(n.rel!);
              }}
            >
              ⇉
            </button>
          )}
          <span className={n.size! >= p.bigFile ? "bt-size big" : "bt-size"}>
            {n.compressed ? "압축" : p.fmtSize(n.size!)}
          </span>
        </div>
      );
    }
    if (q && n.children && n.children.length === 0) return null; // filtered away
    const isOpen = q ? true : open.has(n.key);
    const isServer = n.key.startsWith("s:");
    const panes = isServer ? p.paneOfServer.get(n.server) ?? [] : [];
    return (
      <div key={n.key}>
        <div
          className={"bt-row " + (isServer ? "server" : n.series ? "series" : "dir")}
          style={pad}
          onClick={() => toggle(n.key)}
          title={n.series ? "날짜·번호만 다른 회전 로그" : undefined}
        >
          <span className="bt-name">
            {isOpen ? "▾" : "▸"} {n.name}
            {n.series ? ` (${n.children!.length})` : ""}
          </span>
          {panes.map((i) => (
            <span key={i} className="bt-pane server">
              {i + 1}
            </span>
          ))}
        </div>
        {isOpen && n.children!.map((c) => render(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="bundle-tree">
      <div className="bt-head">
        <span className="bt-title" title={p.scan.root}>
          📦 {p.scan.root.split(/[\\/]/).filter(Boolean).pop()}
        </span>
        <button className="bt-hide" title="트리 접기" onClick={p.onHide}>
          ◀
        </button>
      </div>
      {(p.scan.servers ?? []).some((x) => x.truncated || x.unreadable > 0) && (
        <div className="bt-warn">
          {(p.scan.servers ?? [])
            .filter((x) => x.truncated || x.unreadable > 0)
            .map(
              (x) =>
                `${x.name}: ` +
                [
                  x.truncated ? `파일이 너무 많아 앞의 ${(x.files ?? []).length.toLocaleString()}개만 보입니다` : "",
                  x.unreadable > 0 ? `읽을 수 없는 항목 ${x.unreadable}개(권한 등)는 빠졌습니다` : "",
                ]
                  .filter(Boolean)
                  .join(", ")
            )
            .join(" · ")}
        </div>
      )}
      <input
        className="find-input bt-filter"
        placeholder="거르기 (예: zookeeper)"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="bt-body">{tree.map((n) => render(n, 0))}</div>
    </div>
  );
}
