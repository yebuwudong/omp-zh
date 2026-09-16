import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const childrenOf = (n: AstNode): AstNode[] => {
  const out: AstNode[] = [];
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) out.push(x); } else if (isAst(c)) out.push(c); }
  return out;
};
const orig = await Bun.file("/home/yebu/omp-zh/backup/cli.js.orig-pristine").text();
const dict: Record<string,string> = {};
for (const f of ["dict.json","dict-extra.json"]) {
  const d: Record<string,string> = await Bun.file("/home/yebu/omp-zh/" + f).json();
  for (const [k,v] of Object.entries(d)) if (k !== v) dict[k] = v;
}
const ast = parse(orig, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
const blocks: { start: number; end: number; lines: string[]; hits: number }[] = [];
const visit = (n: AstNode): void => {
  if (n.type === "TemplateLiteral" && typeof n.start === "number" && typeof n.end === "number") {
    const exprs = (n.expressions as unknown[] | undefined) ?? [];
    const quasis = (n.quasis as AstNode[] | undefined) ?? [];
    if (exprs.length === 0 && quasis.length === 1) {
      const raw = String((quasis[0].value as {raw?:unknown})?.raw ?? "");
      if (raw.includes("\n") && !raw.includes("{{")) {
        const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length >= 4) {
          const hits = lines.filter(l => dict[l] !== undefined).length;
          blocks.push({ start: n.start, end: n.end, lines, hits });
        }
      }
    }
  }
  for (const c of childrenOf(n)) visit(c);
};
visit(ast);
console.log(`候选块（>=4 行）: ${blocks.length}`);
for (const b of blocks) {
  const ratio = b.hits / b.lines.length;
  const wouldPass = b.lines.length >= 4 && b.hits >= 5 && ratio >= 0.25;
  const miss = b.lines.filter(l => dict[l] === undefined);
  console.log(`\n@${b.start} lines=${b.lines.length} hits=${b.hits} ratio=${ratio.toFixed(2)} pass=${wouldPass}`);
  if (!wouldPass && miss.length <= 3) {
    for (const m of miss) console.log(`    MISSING: ${JSON.stringify(m.slice(0, 90))}`);
  }
}
