import { useEffect, useRef } from "react";

// The small 🏷 menu of a tab (tab right-click, status bar 🏷): a head line and
// a few items. Keyboard like the tree's menu: ↑↓ Home End move, Enter picks,
// Esc / Tab close it and give the focus back to whatever opened it.

export interface TagMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}

interface Props {
  x: number;
  y: number;
  head: string;
  items: TagMenuItem[];
  fromKey: boolean; // opened from the keyboard: the first item gets the focus
  onClose: (refocus: boolean) => void;
}

export default function TagMenu({ x, y, head, items, fromKey, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fromKey) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [fromKey]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const n = els.length;
    const go = (k: number) => {
      e.preventDefault();
      e.stopPropagation();
      els[k]?.focus();
    };
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "ArrowDown" && n) go(i < 0 ? 0 : (i + 1) % n);
    else if (e.key === "ArrowUp" && n) go(i < 0 ? n - 1 : (i - 1 + n) % n);
    else if (e.key === "Home" && n) go(0);
    else if (e.key === "End" && n) go(n - 1);
    else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault(); // already open
      e.stopPropagation();
    }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu tag-menu"
      role="menu"
      aria-label={head}
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={onKey}
    >
      <div className="menu-head">{head}</div>
      {items.map((it, k) => (
        <button key={k} className="menu-item" role="menuitem" disabled={it.disabled} title={it.title} onClick={it.onSelect}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
