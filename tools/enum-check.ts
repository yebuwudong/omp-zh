import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// 1) Is "group" prop ever used as a lookup KEY (not compared)? Check array membership patterns.
// 2) Which dict-matching ARRAY elements sit in arrays that are ALSO used for indexOf/includes?
const arrayOcc = new Map<number, { vals: string[]; parentProp: string; hitKeys: string[] }>();
function scan(n: AstNode, parents: AstNode[]): void {
  if (n.type === "ArrayExpression" && typeof n.start === "number") {
    const elems = (n.elements as (AstNode|null)[]).filter((e): e is AstNode => !!e && isAst(e));
    const vals = elems.filter(e => e.type === "StringLiteral").map(e => String(e.value));
    const hits = vals.filter(v => dict[v] !== undefined);
    if (hits.length > 0 && vals.length <= 40) {
      const p = parents[parents.length-1];
      const key = p?.type === "ObjectProperty" ? String((p.key as AstNode)?.name ?? "?") : (p?.type ?? "?");
      arrayOcc.set(n.start, { vals, parentProp: key, hitKeys: hits });
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) scan(x, [...parents, n]); } else if (isAst(c)) scan(c, [...parents, n]); }
}
scan(ast, []);

// how many dict-matching literals live in arrays reachable from `values:`
let inValues = 0, otherArr = 0;
const byArrayParent = new Map<string, number>();
for (const [, info] of arrayOcc) {
  byArrayParent.set(info.parentProp, (byArrayParent.get(info.parentProp) ?? 0) + info.hitKeys.length);
}
console.log("arrays containing dict-matching keys, grouped by parent property:");
for (const [k, n] of [...byArrayParent.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${k}`);

// Show the samples of the top ones
console.log("\nsamples:");
let shown = 0;
for (const [start, info] of arrayOcc) {
  if (info.vals.length >= 4 && shown < 20 && (info.parentProp === "options" || info.parentProp === "values" || info.parentProp === "?" || info.parentProp === "ArrayExpression")) {
    console.log(`  @${start} parent=${info.parentProp} vals=[${info.vals.slice(0,8).map(v=>JSON.stringify(v)).join(",")}] hits=[${info.hitKeys.slice(0,6).map(v=>JSON.stringify(v)).join(",")}]`);
    shown++;
  }
}
