import type { LogRule } from "./logHighlight";
import { COMMON, addTag, deleteTag, renameTag, uniqueTagName, type TagStore } from "./logTags";

// The tag window's draft (「적용」 버튼, 10-28): what is changed in the window is
// kept as a list of edits laid over the saved store, and written only on
// 적용 / 확인; 닫기 / Esc / × throw the edits away.
//
// The edits are kept as edits (not as a copy of the store) so that a save made
// outside the window while it is open — a tag put on a folder from the tree,
// 「이 글자로 로그 색 규칙 만들기…」, an import from the window's own buttons —
// is never overwritten: whenever the saved store changes, the edits are laid
// again over the new one (rebaseDraft). An edit that no longer fits (its tag or
// rule went away, its new name got taken) is dropped or renamed, and a note
// says so in the window. What the window shows is exactly what 적용 writes.

export type RuleEdit =
  | { k: "upd"; id: string; patch: Partial<LogRule> } // change fields of one rule
  | { k: "push"; rule: LogRule } // ＋ 규칙 추가
  | { k: "del"; id: string } // 🗑
  | { k: "up"; id: string } // ↑ (swap with the rule above)
  // 비우기 / 기본값으로: the rules there when it was done (`ids`) give way to
  // `rules`; rules added outside the window meanwhile stay (after them)
  | { k: "replace"; ids: string[]; rules: LogRule[] };

export type DraftOp =
  | { k: "add"; name: string; rules: LogRule[]; at: string } // 새 태그 / 복제
  | { k: "rename"; from: string; to: string; at: string }
  | { k: "delete"; name: string }
  | { k: "rules"; tag: string; e: RuleEdit; at: string };

export interface Rebased {
  store: TagStore; // `base` with the edits on it
  ops: DraftOp[]; // the edits as they now apply to `base` (names resolved, misfits out)
  notes: string[]; // what could not be laid over as it was
  // names the window showed that now belong to another name (a tag of the
  // window renamed because its name got taken): the window's selection follows
  follow: Map<string, string>;
}

const ruleName = (r: LogRule) => (r.label ? `「${r.label}」` : r.pattern ? `「${r.pattern}」` : "이름 없는 규칙");

const newId = (taken: Set<string>) => {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    if (!taken.has(id)) return id;
  }
};

