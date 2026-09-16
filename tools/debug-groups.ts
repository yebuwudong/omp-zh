import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// find all TabGroups-like objects (>=6 props, string arrays)
const candidates: { start: number; props: number; arrCount: number; sample: string }[] = [];
const visit = (node: AstNode): void => {
  if (node.type === "ObjectExpression") {
    const props = (node.properties as AstNode[]).filter(p => isAst(p) && p.type === "ObjectProperty");
    let arrCount = 0, sample = "";
    for (const p of props) {
      const v = p.value as AstNode | undefined;
      if (v?.type !== "ArrayExpression") continue;
      const elems = (v.elements as (AstNode|null)[]).filter((e): e is AstNode => !!e && isAst(e));
      if (elems.length >= 2 && elems.every(e => e.type === "StringLiteral")) {
        arrCount++;
        if (!sample) sample = elems.slice(0,5).map(e=>JSON.stringify(e.value)).join(",");
      }
    }
    if (arrCount >= 3 && typeof node.start === "number") candidates.push({ start: node.start, props: props.length, arrCount, sample });
  }
  for (const k of Object.keys(node)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = node[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) visit(x); } else if (isAst(c)) visit(c); }
};
visit(ast);
console.log(`objects with >=3 string-array props: ${candidates.length}`);
for (const c of candidates.slice(0, 20)) console.log(`  @${c.start} props=${c.props} arrays=${c.arrCount} sample=${c.sample}`);
// count how many arrays total contain group-ish capitalized words
