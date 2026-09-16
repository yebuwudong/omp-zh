import { parse } from "@babel/parser";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });

// Find TAB_GROUPS-like object: props whose values are arrays of strings
const arrays: { start: number; keys: string[] }[] = [];
const groupProps: { start: number; value: string }[] = [];
function walk(node: any, parents: any[]) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walk(c, parents); return; }
  if (node.type === "ObjectProperty" && !node.computed) {
    const k = node.key?.name ?? node.key?.value;
    const v = node.value;
    if (k === "group" && v?.type === "StringLiteral") groupProps.push({ start: v.start, value: v.value });
    if (v?.type === "ArrayExpression" && v.elements.length >= 4) {
      const strs = v.elements.filter((e: any) => e?.type === "StringLiteral").map((e: any) => e.value);
      if (strs.length === v.elements.length && strs.some((s: string) => /^[A-Z]/.test(s) && s.length > 3)) {
        arrays.push({ start: v.start, keys: strs });
      }
    }
  }
  for (const k in node) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const v = node[k]; if (v && typeof v === "object") walk(v, [...parents, node]); }
}
walk(ast, []);
console.log(`arrays (>=4 string elems) found: ${arrays.length}`);
for (const a of arrays.slice(0, 5)) console.log(`  @${a.start} [${a.keys.length}] ${a.keys.slice(0,12).join(" | ")}`);
const groupSet = new Set(groupProps.map(g => g.value));
const arrayElems = new Set(arrays.flatMap(a => a.keys));
const both = [...groupSet].filter(g => arrayElems.has(g));
const onlyGroup = [...groupSet].filter(g => !arrayElems.has(g));
console.log(`\ngroup prop unique: ${groupSet.size}; array elem unique: ${arrayElems.size}; intersection: ${both.length}`);
console.log(`\nintersection (safe double-sided): ${both.sort().join(" | ")}`);
console.log(`\nonly-in-group (single-sided — DANGER if array side is elsewhere): ${onlyGroup.length}`);
console.log(onlyGroup.slice(0, 30).join(" | "));
