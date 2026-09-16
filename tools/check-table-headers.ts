import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

const TARGETS = new Set(["NAME","STATE","PID","UPTIME","RESTARTS","FLAGS","COMMAND","USAGE","COMMANDS","ARGUMENTS","EXAMPLES"]);
const found: { val: string; role: string; via: string; pos: number }[] = [];

// crude role: look at parent
function visit(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && TARGETS.has(n.value) && typeof n.start === "number") {
    const p = parents[parents.length-1];
    let role = p?.type ?? "?";
    if (p?.type === "ArrayExpression") role = "arrayElem";
    else if (p?.type === "CallExpression") {
      const c = p.callee as AstNode | undefined;
      role = "call:" + String(c?.name ?? (c?.property as AstNode)?.name ?? "?");
    } else if (p?.type === "ObjectProperty") {
      const k = (p.key as AstNode)?.name ?? (p.key as AstNode)?.value;
      role = k === n.value ? "objKey" : `objVal:${String(k)}`;
    }
    found.push({ val: n.value, role, via: p?.type ?? "?", pos: n.start });
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) visit(x, [...parents, n]); } else if (isAst(c)) visit(c, [...parents, n]); }
}
visit(ast, []);

// group by value
const byVal = new Map<string, typeof found>();
for (const f of found) { const arr = byVal.get(f.val) ?? []; arr.push(f); byVal.set(f.val, arr); }
for (const [val, arr] of [...byVal.entries()].sort()) {
  const roles = new Map<string, number>();
  for (const f of arr) roles.set(f.role, (roles.get(f.role) ?? 0) + 1);
  const inDict = dict[val] ? "✓dict" : "✗nodict";
  console.log(`${val.padEnd(12)} ${inDict}  n=${arr.length}  ${[...roles.entries()].map(([r,c])=>`${r}×${c}`).join(", ")}`);
}
