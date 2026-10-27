import { Fragment, useEffect, useRef, useState } from "react";
import { DEFAULT_LOG_RULES, ruleProblem, ruleProblemReason, type LogRule, type RuleKind } from "./logHighlight";
import {
  COMMON,
  addTag,
  deleteTag,
  normalizeTagName,
  placesOf,
  renameTag,
  repairTagName,
  setTagRules,
  tagNameProblem,
  type TagStore,
} from "./logTags";
import { useTagsIO } from "./TagsIO";

// The log colour tag window (was the 「로그 색 규칙」 dialog): tag list on the
// left, the selected tag's rules on the right.

const KIND_LABEL: Record<RuleKind, string> = { text: "글자 그대로", word: "단어", regex: "정규식" };
const KIND_HINT: Record<RuleKind, string> = {
  text: "글자 (예: kafka rebalance)",
  word: "단어 (예: timeout)",
  regex: "정규식 (예: \\bTIMEOUT\\b)",
};

const ruleId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function newRule(): LogRule {
  return {
    id: ruleId(),
    on: true,
    label: "",
    pattern: "",
    kind: "text",
    caseSensitive: false,
    color: "#c678dd",
    line: false,
    filter: true,
  };
}

function placeLabel(kind: "dir" | "file" | "name", key: string): string {
  if (kind === "dir") return key === "" ? "📁 모든 서버의 전체 (서버 폴더 아래 모든 파일)" : `📁 모든 서버의 ${key}`;
  if (kind === "file") return `📄 모든 서버의 ${key} (회전 파일 포함)`;
  return `🏷 이름이 「${key}」 인 파일과 그 회전 파일 (로그 묶음 밖)`;
}

interface Props {
  store: TagStore;
  onChange: (s: TagStore) => void;
  onClose: () => void;
  initial: string; // tag selected when the window opens
  applied: string[]; // tags applied to the current tab (marked in the list)
  notice: string; // save problem / read-only notice ("" = none)
  // Write the tags now (optionally `next` first): "" = saved (or nothing to
  // save), otherwise why not. Used around an import (TagsIO.tsx).
  onSaveNow: (next?: TagStore) => Promise<string>;
}

