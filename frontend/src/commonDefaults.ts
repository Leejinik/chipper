import { DEFAULT_LOG_RULES, DEFAULT_LOG_RULES_V1, DEFAULTS_REV, type LogRule } from "./logHighlight";
import { COMMON, type TagStore } from "./logTags";

// Bringing an existing common up to the current built-in rules (plan 7절,
// stage 6) without overwriting what the user changed.
//
// tags.json remembers the revision of built-in rules its common was last
// brought up to (TagStore.defaults; absent = 1, every file written before
// stage 6). When it is older than DEFAULTS_REV, once:
//   - a rule that is still exactly an old built-in rule (same kind, pattern,
//     case, colour, line, label — whatever its id) is replaced by its new
//     version(s), in the same place, keeping the user's 켜기 and 줄만 choices;
//   - a built-in rule the user changed (pattern, colour, …) is left as it is
//     and named in the note (태그 창 「기본값으로」 takes the new set);
//   - a built-in rule the user deleted stays deleted; the user's own rules and
//     other tags are not touched;
//   - the revision is then recorded, so this never runs again for that file
//     (even if the user later puts an old rule back on purpose).
// A read-only store (written by a newer chipper) is left alone by the caller.

const byId = (id: string) => DEFAULT_LOG_RULES.find((r) => r.id === id)!;

// Revision 1 → 2: what each old built-in rule becomes (by its v1 id).
const V1_TO_V2: Record<string, LogRule[]> = {
  error: [byId("error"), byId("error-ck"), byId("fail")],
  warn: [byId("warn")],
  info: [byId("info")],
  debug: [byId("debug")],
  time: [byId("time")],
  mk119: [byId("mk119")],
};

const content = (r: LogRule) =>
  JSON.stringify([r.kind, r.pattern, r.caseSensitive, r.color.toLowerCase(), r.line, r.label, r.lineHead ?? 0]);
const V1_BY_CONTENT = new Map(DEFAULT_LOG_RULES_V1.map((r) => [content(r), r.id]));
const V1_PATTERNS = new Map(DEFAULT_LOG_RULES_V1.map((r) => [r.pattern, r.id]));
const V1_IDS = new Set(DEFAULT_LOG_RULES_V1.map((r) => r.id));

export interface DefaultsUpgrade {
  store: TagStore;
  replaced: string[]; // labels of the old built-in rules brought up to date
  kept: string[]; // labels of built-in rules the user changed (left alone)
  note: string; // Korean, "" when nothing worth saying
}

// null = nothing to do: common already at DEFAULTS_REV or newer, or nothing in
// it is (or was) a built-in rule the new revision changes.
export function upgradeCommonDefaults(store: TagStore, now = new Date().toISOString()): DefaultsUpgrade | null {
  const rev = typeof store.defaults === "number" ? store.defaults : 1;
  if (rev >= DEFAULTS_REV) return null;
  const ci = store.tags.findIndex((t) => t.name === COMMON);
  if (ci < 0) return null; // normalizeTagStore always makes one (with the current revision)
  const common = store.tags[ci];
  const replaced: string[] = [];
  const kept: string[] = [];
  const taken = new Set(common.rules.map((r) => r.id));
  const out: LogRule[] = [];
  for (const r of common.rules) {
    const v1 = V1_BY_CONTENT.get(content(r));
    const next = v1 ? V1_TO_V2[v1] : undefined;
    if (!next) {
      // an old built-in rule the user changed: say so only where the new
      // revision would have changed it
      const was = V1_PATTERNS.get(r.pattern) ?? (V1_IDS.has(r.id) ? r.id : "");
      if (was && !sameAsNew(was)) kept.push(r.label || r.pattern);
      out.push(r);
      continue;
    }
    if (next.length === 1 && content(next[0]) === content(r)) {
      out.push(r); // unchanged in the new revision
      continue;
    }
    replaced.push(r.label || r.pattern);
    taken.delete(r.id);
    next.forEach((n, k) => {
      let id = k === 0 ? r.id : n.id;
      if (k > 0 && taken.has(id)) id = n.id + "-" + Math.random().toString(36).slice(2, 7);
      taken.add(id);
      // the user's switches carry over: 켜기 to every new rule, 줄만 to the ones
      // that use it (error-ck has 줄만 off by design)
      out.push({ ...n, id, on: r.on, filter: k === 0 ? r.filter : n.filter && r.filter });
    });
  }
  // Nothing to replace and nothing to tell (common emptied, or only the
  // user's own rules): leave tags.json as it is — no write just for the
  // revision; the check simply runs again next start (cheap, and silent).
  if (!replaced.length && !kept.length) return null;
  const tags = store.tags.slice();
  if (replaced.length) tags[ci] = { ...common, rules: out, updated: now };
  const parts: string[] = [];
  if (replaced.length)
    parts.push(
      `common 기본 규칙을 새 판으로 바꿨습니다(${replaced.map((x) => `「${x}」`).join(", ")}): ` +
        "오류 줄 배경은 줄 앞 60자 안의 레벨(ERROR·FATAL·CRIT 등 대문자)이나 <Error>·[error] 꼴일 때만, 본문의 failed·Exception·error 는 글자색만, 시각에 liz(10-22 00:00:03)·ClickHouse(2026.10.20 …) 형식 추가."
    );
  if (kept.length)
    parts.push(
      `직접 고친 기본 규칙 ${kept.length}개(${kept.map((x) => `「${x}」`).join(", ")})는 그대로 두었습니다 — 새 판을 쓰려면 태그 창 common 의 「기본값으로」를 누르세요.`
    );
  return { store: { ...store, tags, defaults: DEFAULTS_REV }, replaced, kept, note: parts.join(" ") };
}

// The old built-in rule `id` is the same in the new revision (nothing to miss).
function sameAsNew(id: string): boolean {
  const next = V1_TO_V2[id];
  const old = DEFAULT_LOG_RULES_V1.find((r) => r.id === id);
  return !!next && !!old && next.length === 1 && content(next[0]) === content(old);
}
