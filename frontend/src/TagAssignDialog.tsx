import { useEffect, useMemo, useRef, useState } from "react";
import { COMMON, addTag, tagNameProblem, type BundleRef, type TagStore } from "./logTags";
import { fromWhere, placeTags, setAssign, targetSentence, type AssignTarget } from "./tagAssign";

// Small window to put tags on one place: a bundle folder / server root / file
// series (tree right-click) or a file name outside a bundle (tab menu, status
// bar 🏷). Applies on 확인; 취소/Esc leaves everything as it was.

type Mode = "list" | "inherit" | "none";

interface Props {
  store: TagStore;
  target: AssignTarget;
  title: string; // what was right-clicked ("lizcollector", "collector.log", "s1 서버")
  bundle: BundleRef | null;
  notice: string;
  onApply: (s: TagStore) => void;
  onClose: () => void;
  onOpenTags: (name: string) => void; // open the tag window at this tag (after applying)
}

export default function TagAssignDialog({ store, target, title, bundle, notice, onApply, onClose, onOpenTags }: Props) {
  const cur = useMemo(() => placeTags(store, target, bundle), [store, target, bundle]);
  const [draft, setDraft] = useState<TagStore>(store);
  const [mode, setMode] = useState<Mode>(cur.direct === undefined ? "inherit" : cur.direct.length ? "list" : "none");
  const [checked, setChecked] = useState<string[]>(cur.direct ?? []);
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  const others = draft.tags.filter((t) => t.name !== COMMON);
  const kindWord = target.kind === "dir" ? (target.key === "" ? "이 서버 폴더" : "이 폴더") : target.kind === "file" ? "이 파일" : "이 이름";
  const kindTopic = kindWord + (target.kind === "dir" ? "는" : "은"); // 이 폴더는 / 이 파일은 / 이 이름은
  const parentWord = target.kind === "name" ? "지정 지우기 (태그 없음 = common 만)" : "상위 폴더 따르기";

  // first focus: the first tag checkbox, or the new-tag box when there are none
  useEffect(() => {
    const el = boxRef.current?.querySelector<HTMLElement>(".ta-tag input, .ta-new input");
    el?.focus();
  }, []);

  const result = (): string[] | null => {
    if (mode === "none") return [];
    if (mode === "list" && checked.length) return draft.tags.map((t) => t.name).filter((n) => checked.includes(n));
    return null; // nothing checked = follow the folder above
  };
  const apply = (thenOpen?: string) => {
    onApply(setAssign(draft, target, bundle, result()));
    onClose();
    if (thenOpen) onOpenTags(thenOpen);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && !(e.target as HTMLElement).closest(".ta-new") && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      apply();
    }
  };

  const toggle = (name: string, on: boolean) => {
    const next = on ? [...checked.filter((n) => n !== name), name] : checked.filter((n) => n !== name);
    setChecked(next);
    setMode(next.length ? "list" : "inherit"); // all unchecked = follow the folder above
  };
  const create = () => {
    const name = newName;
    const p = tagNameProblem(name, draft.tags.map((t) => t.name));
    if (p) {
      setErr(p);
      return;
    }
    setDraft(addTag(draft, name));
    setChecked([...checked, name]);
    setMode("list");
    setNewName("");
    setErr("");
  };

  const now =
    cur.direct === undefined
      ? cur.inherited
        ? `지금: ${fromWhere(cur.from)} 에서 물려받는 중 — ${cur.effective.join(", ") || "(태그 없음)"}`
        : "지금: 붙은 태그 없음 (common 만)"
      : cur.direct.length
        ? `지금: ${kindWord}에 직접 지정 — ${cur.direct.join(", ")}`
        : `지금: ${kindTopic} 태그 없음으로 지정 (위 폴더 태그를 물려받지 않음)`;
  const inheritedNames = cur.direct === undefined ? cur.effective : [];
  const parentTags = target.kind === "file" ? (cur.direct === undefined ? cur.effective : cur.overrides) : [];

  return (
    <div className="chips-overlay" onMouseDown={onClose}>
      <div
        ref={boxRef}
        className="keys-dialog tag-assign"
        role="dialog"
        aria-label="태그 지정"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="chips-title">🏷 태그 지정 — {title}</div>
        <div className="ta-where">{targetSentence(target)}</div>
        <div className="ta-now">{now}</div>
        {target.kind === "file" && parentTags.length > 0 && (
          <div className="chips-sub">
            이 파일에 태그를 고르면 폴더 태그({parentTags.join(", ")}) 대신 고른 태그만 씁니다. 폴더 규격대로 오지 않는 묶음에 쓰세요.
          </div>
        )}
        {notice && <div className="tags-notice">{notice}</div>}
        <div className="ta-list">
          <label className="ta-row ta-common" title="common 은 모든 로그에 항상 쓰여 고를 필요가 없습니다">
            <input type="checkbox" checked disabled />
            <span className="ta-name">common</span>
            <span className="ta-note">항상 적용</span>
          </label>
          {others.length === 0 && <div className="tags-place dim">아직 만든 태그가 없습니다. 아래에서 새 태그를 만드세요.</div>}
          {others.map((t) => (
            <div className="ta-row ta-tag" key={t.name} data-tag={t.name}>
              <label>
                <input type="checkbox" checked={mode === "list" && checked.includes(t.name)} onChange={(e) => toggle(t.name, e.target.checked)} />
                <span className="ta-name">{t.name}</span>
              </label>
              {inheritedNames.includes(t.name) && <span className="ta-note">물려받는 중</span>}
              <span className="ta-count">{t.rules.length ? `규칙 ${t.rules.length}` : "규칙 없음"}</span>
              <button
                className="mp-x ta-rules"
                title={`확인하고 태그 창에서 ${t.name} 규칙 고치기`}
                onClick={() => apply(t.name)}
              >
                규칙 ✎
              </button>
            </div>
          ))}
        </div>
        <div className="ta-new">
          <input
            className="find-input"
            placeholder="새 태그 이름 (대소문자 구분)"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setErr("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                create();
              }
            }}
          />
          <button className="tb-btn" onClick={create}>
            ＋ 새 태그 만들기
          </button>
        </div>
        <div className="tags-name-error">{err}</div>
        <div className="ta-modes" role="radiogroup" aria-label="지정 방식">
          <label>
            <input
              type="radio"
              name="ta-mode"
              checked={mode === "inherit" || (mode === "list" && !checked.length)}
              onChange={() => {
                setMode("inherit");
                setChecked([]);
              }}
            />
            {parentWord}
            <span className="ta-note">{target.kind === "name" ? "" : " (직접 지정 지우기 — 체크를 모두 꺼도 같음)"}</span>
          </label>
          <label>
            <input
              type="radio"
              name="ta-mode"
              checked={mode === "none"}
              onChange={() => {
                setMode("none");
                setChecked([]);
              }}
            />
            {kindTopic} 태그 없음
            <span className="ta-note">{target.kind === "name" ? " (common 만)" : " (위 폴더 태그를 물려받지 않음, common 만)"}</span>
          </label>
        </div>
        <div className="chips-sub">여러 태그를 고르면 목록 위쪽 태그가 먼저 칠합니다(같은 글자에 걸리면 위쪽이 이김).</div>
        <div className="chips-actions">
          <button className="tb-btn" onClick={onClose}>
            취소
          </button>
          <button className="tb-btn primary ta-ok" onClick={() => apply()}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

