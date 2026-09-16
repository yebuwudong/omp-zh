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
// blocks that ACTUALLY got wrapped in the patched bundle
const patched = await Bun.file("/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js").text();
const ast = parse(orig, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
const visit = (n: AstNode): void => {
  if (n.type === "TemplateLiteral" && typeof n.start === "number" && typeof n.end === "number") {
    const exprs = (n.expressions as unknown[] | undefined) ?? [];
    const quasis = (n.quasis as AstNode[] | undefined) ?? [];
    if (exprs.length === 0 && quasis.length === 1) {
      const qv = quasis[0].value as {raw?:unknown; cooked?:unknown} | undefined;
      // Runtime lookup splits the DECODED string, so keys must match cooked text.
      const raw = String((qv?.cooked ?? qv?.raw) ?? "");
      if (raw.includes("\n") && !raw.includes("{{")) {
        const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
        const hits = lines.filter(l => dict[l] !== undefined).length;
        if (lines.length >= 4 && hits >= 5 && hits / lines.length >= 0.25) {
          // this block passed the threshold -> it will be wrapped; report its gaps
          const miss = lines.filter(l => dict[l] === undefined);
          if (miss.length > 0) {
            console.log(`\n=== block @${n.start} lines=${lines.length} hits=${hits} missing=${miss.length} ===`);
            for (const m of miss) console.log(JSON.stringify(m));
          }
        }
      }
    }
  }
  for (const c of childrenOf(n)) visit(c);
};
visit(ast);
