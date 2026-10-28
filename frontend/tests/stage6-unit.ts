// Unit tests of stage 6: common default rules (revision 2) and bringing an old
// common up to them, ANSI codes, the level-column line tint, 「이 글자로 규칙」,
// slow-rule notes, lineHead in import/compare.
//   node tests/run-unit.cjs   (runs every tests/*-unit.ts)
import {
  compileRule,
  DEFAULT_LOG_RULES,
  DEFAULT_LOG_RULES_V1,
  DEFAULTS_REV,
  LEVEL_HEAD,
  normalizeRule,
  paintLine,
  resolvePaint,
  ruleKey,
  stripAnsi,
  type LogRule,
} from "../src/logHighlight";
import { upgradeCommonDefaults } from "../src/commonDefaults";
import { COMMON, emptyAssign, migratedStore, normalizeTagStore, serializeTags, type TagStore } from "../src/logTags";
import { importRule, ruleDiff, sameRules } from "../src/logTagsIO";
import { RowPainter, noteSlowFilterRules } from "../src/lineView";
import { addTextRule, defaultRuleTag, sameRuleIn, selectionForRule } from "../src/textRule";
import { clearRuleTrouble, noteRuleTrouble, ruleTrouble, troubleText } from "../src/ruleHealth";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ESC = "\x1b";

// ---- the default rules on real log lines (samples from the Bromo bundle) -------------
const byId = (id: string) => DEFAULT_LOG_RULES.find((r) => r.id === id)!;
const matches = (r: LogRule, line: string) => {
  const m = compileRule(r)!;
  const vis = stripAnsi(line)?.text ?? line;
  const f = m.ranges(vis);
  const out: string[] = [];
  for (let k = 0; k < f.length; k += 2) out.push(vis.slice(f[k], f[k + 1]));
  return out;
};
const time = byId("time");
const timeCases: [string, string][] = [
  ["10-22 00:00:03 ERROR JedisSentinelPool.run : Lost connection", "10-22 00:00:03"], // liz modules
  ["2026.10.21 00:13:45.488108 [ 15314 ] {e3e4a6c0} <Debug> liz.checkvalue", "2026.10.21 00:13:45.488108"], // clickhouse
  ["[2026-10-22 00:07:36,193] DEBUG [Controller id=1] Broker 5", "2026-10-22 00:07:36,193"], // kafka
  ["2026-10-21 23:41:12,974 [myid:] - INFO  [main:o.a.z.s.q.QuorumPeerConfig@177]", "2026-10-21 23:41:12,974"], // zookeeper
  ["2026-10-18T23:00:00+0700 server01 Keepalived_vrrp[2886]: (VI_2) Entering MASTER STATE", "2026-10-18T23:00:00"], // journal
  ["Oct 18 23:00:00 server01 systemd[1]: Starting system activity", "Oct 18 23:00:00"], // syslog
  ["2026-10-20  0:49:54 553659 [Warning] Aborted connection", "2026-10-20  0:49:54"], // mariadb
  ["2843:S 18 Oct 2026 23:00:48.096 * 10000 changes in 60 seconds", "18 Oct 2026 23:00:48.096"], // redis
  ["2026-10-22 05:21:54.991 ERROR 218425 --- [MasterListener]", "2026-10-22 05:21:54.991"], // spring
  ["(2026-10-19 21:30:58): [kcm] [server_setup]", "2026-10-19 21:30:58"], // sssd
];
for (const [line, want] of timeCases) ok(`시각: ${want}`, eq(matches(time, line), [want]), matches(time, line));
ok("시각: 버전 번호·IP 는 아님", matches(time, "v10.2.37 10.10.60.10:5000 build 12-34").length === 0);
ok("시각 규칙은 「줄만」 꺼짐(거의 모든 줄)", time.filter === false);

