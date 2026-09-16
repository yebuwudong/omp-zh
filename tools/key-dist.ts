import { parse } from "@babel/parser";
type Json = unknown;
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isNode = (v: Json): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";

const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });

const dist = new Map<string, number>();
function walk(node: AstNode, parents: AstNode[]): void {
  if (node.type === "StringLiteral" && typeof node.value === "string" && dict[node.value] !== undefined) {
    const p = parents[parents.length-1];
    let k = p?.type ?? "?";
    if (p?.type === "ObjectProperty") {
      const key = String((p.key as AstNode)?.name ?? (p.key as AstNode)?.value ?? "?");
      k = `prop:${key}`;
    } else if (p?.type === "ArrayExpression") k = "arrayElem";
    else if (p?.type === "CallExpression") {
      const callee = p.callee as AstNode | undefined;
      k = `call:${String(callee?.name ?? (callee?.property as AstNode)?.name ?? "?")}`;
    } else if (p?.type === "TemplateLiteral") k = "template";
    else if (p?.type === "VariableDeclarator") k = "var";
    else if (p?.type === "ConditionalExpression") k = "ternary";
    else if (p?.type === "LogicalExpression") k = "logical";
    else if (p?.type === "BinaryExpression") k = `bin:${String(p.operator)}`;
    else if (p?.type === "AssignmentExpression") k = "assign";
    else if (p?.type === "ReturnStatement") k = "return";
    else if (p?.type === "ExpressionStatement") k = "exprStmt";
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const v = (node as Record<string, Json>)[key];
    if (Array.isArray(v)) { for (const c of v) if (isNode(c)) walk(c, [...parents, node]); }
    else if (isNode(v)) walk(v, [...parents, node]);
  }
}
walk(ast as unknown as AstNode, []);
console.log("parent-key distribution of ALL dict-matched literals:");
for (const [k, n] of [...dist.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 60)) console.log(`  ${String(n).padStart(5)}  ${k}`);
