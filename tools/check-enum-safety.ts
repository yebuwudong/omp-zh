import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
const TARGETS = new Set(["braille","rebuild","always","never","Backend"]);
const nameOf = (n: AstNode | undefined): string => n === undefined ? "" : String(n.name ?? "");
const propKeyOf = (n: AstNode): string => { const k = n.key as AstNode|undefined; if(!k) return ""; return k.type==="Identifier"? String(k.name??"") : String(k.value??""); };
function roleOf(n: AstNode, parents: AstNode[]): string {
  const p = parents[parents.length-1];
  if (p?.type === "ObjectProperty") {
    const k = propKeyOf(p);
    if (p.key === n && !p.computed) return `objKey`;
    if (p.value === n) return `propVal:${k}`;
  }
  if (p?.type === "ArrayExpression") {
    const gp = parents[parents.length-2];
    if (gp?.type === "ObjectProperty") return `arrayIn:${propKeyOf(gp)}`;
    return "arrayElem";
  }
  if (p?.type === "CallExpression") return "call";
  if (p?.type === "BinaryExpression") return `cmp:${String(p.operator)}`;
  if (p?.type === "SwitchCase") return "switch";
  return p?.type ?? "?";
}
const out = new Map<string, Map<string, number>>();
function visit(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && TARGETS.has(n.value)) {
    const r = roleOf(n, parents);
    const m = out.get(n.value) ?? new Map();
    m.set(r, (m.get(r) ?? 0) + 1);
    out.set(n.value, m);
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAstNode(x)) visit(x, [...parents, n]); } else if (isAstNode(c)) visit(c, [...parents, n]); }
}
visit(ast, []);
for (const [val, m] of out) {
  console.log(`${val.padEnd(12)} ${[...m.entries()].map(([r,c])=>`${r}×${c}`).join(", ")}`);
}