// error / error-ck / fail
ok("오류(레벨) = 대문자 레벨 낱말만 (failed·Exception·(unknown error) 아님)", eq(matches(byId("error"), "INFO x has failed: NullPointerException (unknown error) ERROR"), ["ERROR"]));
ok("오류·실패 낱말 = v1.2.0 오류 낱말 전부(대소문자 무시)", eq(matches(byId("fail"), "INFO x has failed: NullPointerException (unknown error) ERROR"), ["failed", "NullPointerException", "error", "ERROR"]));
ok("괄호 레벨: <Error>·[error] (대소문자 구분)", eq(matches(byId("error-ck"), "<Error> <error> <Fatal> <Critical> [error] [ERROR] [crit] (error)"), ["<Error>", "<Fatal>", "<Critical>", "[error]", "[crit]"]));
ok("오류·실패 낱말 패턴 = v1 오류 패턴", byId("fail").pattern === DEFAULT_LOG_RULES_V1[0].pattern && !byId("fail").caseSensitive);
ok("오류의 줄 배경 자리 = 60", byId("error").lineHead === LEVEL_HEAD && LEVEL_HEAD === 60 && byId("error").line);
ok("실패·예외는 줄 배경 없음", byId("fail").line === false);
ok("error-ck 는 줄만 끔(오류가 이미 걸러 줌)", byId("error-ck").filter === false && byId("error-ck").line);
// v1 error ≡ error ∪ fail (what 「줄만」 keeps did not change)
{
  const v1 = compileRule(DEFAULT_LOG_RULES_V1[0])!;
  const lines = ["ERROR x", "x FAILED y", "Failure", "NullPointerException", "crit!", "EMERGENCY", "info", "xerror", "fails", "<Error>", "error: PAM", "PANIC now", "SEVERE", "ok"];
  const both = lines.map((l) => v1.ranges(l).length > 0 === (compileRule(byId("error"))!.ranges(l).length > 0 || compileRule(byId("fail"))!.ranges(l).length > 0));
  ok("v1 오류 규칙에 걸리는 줄 = 새 오류 ∪ 실패·예외", both.every(Boolean), lines.filter((_, i) => !both[i]));
}

// ---- line tint only in the level column ---------------------------------------------
{
  const layers = [DEFAULT_LOG_RULES];
  const p = new RowPainter(layers);
  const tintOf = (line: string) => p.paint(line).tint;
  const RED = "#ff6b6b";
  ok("레벨 자리 ERROR → 줄 배경", tintOf("10-22 00:00:03 ERROR JedisSentinelPool.run : Lost") === RED);
  ok("spring ERROR(24자) → 줄 배경", tintOf("2026-10-22 05:21:54.991 ERROR 218425 --- [x]") === RED);
  ok("kafka ERROR → 줄 배경", tintOf("[2026-10-22 00:07:36,193] ERROR [Controller id=1] boom") === RED);
  ok("INFO 줄의 failed·(unknown error) → 줄 배경 없음", tintOf("2026-10-20 10:00:00 INFO  Sync has failed (unknown error)") === "");
  ok("INFO 줄의 failed to connect → 줄 배경 없음", tintOf("10-22 00:00:03 INFO  Redis.run : failed to connect") === "");
  const inf = p.paint("10-22 00:00:03 INFO  Redis.run : failed to connect (unknown error)");
  ok("…하지만 failed·error 글자는 빨갛게", inf.spans.filter((s) => s.color === RED).length === 2, inf.spans);
  ok("mariadb [ERROR] → 줄 배경", tintOf("2026-10-20  0:49:54 0 [ERROR] InnoDB: boom") === RED);
  ok("nginx [error](60자 뒤) → 줄 배경", tintOf("x".repeat(70) + " [error] 123#0: upstream timed out") === RED);
  ok("clickhouse {} <Error>(40자 안) → 줄 배경", tintOf("2026.10.22 00:10:24.711595 [ 133055 ] {} <Error> virtual bool") === RED);
  ok("INFO 줄의 I/O exception → 줄 배경 없음", tintOf("INFO: I/O exception (java.net.NoRouteToHostException) caught") === "");
  const longPrefix = "2026-10-20 10:00:00 INFO  " + "x".repeat(60) + " ERROR in body";
  ok("60자 뒤의 ERROR → 줄 배경 없음", tintOf(longPrefix) === "");
  const sp = p.paint(longPrefix).spans.find((s) => longPrefix.slice(s.from, s.to) === "ERROR");
  ok("60자 뒤의 ERROR 도 글자색은 칠함", !!sp && sp.color === RED, sp);
  const ck = "2026.10.22 00:10:52.033122 [ 132580 ] {BgSchPool::4dfe25b9-236d-44fd-9909-c57fda5770d0} <Error> liz.checkvalue";
  ok("ClickHouse <Error>(90자 뒤) → 줄 배경 (error-ck)", tintOf(ck) === RED, ck.indexOf("<Error>"));
  ok("장애 신호는 어디서든 줄 배경", tintOf("x".repeat(100) + " Killed process 123") === "#ff9e64");
  // resolvePaint: head counts from the first match
  ok("resolvePaint: 첫 일치가 head 안 → 배경", resolvePaint(100, [[10, 15, 80, 85]], [0], [true], [60]).tint === 0);
  ok("resolvePaint: 첫 일치가 head 밖 → 배경 없음", resolvePaint(100, [[70, 75]], [0], [true], [60]).tint === -1);
  ok("resolvePaint: head 없음(옛 호출) → 어디든", resolvePaint(100, [[70, 75]], [0], [true]).tint === 0);
  ok("resolvePaint: 다음 줄 규칙이 배경을 받음", resolvePaint(100, [[70, 75], [3, 4]], [0, 0], [true, true], [60, 0]).tint === 1);
}

