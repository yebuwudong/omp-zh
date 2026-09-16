import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// For dict-matching literals whose parent is a CallExpression argument, record callee names.
const calleeCount = new Map<string, number>();
const calleeSamples = new Map<string, string[]>();
function visit(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && dict[n.value] !== undefined && typeof n.start === "number") {
    const p = parents[parents.length-1];
    if (p?.type === "CallExpression") {
      const c = p.callee as AstNode | undefined;
      const nm = String(c?.name ?? (c?.type === "MemberExpression" ? (c.property as AstNode)?.name : "") ?? (c?.type === "Identifier" ? c.name : "?"));
      calleeCount.set(nm, (calleeCount.get(nm) ?? 0) + 1);
      const arr = calleeSamples.get(nm) ?? [];
      if (arr.length < 3) arr.push(n.value.slice(0, 40));
      calleeSamples.set(nm, arr);
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) visit(x, [...parents, n]); } else if (isAst(c)) visit(c, [...parents, n]); }
}
visit(ast, []);
console.log("dict-matching literals passed directly to calls — by callee:");
for (const [nm, cnt] of [...calleeCount.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 45)) {
  console.log(`  ${String(cnt).padStart(4)}  ${nm.padEnd(18)} e.g. ${JSON.stringify(calleeSamples.get(nm)?.slice(0,2))}`);
}
