/** Which group names would be translated on the prop side but banned on the array side today? */
import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number | null; end?: number | null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

const groupVals = new Set<string>();
const found: { val: string; role: string }[] = [];
function collect(n: AstNode): void {
  if (n.type === "ObjectProperty" && String((n.key as AstNode)?.name ?? "") === "group") {
    const v = n.value as AstNode;
    if (v?.type === "StringLiteral" && typeof v.value === "string") groupVals.add(v.value);
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) collect(x); } else if (isAst(c)) collect(c); }
}
collect(ast);
console.log(`group values: ${groupVals.size}`);

// For each group value, find all occurrences and classify crudely
const report: Record<string, { arr: number; prop: number; other: number }> = {};
for (const g of groupVals) report[g] = { arr: 0, prop: 0, other: 0 };
function scan(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && groupVals.has(n.value)) {
    const p = parents[parents.length-1];
    if (p?.type === "ArrayExpression") report[n.value].arr++;
    else if (p?.type === "ObjectProperty" && String((p.key as AstNode)?.name ?? "") === "group") report[n.value].prop++;
    else report[n.value].other++;
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) scan(x, [...parents, n]); } else if (isAst(c)) scan(c, [...parents, n]); }
}
scan(ast, []);
const dangerous: string[] = [];
for (const [g, r] of Object.entries(report).sort((a,b)=>(b[1].arr+b[1].prop)-(a[1].arr+a[1].prop))) {
  const phrase = /\s/.test(g);
  const marker = (r.arr > 0 && r.prop > 0) ? "LINKED" : (r.arr > 0 ? "arrOnly" : "propOnly");
  console.log(`  ${marker.padEnd(8)} arr=${String(r.arr).padStart(3)} prop=${String(r.prop).padStart(3)} other=${String(r.other).padStart(3)}  ${JSON.stringify(g)}  ${phrase?"(phrase)":"(short)"}`);
}
