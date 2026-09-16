import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string, string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

const decodeJs = (raw: string): string =>
  raw.replace(/\\n/g, "\n")
     .replace(/\\`/g, "`")
     .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
     .replace(/\\'/g, "'")
     .replace(/\\"/g, '"')
     .replace(/\\\\/g, "\\");

function walk(n: AstNode): void {
  if (n.type === "CallExpression") {
    const c = n.callee as AstNode | undefined;
    if (String(c?.name ?? "") === "__omp_i18n_block") {
      const arg = (n.arguments as AstNode[])[0];
      if (arg?.type === "TemplateLiteral") {
        const raw = String(((arg.quasis as AstNode[])[0].value as { raw?: unknown }).raw ?? "");
        const decoded = decodeJs(raw);
        const lines = decoded.split("\n");
        let hit = 0;
        for (const l of lines) { const k = l.trim(); if (k && dict[k]) hit++; }
        console.log(`block @${n.start}: ${lines.length} lines, ${hit} dict hits`);
        console.log("first 3 decoded:");
        for (const l of lines.slice(0, 3)) {
          const k = l.trim();
          console.log("   " + JSON.stringify(l.slice(0, 70)) + " -> " + JSON.stringify((dict[k] ?? "(miss)").slice(0, 45)));
        }
        console.log("misses:");
        for (const l of lines) { const k = l.trim(); if (k && !dict[k]) console.log("   " + k.slice(0, 90)); }
      }
    }
  }
  for (const k of Object.keys(n)) {
    if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
    const c = n[k];
    if (Array.isArray(c)) { for (const x of c) if (isAst(x)) walk(x); }
    else if (isAst(c)) walk(c);
  }
}
walk(ast);
