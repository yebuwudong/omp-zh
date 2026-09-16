import { parse } from "@babel/parser";
type Json = unknown;
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isNode = (v: Json): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";

const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });

// find the streamMarkupHealingPattern property and dump a sample of its array
function walk(node: AstNode): void {
  if (node.type === "ObjectProperty" && String((node.key as AstNode)?.name ?? "") === "streamMarkupHealingPattern") {
    const v = node.value as AstNode;
    const snippet = code.slice(v.start ?? 0, Math.min((v.start ?? 0) + 300, v.end ?? 0));
    console.log(`=== streamMarkupHealingPattern @${v.start} type=${v.type} ===`);
    console.log(snippet.replace(/\n/g, "↵"));
    console.log();
  }
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const val = (node as Record<string, Json>)[key];
    if (Array.isArray(val)) { for (const c of val) if (isNode(c)) walk(c); }
    else if (isNode(val)) walk(val);
  }
}
walk(ast as unknown as AstNode);