// ---- ANSI ---------------------------------------------------------------------------------
{
  const line = `${ESC}[31m2026-10-20 09:32:56${ESC}[0m [${ESC}[1;31mWARN${ESC}[0m] slow`;
  const a = stripAnsi(line)!;
  ok("stripAnsi: 보이는 글자", a.text === "2026-10-20 09:32:56 [WARN] slow", a.text);
  ok("stripAnsi: 코드 자리", eq(a.codes, [0, 5, 24, 28, 30, 37, 41, 45]), a.codes);
  ok("stripAnsi: 자리 맞춤(raw)", a.raw[0] === 5 && line[a.raw[a.text.indexOf("WARN")]] === "W" && a.raw[a.text.length] === line.length);
  ok("stripAnsi: 코드 없으면 null", stripAnsi("plain") === null && stripAnsi(`x${ESC}y`) === null);
  ok("stripAnsi: 끝나지 않은 코드는 남김", stripAnsi(`half ${ESC}[31`) === null);
  ok("stripAnsi: ESC[31 W 는 통째로 코드(끝 글자 W)", stripAnsi(`seq ${ESC}[31 WARN`)!.text === "seq ARN");
  ok("stripAnsi: 커서 코드(ESC[K·ESC[?25l)도", stripAnsi(`a${ESC}[Kb${ESC}[?25lc`)!.text === "abc");
  const p = new RowPainter([DEFAULT_LOG_RULES]);
  const pt = p.paint(line);
  const warn = pt.spans.find((s) => line.slice(s.from, s.to) === "WARN");
  ok("ANSI 줄: WARN 을 경고 색으로", !!warn && warn.color === "#e5c07b" && !warn.dim, pt.spans);
  const tm = pt.spans.find((s) => line.slice(s.from, s.to) === "2026-10-20 09:32:56");
  ok("ANSI 줄: 시각을 칠함 (m2026 앞 단어 경계 문제 없음)", !!tm && tm.color === "#56b6c2", pt.spans);
  const dims = pt.spans.filter((s) => s.dim).map((s) => line.slice(s.from, s.to));
  ok("ANSI 줄: 코드 4개는 흐리게", eq(dims, [`${ESC}[31m`, `${ESC}[0m`, `${ESC}[1;31m`, `${ESC}[0m`]), dims);
  ok("ANSI 줄: 겹치는 칸 없음·순서대로", pt.spans.every((s, i) => i === 0 || s.from >= pt.spans[i - 1].to));
  // a code inside a match: the match is coloured on both sides, the code is faint (and coloured)
  const r: LogRule = { id: "k", on: true, label: "", pattern: "kafka rebalance", kind: "text", caseSensitive: false, color: "#123456", line: false, filter: true };
  const l2 = `kafka${ESC}[0m rebalance`;
  const pp = paintLine(l2, (t) => [compileRule(r)!.ranges(t)], [0], [false]);
  ok("ANSI: 코드를 사이에 둔 글자도 한 규칙으로", eq(pp.spans, [0, l2.length, 0]) && eq(pp.dim, [5, 9]), pp);
  const p2 = new RowPainter([[r]]).paint(l2);
  ok("ANSI: 줄만 보기 칸은 코드 앞뒤로 나눠 칠함", eq(p2.spans.map((s) => [s.from, s.to, !!s.dim]), [[0, 5, false], [5, 9, true], [9, l2.length, false]]), p2.spans);
}