// Lay `ops` over `base`. The ops were made against the window's earlier view;
// a name in them means the tag that had that name in that view at that point —
// `alias` follows a tag whose name had to change here.
export function rebaseDraft(base: TagStore, ops: DraftOp[]): Rebased {
  let s = base;
  const out: DraftOp[] = [];
  const notes: string[] = [];
  const noted = new Set<string>();
  const note = (key: string, text: string) => {
    if (noted.has(key)) return;
    noted.add(key);
    notes.push(text);
  };
  const alias = new Map<string, string>();
  const goneAs = new Map<string, string>(); // a name in the old view → the tag that went away under it
  const gone = (name: string) => {
    const was = goneAs.get(name) ?? name;
    note("gone:" + was, `「${was}」 태그가 창 밖에서 없어져 이 태그에 한 변경을 얹지 못했습니다.`);
  };
  const resolve = (n: string) => alias.get(n) ?? n;
  const has = (n: string) => s.tags.some((t) => t.name === n);
  const names = () => new Set(s.tags.map((t) => t.name));
  const point = (name: string, to: string) => (to === name ? alias.delete(name) : alias.set(name, to));

  for (const op of ops) {
    if (op.k === "add") {
      let n = op.name;
      if (has(n)) {
        n = uniqueTagName(op.name, names());
        note("add:" + op.name, `창에서 만든 「${op.name}」 태그는 창 밖에서 같은 이름의 태그가 생겨 「${n}」 로 바꿨습니다.`);
      }
      point(op.name, n);
      goneAs.delete(op.name);
      s = addTag(s, n, op.rules, op.at);
      out.push(n === op.name ? op : { ...op, name: n });
    } else if (op.k === "rename") {
      const from = resolve(op.from);
      alias.delete(op.from);
      if (!has(from) || from === COMMON) {
        gone(op.from);
        goneAs.set(op.to, goneAs.get(op.from) ?? op.from);
        continue;
      }
      let to = op.to;
      if (to !== from && has(to)) {
        to = uniqueTagName(op.to, names());
        note("rename:" + op.to, `「${op.to}」 이름은 창 밖에서 같은 이름의 태그가 생겨 「${to}」 로 바꿨습니다.`);
      }
      point(op.to, to);
      goneAs.delete(op.to);
      if (to === from) continue;
      s = renameTag(s, from, to, op.at);
      out.push(from === op.from && to === op.to ? op : { ...op, from, to });
    } else if (op.k === "delete") {
      const n = resolve(op.name);
      alias.delete(op.name);
      if (!has(n)) continue; // gone already: nothing to do
      s = deleteTag(s, n);
      out.push(n === op.name ? op : { ...op, name: n });
    } else {
      const n = resolve(op.tag);
      const tag = s.tags.find((t) => t.name === n);
      if (!tag) {
        gone(op.tag);
        continue;
      }
      const rules = tag.rules;
      const e = op.e;
      let next: LogRule[] | null = null;
      let edit: RuleEdit = e;
      if (e.k === "upd") {
        const i = rules.findIndex((r) => r.id === e.id);
        if (i < 0) {
          note(
            "rule:" + n + "\u0000" + e.id,
            `「${n}」 태그에서 고친 규칙 하나가 창 밖에서 지워지거나 바뀌어(가져오기 등) 그 고친 내용을 얹지 못했습니다.`
          );
          continue;
        }
        next = rules.map((r, j) => (j === i ? { ...r, ...e.patch } : r));
      } else if (e.k === "push") {
        const ids = new Set(rules.map((r) => r.id));
        const rule = ids.has(e.rule.id) ? { ...e.rule, id: newId(ids) } : e.rule;
        if (rule !== e.rule) edit = { k: "push", rule };
        next = [...rules, rule];
      } else if (e.k === "del") {
        if (!rules.some((r) => r.id === e.id)) continue;
        next = rules.filter((r) => r.id !== e.id);
      } else if (e.k === "up") {
        const i = rules.findIndex((r) => r.id === e.id);
        if (i <= 0) continue;
        next = [...rules];
        [next[i - 1], next[i]] = [next[i], next[i - 1]];
      } else {
        const gone = new Set(e.ids);
        const kept = rules.filter((r) => !gone.has(r.id));
        const keptIds = new Set(kept.map((r) => r.id));
        if (kept.length)
          note(
            "kept:" + n,
            `「${n}」 태그에 창 밖에서 들어온 규칙 ${kept.length}개(${kept.slice(0, 3).map(ruleName).join(", ")}${kept.length > 3 ? " …" : ""})는 비우기·기본값으로 뒤에도 남겼습니다.`
          );
        next = [...e.rules.filter((r) => !keptIds.has(r.id)), ...kept];
      }
      s = { ...s, tags: s.tags.map((t) => (t.name === n ? { ...t, rules: next!, updated: op.at } : t)) };
      out.push(n === op.tag && edit === e ? op : { ...op, tag: n, e: edit });
    }
  }
  return { store: s, ops: out, notes, follow: alias };
}

// One more edit on top of the draft. Consecutive changes to the same rule
// (typing a pattern) become one edit.
export function pushOp(ops: DraftOp[], op: DraftOp): DraftOp[] {
  const last = ops[ops.length - 1];
  if (
    last &&
    op.k === "rules" &&
    op.e.k === "upd" &&
    last.k === "rules" &&
    last.e.k === "upd" &&
    last.tag === op.tag &&
    last.e.id === op.e.id
  )
    return [...ops.slice(0, -1), { ...op, e: { k: "upd", id: op.e.id, patch: { ...last.e.patch, ...op.e.patch } } }];
  return [...ops, op];
}

// Same tags, rules and assignments? The time of the last change (`updated`)
// does not count: adding a rule and taking it out again is no change.
const noTimes = (k: string, v: unknown) => (k === "updated" ? undefined : v);
export const sameTagStore = (a: TagStore, b: TagStore) => a === b || JSON.stringify(a, noTimes) === JSON.stringify(b, noTimes);
