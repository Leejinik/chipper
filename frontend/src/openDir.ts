import type { main } from "../wailsjs/go/models";

// 「📂 디렉토리 열기」 helpers shared by the tree and App.
//
// The top folders of an opened directory are its "servers". ⇉ (the same log in
// every top folder) only makes sense when 2+ top folders hold that log; the
// match is the one App's resolveInServer uses: the same relative path, else
// the same path ignoring case, else the only file with that name.

export interface DirIndex {
  servers: { name: string; rels: Set<string>; bases: Map<string, number> }[];
}

const baseOf = (rel: string) => rel.toLowerCase().split("/").pop() || "";

export function dirIndex(scan: main.Bundle | null | undefined): DirIndex {
  return {
    servers: (scan?.servers ?? []).map((s) => {
      const rels = new Set<string>();
      const bases = new Map<string, number>();
      for (const f of s.files ?? []) {
        rels.add(f.rel.toLowerCase());
        const b = baseOf(f.rel);
        bases.set(b, (bases.get(b) ?? 0) + 1);
      }
      return { name: s.name, rels, bases };
    }),
  };
}

// Top folders (in tree order) that hold `rel`.
export function serversWith(ix: DirIndex, rel: string): string[] {
  const lower = rel.toLowerCase();
  const base = baseOf(rel);
  return ix.servers.filter((s) => s.rels.has(lower) || s.bases.get(base) === 1).map((s) => s.name);
}

// ⇉ is offered for a file of a top folder when another top folder has it too.
export function canOpenAll(ix: DirIndex, server: string, rel: string): boolean {
  if (!server || ix.servers.length < 2) return false;
  let n = 0;
  for (const name of serversWith(ix, rel)) if (++n >= 2) return true;
  return false;
}

// The name a directory shows in the tree head ("C:\logs\b1\" → "b1", "/" → "/").
export function dirName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() || root;
}