// ---- common: bringing revision 1 up to revision 2 ---------------------------------------
const v1Store = (rules: LogRule[], extra: Partial<TagStore> = {}): TagStore => ({
  version: 1,
  tags: [
    { name: COMMON, rules, updated: "" },
    { name: "collector", rules: [{ ...DEFAULT_LOG_RULES_V1[0], id: "c1", pattern: "rebalance", kind: "text" }], updated: "" },
  ],
  assign: emptyAssign(),
  ...extra,
});
{
  const up = upgradeCommonDefaults(v1Store(DEFAULT_LOG_RULES_V1), "T")!;
  ok("손대지 않은 v1 → v2 그대로", eq(up.store.tags[0].rules, DEFAULT_LOG_RULES), up.store.tags[0].rules.map((r) => r.id));
  ok("revision 기록", up.store.defaults === DEFAULTS_REV && DEFAULTS_REV === 2);
  ok("다른 태그는 그대로", eq(up.store.tags[1], v1Store([]).tags[1]));
  ok("알림 문구: 바꾼 것", /새 판/.test(up.note) && up.kept.length === 0 && eq(up.replaced, ["오류", "시각"]), up);
  ok("updated 시각 갱신", up.store.tags[0].updated === "T");
  ok("한 번만: 다시 부르면 null", upgradeCommonDefaults(up.store) === null);
}
{
  // the user changed 오류's colour, switched 시각 off, turned 오류's 줄만 off, added a rule in between
  const mine: LogRule = { id: "u1", on: true, label: "내 규칙", pattern: "timeout", kind: "text", caseSensitive: false, color: "#00ff00", line: false, filter: true };
  const rules = DEFAULT_LOG_RULES_V1.map((r) => (r.id === "error" ? { ...r, color: "#ff0000" } : r.id === "time" ? { ...r, on: false } : r));
  rules.splice(2, 0, mine);
  const up = upgradeCommonDefaults(v1Store(rules), "T")!;
  const ids = up.store.tags[0].rules.map((r) => r.id);
  ok("고친 오류는 그대로(덮어쓰지 않음)", up.store.tags[0].rules[0].color === "#ff0000" && up.store.tags[0].rules[0].pattern === DEFAULT_LOG_RULES_V1[0].pattern);
  ok("고친 기본 규칙 이름이 알림에", eq(up.kept, ["오류"]) && /직접 고친 기본 규칙 1개/.test(up.note), up.note);
  ok("사용자 규칙 자리 그대로", ids[2] === "u1" && eq(ids, ["error", "warn", "u1", "info", "debug", "time", "mk119"]), ids);
  const t = up.store.tags[0].rules.find((r) => r.id === "time")!;
  ok("꺼 둔 시각은 새 패턴으로 바뀌되 꺼진 채", t.pattern === time.pattern && t.on === false, t);
}
{
  // untouched error with 줄만 off and off: the three new rules follow
  const rules = DEFAULT_LOG_RULES_V1.map((r) => (r.id === "error" ? { ...r, on: false, filter: false } : r));
  const up = upgradeCommonDefaults(v1Store(rules))!;
  const [e, ck, f] = up.store.tags[0].rules;
  ok("오류 켜기·줄만 선택이 새 규칙 3개로", e.id === "error" && !e.on && !e.filter && ck.id === "error-ck" && !ck.on && !ck.filter && f.id === "fail" && !f.on && !f.filter, [e, ck, f]);
}
{
  // deleted error stays deleted; a user rule already called "fail" keeps its id
  const rules = DEFAULT_LOG_RULES_V1.filter((r) => r.id !== "error");
  const up = upgradeCommonDefaults(v1Store(rules))!;
  ok("지운 오류는 다시 안 생김", !up.store.tags[0].rules.some((r) => r.id === "error" || r.id === "fail"));
  const mine: LogRule = { id: "fail", on: true, label: "x", pattern: "x", kind: "text", caseSensitive: false, color: "#00ff00", line: false, filter: true };
  const up2 = upgradeCommonDefaults(v1Store([mine, ...DEFAULT_LOG_RULES_V1]))!;
  const fails = up2.store.tags[0].rules.filter((r) => r.pattern === byId("fail").pattern);
  ok("id 겹치면 새 id (사용자 규칙 id 그대로)", up2.store.tags[0].rules[0].id === "fail" && fails.length === 1 && fails[0].id !== "fail", up2.store.tags[0].rules.map((r) => r.id));
  const all = up2.store.tags[0].rules.map((r) => r.id);
  ok("id 중복 없음", new Set(all).size === all.length, all);
}
{
  // a v1 rule matched by content, whatever its id (an imported common)
  const rules = DEFAULT_LOG_RULES_V1.map((r) => ({ ...r, id: "imp-" + r.id }));
  const up = upgradeCommonDefaults(v1Store(rules))!;
  ok("id 가 달라도 내용이 v1 이면 바꿈", up.store.tags[0].rules[0].id === "imp-error" && up.store.tags[0].rules[0].pattern === byId("error").pattern && up.store.tags[0].rules.length === 8);
  // old session (v1.2.0 shape: regex true/false, no kind/filter)
  const legacy = DEFAULT_LOG_RULES_V1.map(({ kind, filter, ...r }) => ({ ...r, regex: true }));
  const m = migratedStore(legacy);
  ok("옛 세션 이전 = revision 표시 없음", m.defaults === undefined);
  const up2 = upgradeCommonDefaults(m)!;
  ok("옛 세션 규칙도 새 판으로", eq(up2.store.tags[0].rules.map((r) => r.id), DEFAULT_LOG_RULES.map((r) => r.id)), up2.store.tags[0].rules.map((r) => r.id));
  ok("새로 시작(세션 없음) = 이미 새 판", migratedStore(undefined).defaults === DEFAULTS_REV && upgradeCommonDefaults(migratedStore(undefined)) === null);
  ok("저장·읽기에 revision 유지", normalizeTagStore(JSON.parse(serializeTags(up2.store))).defaults === DEFAULTS_REV);
  ok("revision 없는 파일 = 1 로 읽음", normalizeTagStore(JSON.parse(serializeTags(v1Store(DEFAULT_LOG_RULES_V1)))).defaults === undefined);
  ok("비운 common·사용자 규칙만 → 아무것도 안 함(tags.json 다시 쓰지 않음)", upgradeCommonDefaults(v1Store([])) === null && upgradeCommonDefaults(v1Store([{ ...DEFAULT_LOG_RULES_V1[0], id: "z", pattern: "mine" }])) === null);
  ok("v1 과 v2 가 같은 기본 규칙(경고 등)만 → 아무것도 안 함", upgradeCommonDefaults(v1Store(DEFAULT_LOG_RULES_V1.filter((r) => r.id === "warn" || r.id === "mk119"))) === null);
  const keptOnly = upgradeCommonDefaults(v1Store([{ ...DEFAULT_LOG_RULES_V1[4], color: "#000000" }]))!;
  ok("고친 기본 규칙만 → 알리고 revision 기록(다음엔 안 알림)", !!keptOnly && keptOnly.replaced.length === 0 && eq(keptOnly.kept, ["시각"]) && keptOnly.store.defaults === DEFAULTS_REV && upgradeCommonDefaults(keptOnly.store) === null);
  ok("common 없는 파일 = 새 기본 + revision",normalizeTagStore({ tags: [{ name: "x", rules: [] }] }).defaults === DEFAULTS_REV);
  ok("이상한 revision 값은 버림", normalizeTagStore({ tags: [], defaults: "2" }).defaults === DEFAULTS_REV); // no common → current
  ok("이상한 revision 값(0)은 1 로", normalizeTagStore({ tags: [{ name: COMMON, rules: [] }], defaults: 0 }).defaults === undefined);
}

