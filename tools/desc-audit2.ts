import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

const toolDescs: string[] = [];
const uiDescs: string[] = [];
let uiTotal = 0;

const objKeys = (obj: AstNode): Set<string> =>
  new Set((obj.properties as AstNode[]).filter(p => p.type === "ObjectProperty")
    .map(p => String((p.key as AstNode)?.name ?? "")));

function walk(n: AstNode, parents: AstNode[]): void {
  if (n.type === "ObjectProperty" && String((n.key as AstNode)?.name ?? "") === "description") {
    const v = n.value as AstNode | undefined;
    if (v?.type === "StringLiteral" && typeof v.value === "string" && dict[v.value] !== undefined) {
      const obj = parents[parents.length-1];
      if (obj?.type === "ObjectExpression") {
        const keys = objKeys(obj);
        const hasUi = keys.has("tab") || keys.has("group");
        const hasTool = keys.has("loadMode") || keys.has("summary") || (keys.has("name") && (keys.has("parameters") || keys.has("inputSchema"))) || keys.has("get description");
        if (hasUi) { uiTotal++; uiDescs.push(v.value); }
        else if (hasTool) toolDescs.push(v.value);
      } else if (obj?.type === "ClassBody") {
        toolDescs.push(v.value); // class property description → tool class
      }
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) walk(x, [...parents, n]); } else if (isAst(c)) walk(c, [...parents, n]); }
}
walk(ast, []);
console.log(`ui{tab,group} descriptions matched by dict: ${uiTotal}`);
console.log(`tool-like descriptions matched by dict: ${toolDescs.length}`);
for (const t of toolDescs.slice(0, 20)) console.log(`   TOOL: ${JSON.stringify(t.slice(0, 100))}`);
