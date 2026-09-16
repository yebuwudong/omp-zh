import { parse } from "@babel/parser";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });
const TARGETS = new Set(process.argv.slice(2));
const show = (pos: number, len = 110) => {
  const a = Math.max(0, pos - len), b = Math.min(code.length, pos + len);
  return code.slice(a, b).replace(/\n/g, "↵");
};
function walk(node: any) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walk(c); return; }
  if (node.type === "StringLiteral" && TARGETS.has(node.value)) {
    console.log(`--- ${JSON.stringify(node.value)} @${node.start} ---`);
    console.log(`   ${show(node.start)}`);
  }
  for (const k in node) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const v = node[k]; if (v && typeof v === "object") walk(v); }
}
for (const t of TARGETS) { console.log(`\n########## ${JSON.stringify(t)} ##########`); walk(ast); }
