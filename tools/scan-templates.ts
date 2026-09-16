import { parse } from "@babel/parser";

interface N { type: string; start?: number | null; end?: number | null; [k: string]: unknown }
const isNode = (v: unknown): v is N => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";

const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });

const blocks: { start: number; end: number; len: number; lines: number; hit: number }[] = [];
function walk(node: N): void {
  if (node.type === "TemplateLiteral") {
    const exprs = node.expressions as unknown[];
    const quasis = node.quasis as N[];
    if (Array.isArray(exprs) && exprs.length === 0 && Array.isArray(quasis) && quasis.length === 1) {
      const q = quasis[0];
      const raw = String((q.value as {raw?:unknown})?.raw ?? "");
      if (raw.includes("\n") && typeof node.start === "number" && typeof node.end === "number") {
        const lines = raw.split("\n").map(l=>l.trim()).filter(Boolean);
        let hit = 0;
        for (const l of lines) if (dict[l] !== undefined) hit++;
        if (lines.length >= 4 && hit > 0) blocks.push({ start: node.start, end: node.end, len: raw.length, lines: lines.length, hit });
      }
    }
  }
  for (const k of Object.keys(node)) {
    if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (isNode(c)) walk(c); }
    else if (isNode(v)) walk(v);
  }
}
walk(ast as unknown as N);
console.log(`multi-line no-expression template literals with dict hits: ${blocks.length}`);
for (const b of blocks.sort((a,b)=>b.hit/b.lines - a.hit/b.lines).slice(0, 25)) {
  const pct = ((b.hit / b.lines) * 100).toFixed(0);
  console.log(`  @${b.start} len=${String(b.len).padStart(6)} lines=${String(b.lines).padStart(3)} hit=${String(b.hit).padStart(3)} (${pct}%)`);
  console.log(`      ${JSON.stringify(code.slice(b.start, b.start + 90))}`);
}
