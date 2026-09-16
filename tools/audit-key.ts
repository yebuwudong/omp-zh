import { parse } from "@babel/parser";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });
const TARGETS = new Set(process.argv.slice(2));
const chain = (parents: any[], node: any) => {
  const parts: string[] = [];
  for (let i = parents.length - 1; i >= 0 && parts.length < 3; i--) {
    const p = parents[i];
    if (p.type === "ObjectProperty") { parts.push(`prop[${String(p.key?.name ?? p.key?.value)}]`); }
    else if (p.type === "ArrayExpression") parts.push(`arr(${p.elements.length})`);
    else if (p.type === "CallExpression") parts.push(`call(${p.callee?.name ?? p.callee?.property?.name ?? "?"})`);
    else if (p.type === "VariableDeclarator") parts.push(`var[${p.id?.name}]`);
    else if (p.type === "ReturnStatement") parts.push("return");
    else parts.push(p.type);
  }
  return parts.join(" <- ");
};
function walk(node: any, parents: any[]) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walk(c, parents); return; }
  if (node.type === "StringLiteral" && TARGETS.has(node.value)) {
    console.log(`  @${node.start}  ${chain(parents, node)}`);
  }
  for (const k in node) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const v = node[k]; if (v && typeof v === "object") walk(v, [...parents, node]); }
}
for (const t of TARGETS) { console.log(`\n=== ${JSON.stringify(t)} ===`); walk(ast, []); }
