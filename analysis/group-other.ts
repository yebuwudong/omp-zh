import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// group prop values that exist in dict
const groupVals = new Set<string>();
function collect(n: AstNode): void {
  if (n.type === "ObjectProperty" && String((n.key as AstNode)?.name ?? "") === "group") {
    const v = n.value as AstNode;
    if (v?.type === "StringLiteral" && typeof v.value === "string") groupVals.add(v.value);
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) collect(x); } else if (isAst(c)) collect(c); }
}
collect(ast);

const targets = new Set([...groupVals].filter(g => dict[g] !== undefined));
console.log(`group names with dict entries: ${targets.size}`);

type Hit = { val: string; start: number; p: string; gp: string; ggp: string };
const hits: Hit[] = [];
function scan(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && targets.has(n.value) && typeof n.start === "number") {
    const p = parents[parents.length-1], gp = parents[parents.length-2], ggp = parents[parents.length-3];
    const kind = p?.type === "ArrayExpression" ? "arr" : (p?.type === "ObjectProperty" && String((p.key as AstNode)?.name ?? "") === "group") ? "grp" : "other";
    if (kind === "other") hits.push({ val: n.value, start: n.start, p: p?.type ?? "?", gp: gp?.type ?? "?", ggp: ggp?.type ?? "?" });
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) scan(x, [...parents, n]); } else if (isAst(c)) scan(c, [...parents, n]); }
}
scan(ast, []);
console.log(`"other" occurrences: ${hits.length}\n`);
for (const h of hits) {
  const a = Math.max(0, h.start - 130), b = Math.min(code.length, h.start + 130);
  console.log(`--- ${JSON.stringify(h.val)} ${h.p}<-${h.gp}<-${h.ggp} @${h.start}`);
  console.log(`    ${code.slice(a,b).replace(/\n/g,"↵")}\n`);
}
