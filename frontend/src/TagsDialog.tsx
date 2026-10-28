import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_LOG_RULES, MAX_LINE_HEAD, lineHeadOf, ruleKey, ruleProblem, ruleProblemReason, type LogRule, type RuleKind } from "./logHighlight";
import { onRuleTrouble, ruleTrouble, troubleText } from "./ruleHealth";
import {
  COMMON,
  normalizeTagName,
  placesOf,
  repairTagName,
  tagNameProblem,
  type TagStore,
} from "./logTags";
import { useTagsIO } from "./TagsIO";
import { pushOp, rebaseDraft, sameTagStore, type DraftOp, type RuleEdit } from "./tagDraft";

// The log colour tag window (was the 「로그 색 규칙」 dialog): tag list on the
// left, the selected tag's rules on the right.
//
// Changes made here are a draft (tagDraft.ts) until 적용 (write, stay open) or
// 확인 (write, close); 닫기 / Esc / × throw the draft away without asking, and a
// click outside the window does nothing (10-28, testers). The editors' colours
// change only when the draft is written. Saves made outside meanwhile (tree
// 「태그 지정」, 「이 글자로 규칙」, import from this window) are kept: the draft
// is laid again over the store each time it changes.

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
  return `🏷 이름이 「${key}」 인 파일과 그 회전 파일 (맨 위 폴더 밖)`;
}

interface Props {
  store: TagStore; // the tags as saved (the app's store)
  onChange: (s: TagStore) => void; // set the store at once (import / undo / restore, TagsIO)
  // 적용 / 확인: make `next` the store and write it now ("" = saved, else why not)
  onApply: (next: TagStore) => Promise<string>;
  onClose: () => void;
  initial: string; // tag selected when the window opens
  applied: string[]; // tags applied to the current tab (marked in the list)
  notice: string; // save problem / read-only notice ("" = none)
  // Write the tags now (optionally `next` first): "" = saved (or nothing to
  // save), otherwise why not. Used around an import (TagsIO.tsx).
  onSaveNow: (next?: TagStore) => Promise<string>;
}

interface Draft {
  base: TagStore; // the saved store the edits are laid over
  ops: DraftOp[]; // the edits (tagDraft.ts)
  view: TagStore; // base + ops: what the window shows and 적용 writes
}

