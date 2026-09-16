import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// Find literals that are `description:` values inside an object that also has
// `name` + (`parameters` | `inputSchema`) siblings → tool definition (model-facing).
const toolDescs: { start: number; text: string }[] = [];
const settingsDescs: { start: number; text: string }[] = [];

function objLooksLikeTool(obj: AstNode): boolean {
  const props = (obj.properties as AstNode[]).filter(p => p.type === "ObjectProperty");
  const keys = new Set(props.map(p => String((p.key as AstNode)?.name ?? "")));
  return (keys.has("name") && (keys.has("parameters") || keys.has("inputSchema") || keys.has("label"))) ||
         keys.has("loadMode") || keys.has("summary");
}
function objLooksLikeUiSchema(obj: AstNode): boolean {
  const props = (obj.properties as AstNode[]).filter(p => p.type === "ObjectProperty");
  const keys = new Set(props.map(p => String((p.key as AstNode)?.name ?? "")));
  return keys.has("tab") && keys.has("group");
}

function visit(n: AstNode): void {
  if (n.type === "ObjectProperty" && String((n.key as AstNode)?.name ?? "") === "description") {
    const v = n.value as AstNode | undefined;
    if (v?.type === "StringLiteral" && typeof v.value === "string" && dict[v.value] !== undefined && typeof v.start === "number") {
      // find enclosing object
      if (objLooksLikeTool((n as unknown as {__parent?: AstNode}).__parent ?? n) || true) {}
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) { (x as {__parent?: AstNode}).__parent = n; visit(x); } } else if (isAst(c)) { (c as {__parent?: AstNode}).__parent = n; visit(c); } }
}
visit(ast);

for (const k of Object.keys(ast)) { /* noop */ }
// second pass with explicit parent chain
function walk(n: AstNode, parents: AstNode[]): void {
  if (n.type === "ObjectProperty" && String((n.key as AstNode)?.name ?? "") === "description") {
    const v = n.value as AstNode | undefined;
    if (v?.type === "StringLiteral" && typeof v.value === "string" && dict[v.value] !== undefined && typeof v.start === "number") {
      const obj = parents[parents.length-1];
      if (obj?.type === "ObjectExpression" && objLooksLikeTool(obj)) toolDescs.push({ start: v.start, text: v.value });
      else if (obj?.type === "ObjectExpression" && objLooksLikeUiSchema(obj)) settingsDescs.push({ start: v.start, text: v.value });
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) walk(x, [...parents, n]); } else if (isAst(c)) walk(c, [...parents, n]); }
}
walk(ast, []);
console.log(`description: values of tool-like objects (model-facing): ${toolDescs.length}`);
for (const t of toolDescs.slice(0, 25)) console.log(`  ${JSON.stringify(t.text.slice(0, 90))}`);
console.log(`\ndescription: values inside ui{tab,group} objects (settings UI): ${settingsDescs.length}`);
for (const t of settingsDescs.slice(0, 10)) console.log(`  ${JSON.stringify(t.text.slice(0, 90))}`);
