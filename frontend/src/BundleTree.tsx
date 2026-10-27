import { useEffect, useMemo, useRef, useState } from "react";
import type { main } from "../wailsjs/go/models";
import { dirProbe, type AssignTarget, type PlaceTags } from "./tagAssign";

// Drag payload type for a tree file dropped onto a multi-view pane.
export const TREE_DRAG_TYPE = "application/x-chipper-bundle-file";

// Explorer-style tree of a log bundle: server folders → sub-folders → files.
// Clicking a file shows it in that server's pane; "⇉" shows the same log in
// every pane. Rotated logs (3+ files differing only by date/number) fold into
// one node. Right-click (or Shift+F10 / the menu key) puts tags on a folder,
// a server or a file series; lines show the tags in effect there.
// Keyboard: Tab into the tree, ↑↓ move, →← open/close, Enter opens.

interface Node {
  key: string;
  name: string;
  server: string;
  rel?: string; // files only
  dir?: string; // folders and servers: path under the server folder ("" = server)
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
  pathOf: (server: string, rel: string) => string; // absolute path of a bundle file
  tagsOf: (t: AssignTarget) => PlaceTags;
  onAssign: (t: AssignTarget, title: string, returnFocus: HTMLElement | null) => void;
}

function buildServer(srv: main.BundleServer, rotationKey: (rel: string) => string, q: string): Node {
  const root: Node = { key: "s:" + srv.name, name: srv.name, server: srv.name, dir: "", children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  const dirOf = (path: string): Node => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf("/");
    const parent = dirOf(cut < 0 ? "" : path.slice(0, cut));
    const n: Node = { key: `d:${srv.name}/${path}`, name: path.slice(cut + 1), server: srv.name, dir: path, children: [] };
    parent.children!.push(n);
    dirs.set(path, n);
    return n;
  };
  for (const f of srv.files) {
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
      // The series key is the current file's name, so the current file sits
      // in the group too; a series is any 3+ files with at least one rotated.
      if (group.length >= 3 && group.some((f) => f.rel !== k)) {
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

// One visible line of the tree. The tree is rendered flat so the keyboard can
// walk it like a list.
interface Row {
  node: Node;
  depth: number;
  parent: Row | null;
  folder: boolean;
  isOpen: boolean;
}

interface Menu {
  x: number;
  y: number;
  row: Row;
}

export default function BundleTree(p: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(p.scan.servers.map((s) => "s:" + s.name)));
  const [cursor, setCursor] = useState<string>("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const q = filter.trim().toLowerCase();
  const tree = useMemo(
    () => p.scan.servers.map((s) => buildServer(s, p.rotationKey, q)),
    [p.scan, p.rotationKey, q]
  );
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const rows: Row[] = [];
  const walk = (n: Node, depth: number, parent: Row | null) => {
    const folder = !n.rel;
    if (folder && q && n.children && n.children.length === 0) return; // filtered away
    const isOpen = folder && (q ? true : open.has(n.key));
    const row: Row = { node: n, depth, parent, folder, isOpen };
    rows.push(row);
    if (isOpen) n.children!.forEach((c) => walk(c, depth + 1, row));
  };
  tree.forEach((n) => walk(n, 0, null));
  const cur = rows.find((r) => r.node.key === cursor) ?? rows[0];

  const rowEl = (key: string) =>
    bodyRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null;
  const focusRow = (key: string) => {
    setCursor(key);
    requestAnimationFrame(() => rowEl(key)?.focus());
  };

  const targetOf = (n: Node): AssignTarget => {
    const pathOf = (rel: string) => p.pathOf(n.server, rel);
    if (n.rel) return { kind: "file", key: p.rotationKey(n.rel), path: pathOf(n.rel) };
    if (n.series) {
      const first = n.children![0].rel!;
      return { kind: "file", key: p.rotationKey(first), path: pathOf(first) };
    }
    return { kind: "dir", key: n.dir ?? "", path: dirProbe(pathOf, n.dir ?? "") };
  };
  const titleOf = (n: Node) =>
    n.key.startsWith("s:") ? `${n.name} 서버 폴더 전체` : n.series ? `${n.name} (회전 파일)` : n.name;

  const openMenu = (row: Row, x: number, y: number) => {
    const MW = 240;
    const MH = 130;
    setMenu({ row, x: Math.max(0, Math.min(x, window.innerWidth - MW)), y: Math.max(0, Math.min(y, window.innerHeight - MH)) });
  };
  const openMenuAtRow = (row: Row) => {
    const r = rowEl(row.node.key)?.getBoundingClientRect();
    openMenu(row, r ? r.left + 24 : 40, r ? r.bottom : 40);
  };
  const closeMenu = (refocus: boolean) => {
    const key = menu?.row.node.key;
    setMenu(null);
    if (refocus && key) focusRow(key);
  };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const away = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as globalThis.Node)) setMenu(null);
    };
    const resize = () => setMenu(null);
    window.addEventListener("mousedown", away);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("resize", resize);
    };
  }, [menu]);

  const activate = (row: Row) => {
    const n = row.node;
    if (row.folder) toggle(n.key);
    else if (!n.compressed) p.onOpen(n.server, n.rel!);
  };

  const onRowKey = (e: React.KeyboardEvent, row: Row) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const i = rows.indexOf(row);
    const k = e.key;
    let handled = true;
    if (k === "ArrowDown") {
      if (i + 1 < rows.length) focusRow(rows[i + 1].node.key);
    } else if (k === "ArrowUp") {
      if (i > 0) focusRow(rows[i - 1].node.key);
      else filterRef.current?.focus();
    } else if (k === "Home") focusRow(rows[0].node.key);
    else if (k === "End") focusRow(rows[rows.length - 1].node.key);
    else if (k === "ArrowRight") {
      if (row.folder && !row.isOpen) toggle(row.node.key);
      else if (row.folder && rows[i + 1]?.parent === row) focusRow(rows[i + 1].node.key);
    } else if (k === "ArrowLeft") {
      if (row.folder && row.isOpen && !q) toggle(row.node.key);
      else if (row.parent) focusRow(row.parent.node.key);
    } else if ((k === "Enter" || k === " ") && !e.shiftKey) activate(row);
    else if ((k === "F10" && e.shiftKey) || k === "ContextMenu") openMenuAtRow(row);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const n = items.length;
      items[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]?.focus();
    }
  };

  const chips = (row: Row) => {
    if (row.parent?.node.series) return null; // the series line shows them
    const n = row.node;
    const t = p.tagsOf(targetOf(n));
    if (t.direct !== undefined) {
      const isFile = !row.folder || !!n.series;
      const over = isFile && t.overrides.length > 0;
      const why = over ? ` — 폴더 태그(${t.overrides.join(", ")}) 대신 이 파일의 태그만 씀` : "";
      if (!t.direct.length)
        return (
          <span
            className={"bt-tag none" + (over ? " override" : "")}
            title={"직접 「태그 없음」 지정 — 위 폴더 태그를 물려받지 않음" + why}
          >
            {over ? "📌 " : ""}태그 없음
          </span>
        );
      return t.direct.map((name) => (
        <span
          key={name}
          className={"bt-tag direct" + (over ? " override" : "")}
          title={(isFile ? "이 파일(회전 파일 포함)에 직접 지정" : "여기에 직접 지정") + why}
        >
          {over ? "📌 " : ""}
          {name}
        </span>
      ));
    }
    if (t.inherited && t.effective.length && t.from.kind === "dir") {
      const from = t.from.key === "" ? "서버 폴더 전체" : t.from.key;
      return t.effective.map((name) => (
        <span key={name} className="bt-tag inherited" title={`${from} 에서 물려받음`}>
          {name}
        </span>
      ));
    }
    return null;
  };

  const rowProps = (row: Row) => {
    const n = row.node;
    return {
      "data-key": n.key,
      role: "treeitem",
      "aria-level": row.depth + 1,
      tabIndex: cur && cur.node.key === n.key ? 0 : -1,
      style: { paddingLeft: 6 + row.depth * 12 },
      onFocus: () => setCursor(n.key),
      onKeyDown: (e: React.KeyboardEvent) => onRowKey(e, row),
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setCursor(n.key);
        if (e.clientX === 0 && e.clientY === 0) openMenuAtRow(row); // menu key
        else openMenu(row, e.clientX, e.clientY);
      },
    };
  };

  const renderRow = (row: Row): JSX.Element => {
    const n = row.node;
    if (n.rel) {
      const panes = p.shown.get(n.server + "\u0000" + n.rel) ?? [];
      return (
        <div
          key={n.key}
          {...rowProps(row)}
          className={"bt-row file" + (panes.length ? " shown" : "") + (n.compressed ? " off" : "")}
          title={
            n.compressed
              ? "압축 파일은 열 수 없습니다"
              : `${n.server}/${n.rel} — 눌러서 ${n.server} 칸에 열기, 또는 원하는 칸으로 끌어다 놓기 · 우클릭: 태그 지정`
          }
          draggable={!n.compressed}
          onDragStart={(e) => {
            e.dataTransfer.setData(TREE_DRAG_TYPE, JSON.stringify({ server: n.server, rel: n.rel }));
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => !n.compressed && p.onOpen(n.server, n.rel!)}
        >
          <span className="bt-name">{n.name}</span>
          {chips(row)}
          {panes.map((i) => (
            <span key={i} className="bt-pane">
              {i + 1}
            </span>
          ))}
          {!n.compressed && (
            <button
              className="bt-all"
              tabIndex={-1}
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
    const isServer = n.key.startsWith("s:");
    const panes = isServer ? p.paneOfServer.get(n.server) ?? [] : [];
    return (
      <div
        key={n.key}
        {...rowProps(row)}
        aria-expanded={row.isOpen}
        className={"bt-row " + (isServer ? "server" : n.series ? "series" : "dir")}
        onClick={() => toggle(n.key)}
        title={(n.series ? "날짜·번호만 다른 회전 로그" : isServer ? "서버 폴더" : "폴더") + " · 우클릭: 태그 지정"}
      >
        <span className="bt-name">
          {row.isOpen ? "▾" : "▸"} {n.name}
          {n.series ? ` (${n.children!.length})` : ""}
        </span>
        {chips(row)}
        {panes.map((i) => (
          <span key={i} className="bt-pane server">
            {i + 1}
          </span>
        ))}
      </div>
    );
  };

  const mn = menu?.row.node;
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
      {p.scan.servers.some((x) => x.truncated || x.unreadable > 0) && (
        <div className="bt-warn">
          {p.scan.servers
            .filter((x) => x.truncated || x.unreadable > 0)
            .map(
              (x) =>
                `${x.name}: ` +
                [
                  x.truncated ? `파일이 너무 많아 앞의 ${x.files.length.toLocaleString()}개만 보입니다` : "",
                  x.unreadable > 0 ? `읽을 수 없는 항목 ${x.unreadable}개(권한 등)는 빠졌습니다` : "",
                ]
                  .filter(Boolean)
                  .join(", ")
            )
            .join(" · ")}
        </div>
      )}
      <input
        ref={filterRef}
        className="find-input bt-filter"
        placeholder="거르기 (예: zookeeper) · ↓ 로 트리로"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && cur) {
            e.preventDefault();
            focusRow(cur.node.key);
          }
        }}
      />
      <div
        className="bt-body"
        ref={bodyRef}
        role="tree"
        aria-label="로그 묶음 파일 (↑↓ 이동 · →← 펼치기/접기 · Enter 열기 · Shift+F10 메뉴)"
      >
        {rows.map(renderRow)}
      </div>
      {menu && mn && (
        <div
          ref={menuRef}
          className="ctx-menu bt-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onMenuKey}
        >
          <div className="menu-head">{titleOf(mn)}</div>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              const row = menu.row;
              setMenu(null);
              p.onAssign(targetOf(row.node), titleOf(row.node), rowEl(row.node.key));
            }}
          >
            🏷 태그 지정…
          </button>
          {mn.rel && !mn.compressed && (
            <>
              <div className="menu-sep" />
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  p.onOpen(mn.server, mn.rel!);
                }}
              >
                {mn.server} 칸에 열기<span className="menu-key">Enter</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  p.onOpenAll(mn.rel!);
                }}
              >
                모든 서버 칸에 열기<span className="menu-key">⇉</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