export default function TagsDialog({ store, onChange, onApply, onClose, initial, applied, notice, onSaveNow }: Props) {
  const [draft, setDraft] = useState<Draft>(() => ({ base: store, ops: [], view: store }));
  // notes on edits that no longer fit after a save outside the window
  const [notes, setNotes] = useState<string[]>([]);
  const [applyMsg, setApplyMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [applying, setApplying] = useState(false);
  const [sel, setSel] = useState<string>(store.tags.some((t) => t.name === initial) ? initial : COMMON);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  let d = draft;
  if (d.base !== store) {
    // saved outside the window (or by an import here): lay the edits over it
    const r = rebaseDraft(store, d.ops);
    d = { base: store, ops: r.ops, view: r.store };
    setDraft(d);
    if (r.notes.length) setNotes((n) => [...n, ...r.notes.filter((x) => !n.includes(x))]);
    if (r.follow.size) {
      // the window's own tag got another name: keep it selected (not the newcomer)
      const to = r.follow.get(selRef.current);
      if (to !== undefined) setSel(to);
      setRenaming((x) => (x && r.follow.has(x.from) ? { ...x, from: r.follow.get(x.from)! } : x));
    }
  }
  const draftRef = useRef(d);
  draftRef.current = d;
  const storeRef = useRef(store);
  storeRef.current = store;
  const view = d.view;
  const dirty = useMemo(() => !sameTagStore(view, store), [view, store]);
  // one more edit, laid over what the window shows now
  const edit = (op: DraftOp) => {
    setApplyMsg(null);
    setDraft((p) => {
      const r = rebaseDraft(p.view, [op]);
      return { base: p.base, ops: r.ops.reduce(pushOp, p.ops), view: r.store };
    });
  };

  const names = view.tags.map((t) => t.name);
  const [nameErr, setNameErr] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const tag = view.tags.find((t) => t.name === sel) ?? view.tags[0];
  const rules = tag.rules;
  const isCommon = tag.name === COMMON;
  // export / import / backups (TagsIO.tsx): buttons, result band, small windows.
  // Export writes what the window shows; import / restore work on the saved
  // store and save at once (the draft is laid over the result).
  const io = useTagsIO({ store, view, dirty, onChange, onSaveNow, current: tag.name, select: setSel });
  // rules found slow while this run of the app used them (ruleHealth.ts)
  const [, setTrouble] = useState(0);
  useEffect(() => onRuleTrouble(() => setTrouble((n) => n + 1)), []);
  const slowCount = view.tags.reduce((n, t) => n + t.rules.filter((r) => ruleTrouble(ruleKey(r)).length).length, 0);
  // rules in the window that can't be used: saved as they are and not coloured
  // (the same as before the draft)
  const badCount = useMemo(() => view.tags.reduce((n, t) => n + t.rules.filter((r) => r.on && ruleProblem(r)).length, 0), [view]);

  // 적용 (close = false) / 확인 (close = true). A failed write leaves the store
  // as applied for this run (like any failed tag save: retried on the next
  // change) and keeps the window open with the reason.
  const apply = async (close: boolean) => {
    if (applying) return;
    let cur = draftRef.current;
    if (cur.base !== storeRef.current) {
      const r = rebaseDraft(storeRef.current, cur.ops);
      cur = { base: storeRef.current, ops: r.ops, view: r.store };
    }
    if (sameTagStore(cur.view, cur.base)) {
      if (close) onClose();
      return;
    }
    const next = cur.view;
    setDraft({ base: next, ops: [], view: next });
    setNotes([]);
    setApplyMsg(null);
    setApplying(true);
    let err = "";
    try {
      err = await onApply(next);
    } catch (e) {
      err = String(e);
    } finally {
      setApplying(false);
    }
    if (err)
      setApplyMsg({
        text: `적용했지만 tags.json 에 저장하지 못했습니다: ${err.replace(/^(Error: )+/, "").replace(/^\[[A-Z_]+\] /, "")} — 이번 실행 동안은 이대로 쓰이고, 다음에 태그를 바꿀 때 다시 저장해 봅니다.`,
        bad: true,
      });
    else if (close) onClose();
    else setApplyMsg({ text: "적용했습니다.", bad: false });
  };

  // Esc closes the window (throwing the draft away) wherever the focus is (not
  // while renaming a tag); with one of TagsIO's small windows up, TagsIO closes
  // only that one first.
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

  const now = () => new Date().toISOString();
  const ruleEdit = (e: RuleEdit) => edit({ k: "rules", tag: tag.name, e, at: now() });
  const upd = (id: string, patch: Partial<LogRule>) => ruleEdit({ k: "upd", id, patch });

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
    edit({ k: "rename", from: renaming.from, to: v, at: now() });
    if (sel === renaming.from) setSel(v);
    setRenaming(null);
    setNameErr("");
  };
  const create = () => {
    const name = repairTagName("새 태그", names);
    edit({ k: "add", name, rules: [], at: now() });
    setSel(name);
    setNameErr("");
    setRenaming({ from: name, value: name });
  };
  const duplicate = () => {
    const name = repairTagName(`${tag.name} 복사`, names);
    edit({ k: "add", name, rules: tag.rules.map((r) => ({ ...r })), at: now() });
    setSel(name);
  };
  const remove = () => {
    const where = placesOf(view, tag.name).length;
    const msg =
      `「${tag.name}」 태그를 지울까요? 규칙 ${tag.rules.length}개가 사라집니다.` +
      (where ? `\n붙어 있던 ${where}곳에서도 빠집니다.` : "");
    if (!window.confirm(msg)) return;
    edit({ k: "delete", name: tag.name });
    setSel(COMMON);
  };
  const clearCommon = () => {
    if (!rules.length) return;
    if (window.confirm(`common 태그의 규칙 ${rules.length}개를 모두 지울까요? (common 은 모든 로그에 쓰이는 태그라 지울 수 없고 비우기만 됩니다)`))
      ruleEdit({ k: "replace", ids: rules.map((r) => r.id), rules: [] });
  };

  const places = placesOf(view, tag.name);

  return (
    // a click outside does not close the window (the draft would be lost)
    <div className="chips-overlay">
      <div className="keys-dialog rules-dialog tags-dialog" role="dialog" aria-label="로그 색 태그">
        <div className="chips-title">🏷 로그 색 태그</div>
        <button className="mp-x tags-x" title="닫기 (적용 안 한 변경은 버림, Esc)" onClick={onClose}>
          ✕
        </button>
        <div className="chips-sub">
          태그는 로그 색 규칙 묶음입니다. common 은 모든 로그에, 다른 태그는 붙인 곳의 로그에만 쓰입니다. 같은 글자에 두 규칙이 걸리면
          태그 쪽 색이 이깁니다. 태그 이름은 대소문자를 구분합니다(collector 와 Collector 는 다른 태그).
        </div>
        {notice && <div className="tags-notice">{notice}</div>}
        {notes.length > 0 && (
          <div className="tags-draft-notes">
            <span>
              창이 열린 동안 창 밖에서 태그가 바뀌어(태그 지정·가져오기 등) 적용 안 한 변경을 그 위에 다시 얹었습니다.
              {notes.map((n, i) => (
                <span key={i} className="tags-draft-note">
                  {" "}
                  {n}
                </span>
              ))}
            </span>
            <button className="mp-x" title="닫기" onClick={() => setNotes([])}>
              ✕
            </button>
          </div>
        )}
        {io.banner}
        <div className="tags-body">
          <div className="tags-side">
            <div className="tags-list">
              {view.tags.map((t) =>
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
              {slowCount > 0 && (
                <div className="rule-problem rule-slow-sum">
                  🐢 이번 실행에서 느렸던 규칙 {slowCount}개 (태그마다 규칙 줄 아래에 표시) — 정규식을 단순하게 하면 빨라집니다.
                </div>
              )}
              {rules.map((r, i) => {
                const problem = ruleProblem(r);
                const slow = ruleTrouble(ruleKey(r));
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
                    {r.line && (
                      <input
                        type="number"
                        className="rule-head"
                        min={0}
                        max={MAX_LINE_HEAD}
                        value={lineHeadOf(r) || ""}
                        placeholder="어디든"
                        title="줄 배경 자리: 줄 앞 이 글자 수 안에서 걸릴 때만 줄 배경 (예: 60 = 로그 레벨 자리). 비우면 어디서 걸려도 줄 배경. 글자색과 「줄만」은 이 값과 상관없음"
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          upd(r.id, { lineHead: Number.isFinite(v) && v >= 1 ? Math.min(MAX_LINE_HEAD, v) : undefined });
                        }}
                      />
                    )}
                    <label title="줄만 보기에 씀 — 태그에 걸린 줄만 보는 화면에서 이 규칙에 걸린 줄을 보여 줍니다">
                      <input type="checkbox" className="rule-filter" checked={r.filter} onChange={(e) => upd(r.id, { filter: e.target.checked })} />
                      줄만
                    </label>
                    <button
                      className="mp-x"
                      title="위로"
                      disabled={i === 0}
                      onClick={() => ruleEdit({ k: "up", id: r.id })}
                    >
                      ↑
                    </button>
                    <button className="mp-x" title="이 규칙 지우기" onClick={() => ruleEdit({ k: "del", id: r.id })}>
                      🗑
                    </button>
                  </div>
                  {problem && <div className="rule-problem">쓸 수 없음: {ruleProblemReason(r)}</div>}
                  {!problem && slow.length > 0 && <div className="rule-problem rule-slow">🐢 느림: {troubleText(slow)}</div>}
                  </Fragment>
                );
              })}
            </div>
            <div className="tags-main-actions">
              <button className="tb-btn rule-add" onClick={() => ruleEdit({ k: "push", rule: newRule() })}>
                ＋ 규칙 추가
              </button>
              {isCommon && (
                <button
                  className="tb-btn"
                  onClick={() => {
                    if (window.confirm("common 규칙을 기본값으로 되돌릴까요? 추가하거나 고친 규칙은 사라집니다."))
                      ruleEdit({ k: "replace", ids: rules.map((r) => r.id), rules: DEFAULT_LOG_RULES });
                  }}
                >
                  기본값으로
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="chips-actions tags-actions">
          <span className={"tags-dirty" + (dirty ? " on" : "")} aria-live="polite">
            {dirty ? "● 적용 안 한 변경 있음" + (badCount ? ` · 쓸 수 없는 규칙 ${badCount}개는 저장돼도 칠하지 않음` : "") : ""}
          </span>
          {applyMsg && <span className={"tags-apply-msg" + (applyMsg.bad ? " bad" : "")}>{applyMsg.text}</span>}
          <button
            className="tb-btn tags-apply"
            disabled={!dirty || applying || io.blocking}
            title={dirty ? "고친 내용을 저장하고 편집기 색에 반영합니다 (창은 열린 채)" : "적용할 변경이 없습니다"}
            onClick={() => void apply(false)}
          >
            적용
          </button>
          <button className="tb-btn primary tags-ok" disabled={applying || io.blocking} title="고친 내용을 저장하고 창을 닫습니다" onClick={() => void apply(true)}>
            확인
          </button>
          <button className="tb-btn tags-close" title="적용 안 한 변경은 버리고 닫습니다 (Esc)" onClick={onClose}>
            닫기
          </button>
        </div>
        {io.panels}
      </div>
    </div>
  );
}
