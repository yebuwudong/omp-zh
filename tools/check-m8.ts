import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
function findFn(name: string): string[] {
  const out: string[] = [];
  function visit(n: AstNode): void {
    if (n.type === "FunctionDeclaration" && String((n.id as AstNode)?.name ?? "") === name) out.push(code.slice(n.start ?? 0, Math.min((n.start ?? 0) + 300, n.end ?? 0)).replace(/\n/g," "));
    if (n.type === "VariableDeclarator" && String((n.id as AstNode)?.name ?? "") === name) {
      const init = n.init as AstNode | undefined;
      if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) out.push(code.slice(init.start ?? 0, Math.min((init.start ?? 0) + 300, init.end ?? 0)).replace(/\n/g," "));
    }
    for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) visit(x); } else if (isAst(c)) visit(c); }
  }
  visit(ast); return out;
}
for (const name of ["M8","jnt","a7t"]) {
  console.log(`\n### ${name}`);
  for (const d of findFn(name).slice(0,2)) console.log(`   ${d.slice(0,260)}`);
}
