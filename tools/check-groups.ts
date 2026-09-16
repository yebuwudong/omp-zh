import { parse } from "@babel/parser";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });
const GROUPS = ["Theme","Composer","Status Line","Display","Images","Thinking","Sampling","Prompt","Retry & Fallback","Advisor","Prewalk","Vision","Input","Approvals","Notifications","Speech","Collab","Startup & Updates","Agent","General","Compaction","Rules (TTSR)","Output Limits","Execution","Discovery & MCP","Extensions","Developer","Modes","Subagents","Isolation","Commands & Skills"];
const target = new Set(GROUPS);
const occ = new Map<string, number>();
const byCtx = new Map<string, number>();
function walk(node: any, parents: any[]) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walk(c, parents); return; }
  if (node.type === "StringLiteral" && target.has(node.value)) {
    occ.set(node.value, (occ.get(node.value) ?? 0) + 1);
    const p = parents[parents.length-1], gp = parents[parents.length-2];
    let ctx = p?.type ?? "?";
    if (p?.type === "ArrayExpression") ctx = "arrayElem";
    else if (p?.type === "ObjectProperty") ctx = `prop[${p.key?.name ?? p.key?.value}]`;
    byCtx.set(ctx, (byCtx.get(ctx) ?? 0) + 1);
  }
  for (const k in node) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const v = node[k]; if (v && typeof v === "object") walk(v, [...parents, node]); }
}
walk(ast, []);
console.log("contexts:", [...byCtx.entries()].sort((a,b)=>b[1]-a[1]));
console.log("\nper-group counts (count>3 shown):");
for (const [g, n] of [...occ.entries()].sort((a,b)=>b[1]-a[1])) if (n > 3) console.log(`  ${n.toString().padStart(3)}  ${JSON.stringify(g)}`);
