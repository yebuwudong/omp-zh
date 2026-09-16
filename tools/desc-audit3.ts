import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

const shapes = new Map<string, { n: number; samples: string[] }>();
const objKeys = (obj: AstNode): string[] =>
  (obj.properties as AstNode[]).filter(p => p.type === "ObjectProperty" && isAst(p))
    .map(p => String((p.key as AstNode)?.name ?? "?")).sort();

function walk(n: AstNode, parents: AstNode[]): void {
  if (n.type === "ObjectProperty" && String((n.key as AstNode)?.name ?? "") === "description") {
    const v = n.value as AstNode | undefined;
    if (v?.type === "StringLiteral" && typeof v.value === "string" && dict[v.value] !== undefined) {
      const obj = parents[parents.length-1];
      let shape = "?";
      if (obj?.type === "ObjectExpression") {
        const keys = objKeys(obj).filter(k => k !== "description").slice(0, 6);
        shape = "obj{" + keys.join(",") + "}";
      } else shape = obj?.type ?? "?";
      const rec = shapes.get(shape) ?? { n: 0, samples: [] };
      rec.n++;
      if (rec.samples.length < 2) rec.samples.push(v.value.slice(0, 70));
      shapes.set(shape, rec);
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) walk(x, [...parents, n]); } else if (isAst(c)) walk(c, [...parents, n]); }
}
walk(ast, []);
console.log(`distinct enclosing shapes for description: values`);
let total = 0;
for (const [shape, rec] of [...shapes.entries()].sort((a,b)=>b[1].n-a[1].n)) {
  total += rec.n;
  console.log(`  ${String(rec.n).padStart(4)}  ${shape}`);
  for (const s of rec.samples) console.log(`         e.g. ${JSON.stringify(s)}`);
}
console.log(`total: ${total}`);