export default function TagsDialog({ store, onChange, onClose, initial, applied, notice, onSaveNow }: Props) {
  const names = store.tags.map((t) => t.name);
  const [sel, setSel] = useState<string>(names.includes(initial) ? initial : COMMON);
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [nameErr, setNameErr] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const tag = store.tags.find((t) => t.name === sel) ?? store.tags[0];
  const rules = tag.rules;
  const isCommon = tag.name === COMMON;
  // export / import / backups (TagsIO.tsx): buttons, result band, small windows
  const io = useTagsIO({ store, onChange, onSaveNow, current: tag.name, select: setSel });

  // Esc closes the window wherever the focus is (not while renaming a tag);
  // with one of TagsIO's small windows up, TagsIO closes only that one first.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement | null)?.classList?.contains("tag-rename")) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming?.from]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRules = (f: (prev: LogRule[]) => LogRule[]) => onChange(setTagRules(store, tag.name, f(rules)));
  const upd = (id: string, patch: Partial<LogRule>) => setRules((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const startRename = (name: string) => {
    if (name === COMMON) return;
    setNameErr("");
    setRenaming({ from: name, value: name });
  };
  const commitRename = () => {
    if (!renaming) return;
    const v = normalizeTagName(renaming.value);
    if (v === renaming.from) {
      setRenaming(null);
      return;
    }
    const p = tagNameProblem(v, names.filter((n) => n !== renaming.from));
    if (p) {
      setNameErr(p);
      return;
    }
    onChange(renameTag(store, renaming.from, v));
    if (sel === renaming.from) setSel(v);
    setRenaming(null);
    setNameErr("");
  };
  const create = () => {
    const name = repairTagName("새 태그", names);
    onChange(addTag(store, name));
    setSel(name);
    setNameErr("");
    setRenaming({ from: name, value: name });
  };
  const duplicate = () => {
    const name = repairTagName(`${tag.name} 복사`, names);
    onChange(addTag(store, name, tag.rules.map((r) => ({ ...r }))));
    setSel(name);
  };
  const remove = () => {
    const where = placesOf(store, tag.name).length;
    const msg =
      `「${tag.name}」 태그를 지울까요? 규칙 ${tag.rules.length}개가 사라집니다.` +
      (where ? `\n붙어 있던 ${where}곳에서도 빠집니다.` : "");
    if (!window.confirm(msg)) return;
    onChange(deleteTag(store, tag.name));
    setSel(COMMON);
  };
  const clearCommon = () => {
    if (!rules.length) return;
    if (window.confirm(`common 태그의 규칙 ${rules.length}개를 모두 지울까요? (common 은 모든 로그에 쓰이는 태그라 지울 수 없고 비우기만 됩니다)`))
      setRules(() => []);
  };

  const places = placesOf(store, tag.name);

  return (
    <div className="chips-overlay" onMouseDown={() => !io.blocking && onClose()}>
      <div
        className="keys-dialog rules-dialog tags-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="chips-title">🏷 로그 색 태그</div>
        <div className="chips-sub">
          태그는 로그 색 규칙 묶음입니다. common 은 모든 로그에, 다른 태그는 붙인 곳의 로그에만 쓰입니다. 같은 글자에 두 규칙이 걸리면
          태그 쪽 색이 이깁니다. 태그 이름은 대소문자를 구분합니다(collector 와 Collector 는 다른 태그).
        </div>
        {notice && <div className="tags-notice">{notice}</div>}
        {io.banner}
        <div className="tags-body">
          <div className="tags-side">
            <div className="tags-list">
              {store.tags.map((t) =>
                renaming && renaming.from === t.name ? (
                  <input
                    key={t.name}
                    ref={renameInput}
                    className="tag-rename"
                    value={renaming.value}
                    autoFocus
                    onChange={(e) => {
                      setRenaming({ ...renaming, value: e.target.value });
                      setNameErr("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenaming(null);
                        setNameErr("");
                      }
                    }}
                    onBlur={() => {
                      // keep the box open while the name is not acceptable
                      if (!tagNameProblem(normalizeTagName(renaming.value), names.filter((n) => n !== renaming.from)) || normalizeTagName(renaming.value) === renaming.from)
                        commitRename();
                    }}
                  />
                ) : (
                  <button
                    key={t.name}
                    data-tag={t.name}
                    className={"tag-item" + (t.name === tag.name ? " sel" : "") + (applied.includes(t.name) ? " applied" : "")}
                    title={applied.includes(t.name) ? "지금 탭에 쓰이는 태그" : t.name}
                    onClick={() => {
                      setSel(t.name);
                      setRenaming(null);
                      setNameErr("");
                    }}
                    onDoubleClick={() => startRename(t.name)}
                  >
                    <span className="tag-name">{t.name}</span>
                    <span className="tag-count">{t.rules.length}</span>
                  </button>
                )
              )}
            </div>
            <div className="tags-name-error">{nameErr}</div>
            <div className="tags-side-actions">
              <button className="tb-btn" onClick={create}>
                ＋ 새 태그
              </button>
              <button className="tb-btn" disabled={isCommon} title={isCommon ? "common 은 이름을 바꿀 수 없습니다" : "이름 바꾸기 (더블클릭도 됨)"} onClick={() => startRename(tag.name)}>
                이름 바꾸기
              </button>
              <button className="tb-btn" onClick={duplicate}>
                복제
              </button>
              {isCommon ? (
                <button className="tb-btn" title="common 의 규칙을 모두 지웁니다 (태그는 남음)" onClick={clearCommon}>
                  비우기
                </button>
              ) : (
                <button className="tb-btn" onClick={remove}>
                  삭제
                </button>
              )}
            </div>
            {io.buttons}
          </div>
          <div className="tags-main">
            <div className="tags-where">
              <b>어디에 붙어 있나</b>
              {isCommon ? (
                <span className="tags-place">모든 로그 (붙일 필요 없음)</span>
              ) : places.length ? (
                places.map((p) => (
                  <span className="tags-place" key={p.kind + ":" + p.key}>
                    {placeLabel(p.kind, p.key)}
                  </span>
                ))
              ) : (
                <span className="tags-place dim">아직 어디에도 붙어 있지 않습니다</span>
              )}
            </div>
            <div className="chips-sub tags-rules-sub">
              「글자 그대로」는 넣은 글자가 들어간 곳 전부(공백 포함 가능), 「단어」는 앞뒤가 글자·숫자가 아닐 때만,
              「정규식」은 JavaScript 정규식 문법이고, 화면이 멈추지 않는 RE2 방식으로 찾습니다(앞보기·뒤돌아보기·역참조는 쓸 수 없음).
              같은 글자에 규칙 여럿이 걸리면 더 좁게 걸린 규칙(같으면 아래 규칙) 색이 보이고, 줄 배경은 위 규칙이 이깁니다. 다른 태그의 규칙은 common 보다 앞섭니다. 「줄만」은 태그에 걸린 줄만 보는 화면에서 이 규칙을 쓸지입니다.
            </div>
            <div className="rules-list">
              {rules.length === 0 && <div className="tags-place dim">규칙이 없습니다. ＋ 규칙 추가로 만드세요.</div>}
              {rules.map((r, i) => {
                const problem = ruleProblem(r);
                return (
                  <Fragment key={r.id}>
                  <div className={r.on ? "rule-row" : "rule-row off"}>
                    <input type="checkbox" checked={r.on} title="이 규칙 켜기" onChange={(e) => upd(r.id, { on: e.target.checked })} />
                    <input className="rule-label" value={r.label} placeholder="이름" onChange={(e) => upd(r.id, { label: e.target.value })} />
                    <input
                      className={problem ? "rule-pattern bad" : "rule-pattern"}
                      value={r.pattern}
                      placeholder={KIND_HINT[r.kind]}
                      title={problem ? `쓸 수 없음: ${ruleProblemReason(r)} — 이 규칙은 쓰이지 않습니다` : r.pattern}
                      data-problem={problem}
                      style={{ color: r.color }}
                      onChange={(e) => upd(r.id, { pattern: e.target.value })}
                    />
                    <select className="rule-kind" value={r.kind} onChange={(e) => upd(r.id, { kind: e.target.value as RuleKind })}>
                      {(Object.keys(KIND_LABEL) as RuleKind[]).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                    <label title="대소문자 구분">
                      <input type="checkbox" className="rule-case" checked={r.caseSensitive} onChange={(e) => upd(r.id, { caseSensitive: e.target.checked })} />
                      Aa
                    </label>
                    <input type="color" value={r.color} title="글자색" onChange={(e) => upd(r.id, { color: e.target.value })} />
                    <label title="줄 전체에 옅은 배경색">
                      <input type="checkbox" className="rule-line" checked={r.line} onChange={(e) => upd(r.id, { line: e.target.checked })} />
                      줄
                    </label>
                    <label title="줄만 보기에 씀 — 태그에 걸린 줄만 보는 화면에서 이 규칙에 걸린 줄을 보여 줍니다">
                      <input type="checkbox" className="rule-filter" checked={r.filter} onChange={(e) => upd(r.id, { filter: e.target.checked })} />
                      줄만
                    </label>
                    <button
                      className="mp-x"
                      title="위로"
                      disabled={i === 0}
                      onClick={() =>
                        setRules((prev) => {
                          const n = [...prev];
                          [n[i - 1], n[i]] = [n[i], n[i - 1]];
                          return n;
                        })
                      }
                    >
                      ↑
                    </button>
                    <button className="mp-x" title="이 규칙 지우기" onClick={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}>
                      🗑
                    </button>
                  </div>
                  {problem && <div className="rule-problem">쓸 수 없음: {ruleProblemReason(r)}</div>}
                  </Fragment>
                );
              })}
            </div>
            <div className="tags-main-actions">
              <button className="tb-btn rule-add" onClick={() => setRules((prev) => [...prev, newRule()])}>
                ＋ 규칙 추가
              </button>
              {isCommon && (
                <button
                  className="tb-btn"
                  onClick={() => {
                    if (window.confirm("common 규칙을 기본값으로 되돌릴까요? 추가하거나 고친 규칙은 사라집니다.")) setRules(() => DEFAULT_LOG_RULES);
                  }}
                >
                  기본값으로
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="chips-actions">
          <button className="tb-btn primary" onClick={onClose}>
            닫기
          </button>
        </div>
        {io.panels}
      </div>
    </div>
  );
}
