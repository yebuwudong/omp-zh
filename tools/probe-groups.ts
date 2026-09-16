import { parse } from "@babel/parser";
type Json = unknown;
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: Json): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";

const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });

// Collect group-prop values, then dump every occurrence of those exact strings with context snippet
const groupVals = new Set<string>();
function collect(node: AstNode): void {
  if (node.type === "ObjectProperty" && String((node.key as AstNode)?.name ?? (node.key as AstNode)?.value ?? "") === "group") {
    const v = node.value as AstNode;
    if (v?.type === "StringLiteral" && typeof v.value === "string") groupVals.add(v.value);
  }
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const val = (node as Record<string, Json>)[key];
    if (Array.isArray(val)) { for (const c of val) if (isAst(c)) collect(c); }
    else if (isAst(val)) collect(val);
  }
}
collect(ast as unknown as AstNode);
console.log(`distinct group values: ${groupVals.size}`);

const interesting: { val: string; start: number; parent: string; grand: string }[] = [];
function scan(node: AstNode, parents: AstNode[]): void {
  if (node.type === "StringLiteral" && typeof node.value === "string" && groupVals.has(node.value)) {
    const p = parents[parents.length-1];
    const gp = parents[parents.length-2];
    const pt = p?.type ?? "?";
    if (!(pt === "ObjectProperty" || pt === "ArrayExpression")) {
      interesting.push({ val: node.value, start: node.start ?? 0, parent: pt, grand: gp?.type ?? "?" });
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const val = (node as Record<string, Json>)[key];
    if (Array.isArray(val)) { for (const c of val) if (isAst(c)) scan(c, [...parents, node]); }
    else if (isAst(val)) scan(val, [...parents, node]);
  }
}
scan(ast as unknown as AstNode, []);
console.log(`non-{prop,array} occurrences: ${interesting.length}`);
for (const it of interesting) {
  const a = Math.max(0, it.start - 120), b = Math.min(code.length, it.start + 120);
  console.log(`\n--- ${JSON.stringify(it.val)} ${it.parent}<-${it.grand} @${it.start}`);
  console.log("   " + code.slice(a, b).replace(/\n/g, "↵"));
}
