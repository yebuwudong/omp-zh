import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number | null; end?: number | null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// What do the settings tab/group keys look like in the bundle?
const probeKeys = ["Appearance","Model","Interaction","Context","Memory","Files","Shell","Tools","Tasks","Providers","Theme","Composer","Status Line","Display","Images","Thinking","Sampling"];
const hits = new Map<string, {start:number; parent:string; grand:string; grandp:string}[]>();
function walk(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && probeKeys.includes(n.value)) {
    const p = parents[parents.length-1], gp = parents[parents.length-2], ggp = parents[parents.length-3];
    const sig = `${p?.type ?? "?"}<-${gp?.type ?? "?"}<-${ggp?.type ?? "?"}`;
    const arr = hits.get(n.value) ?? [];
    arr.push({ start: n.start ?? 0, parent: sig, grand: "", grandp: "" });
    hits.set(n.value, arr);
  }
  for (const k of Object.keys(n)) {
    if (k==="start"||k==="end"||k==="loc"||k==="range") continue;
    const c = n[k];
    if (Array.isArray(c)) { for (const x of c) if (isAst(x)) walk(x, [...parents, n]); }
    else if (isAst(c)) walk(c, [...parents, n]);
  }
}
walk(ast, []);
for (const k of probeKeys) {
  const arr = hits.get(k) ?? [];
  const sigs = new Map<string, number>();
  for (const h of arr) sigs.set(h.parent, (sigs.get(h.parent) ?? 0) + 1);
  console.log(`${JSON.stringify(k)}: ${arr.length} occ — ${[...sigs.entries()].map(([s,c])=>`${s} x${c}`).join(", ")}`);
}