// ---- lineHead in rule data -----------------------------------------------------------------
{
  ok("normalizeRule 이 lineHead 유지", normalizeRule({ pattern: "x", lineHead: 60 })!.lineHead === 60);
  ok("normalizeRule: 잘못된 lineHead 버림", normalizeRule({ pattern: "x", lineHead: 0 })!.lineHead === undefined && normalizeRule({ pattern: "x", lineHead: 2.5 })!.lineHead === undefined && normalizeRule({ pattern: "x", lineHead: 99999 })!.lineHead === undefined);
  const imp = importRule({ pattern: "x", line: true, lineHead: 60 });
  ok("가져오기가 lineHead 유지", "rule" in imp && imp.rule.lineHead === 60);
  const a = DEFAULT_LOG_RULES.slice(0, 1);
  const b = [{ ...a[0], lineHead: undefined }];
  ok("lineHead 만 달라도 「다름」", !sameRules(a, b) && sameRules(a, [{ ...a[0] }]));
  const d = ruleDiff(a, b);
  ok("차이 목록에 줄 배경 자리", d.changed.length === 1 && /줄 배경 자리 줄 앞 60자 안 → 어디든/.test(d.changed[0]), d);
}

// ---- 「이 글자로 로그 색 규칙 만들기…」 --------------------------------------------------
{
  ok("고른 글자 → 패턴", eq(selectionForRule("kafka rebalance"), { pattern: "kafka rebalance", problem: "" }));
  ok("앞뒤 공백 버림", selectionForRule("  ERROR ").pattern === "ERROR");
  ok("줄 끝 줄바꿈 하나는 괜찮음", selectionForRule("ERROR\n").pattern === "ERROR");
  ok("여러 줄 거부", /여러 줄/.test(selectionForRule("a\nb").problem));
  ok("빈 선택 거부", !!selectionForRule("").problem && !!selectionForRule("   ").problem);
  ok("1000자 넘으면 거부", !!selectionForRule("x".repeat(1001)).problem && !selectionForRule("x".repeat(1000)).problem);
  ok("ANSI 코드는 빼고", selectionForRule(`${ESC}[1;31mWARN${ESC}[0m`).pattern === "WARN");
  ok("기본 태그 = 이 파일에 붙은 태그", defaultRuleTag(["common", "collector", "admin"]) === "collector");
  ok("붙은 태그 없으면 common", defaultRuleTag(["common"]) === "common");
  const st = v1Store(DEFAULT_LOG_RULES);
  const d = { pattern: "Sleeping 5000ms", kind: "text" as const, caseSensitive: false, color: "#00aaff", line: true, label: "" };
  const r1 = addTextRule(st, "collector", d, "T")!;
  const t1 = r1.store.tags[1];
  ok("태그 끝에 붙음(아래 규칙이 이김)", !r1.updated && t1.rules.length === 2 && t1.rules[1].pattern === "Sleeping 5000ms" && t1.updated === "T");
  ok("새 규칙: 글자 그대로·줄만 켬·고른 색·줄 배경", t1.rules[1].kind === "text" && t1.rules[1].filter && t1.rules[1].on && t1.rules[1].color === "#00aaff" && t1.rules[1].line);
  ok("다른 태그는 그대로", eq(r1.store.tags[0], st.tags[0]));
  ok("같은 규칙 찾기", !!sameRuleIn(r1.store, "collector", d) && !sameRuleIn(r1.store, "collector", { ...d, caseSensitive: true }));
  const r2 = addTextRule(r1.store, "collector", { ...d, color: "#ffffff", line: false }, "T2")!;
  ok("같은 규칙이면 새로 만들지 않고 색·줄 배경만", r2.updated && r2.store.tags[1].rules.length === 2 && r2.store.tags[1].rules[1].color === "#ffffff" && !r2.store.tags[1].rules[1].line && r2.store.tags[1].rules[1].id === t1.rules[1].id);
  ok("없는 태그 → null", addTextRule(st, "nope", d) === null && addTextRule(st, "collector", { ...d, pattern: "" }) === null);
  const off = { ...r1.store, tags: r1.store.tags.map((t) => (t.name === "collector" ? { ...t, rules: t.rules.map((r) => ({ ...r, on: false })) } : t)) };
  ok("꺼진 같은 규칙은 다시 켬", addTextRule(off, "collector", d)!.store.tags[1].rules[1].on === true);
}

// ---- slow-rule notes (tag window) ------------------------------------------------------------
{
  clearRuleTrouble();
  const r = DEFAULT_LOG_RULES[0];
  ok("처음엔 없음", ruleTrouble(ruleKey(r)).length === 0);
  noteSlowFilterRules([r, DEFAULT_LOG_RULES[3]], [1]);
  ok("줄만 느린 규칙 기록(번호 → 규칙)", eq(ruleTrouble(ruleKey(DEFAULT_LOG_RULES[3])), ["filter"]) && ruleTrouble(ruleKey(r)).length === 0);
  noteRuleTrouble(ruleKey(r), "editor");
  noteRuleTrouble(ruleKey(r), "filter");
  ok("두 가지 다", eq(ruleTrouble(ruleKey(r)), ["editor", "filter"]));
  ok("패턴이 바뀌면 다른 규칙", ruleTrouble(ruleKey({ ...r, pattern: r.pattern + "x" })).length === 0);
  ok("문구", /끈 적이 있습니다/.test(troubleText(["editor"])) && /느린 방식/.test(troubleText(["filter"])) && troubleText([]) === "");
  noteSlowFilterRules([r], [5, -1]);
  ok("없는 번호는 무시", true);
}

console.log(`stage6-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
