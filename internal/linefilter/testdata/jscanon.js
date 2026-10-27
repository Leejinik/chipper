// Writes the JS (non-u, i flag) Canonicalize table as [[char, canonical], ...] for TestJSCanonAgainstNode.
// ES Canonicalize (non-u, i flag): toUpperCase; keep ch if result length != 1 or (ch>=128 && result<128)
const out = [];
for (let c = 0; c <= 0xffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  const ch = String.fromCharCode(c);
  const u = ch.toUpperCase();
  let canon = c;
  if (u.length === 1) {
    const uc = u.charCodeAt(0);
    if (!(c >= 128 && uc < 128)) canon = uc;
  }
  if (canon !== c) out.push([c, canon]);
}
// multi-char uppercase list
const multi = [];
for (let c = 0; c <= 0xffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  if (String.fromCharCode(c).toUpperCase().length !== 1) multi.push(c.toString(16));
}
require("fs").writeFileSync(process.argv[2] || "jscanon.json", JSON.stringify(out));
console.log("mappings", out.length, "multi", multi.length, multi.join(" "));
