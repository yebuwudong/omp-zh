import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAst = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// Replicate "other" classification: parent not in any known table
const CMP = new Set(["==","===","!=","!==","<",">","<=",">="]);
const LOGIC = new Set(["includes","startsWith","endsWith","indexOf","lastIndexOf","search","match","matchAll","test","exec","split","replace","replaceAll","localeCompare","charAt","slice","substring","equals","has","get","join","concat","filter","find","some","every","map","reduce"]);
const MUT = new Set(["add","push","unshift","splice","set","insert","append","define"]);
const STYLE = new Set(["fg","bg","bold","dim","italic","underline","strikethrough","inverse","muted","accent","success","error","warning","info","hint"]);
const DISP = new Set(["label","description","title","displayName","placeholder","hint","subtitle","helpText","emptyText","tooltip","about","notice","caption","detail","warning","heading","message","text","selectorText","tips","footer","header"]);
const DATA = new Set(["default","values","name","id","key","type","kind","role","value","choices","enum","source","target","mode","op","tag","category","family","command","path","url","env","dir","file","action","selector","variant","icon","tab","scope"]);

const callers = new Map<string, {n:number, sample:string}[]>();
let otherCount = 0;

function classify(n: AstNode, parents: AstNode[]): string {
  const p = parents[parents.length-1], gp = parents[parents.length-2];
  if (p?.type === "ArrayExpression") return "arrayElem";
  if (p?.type === "BinaryExpression" && CMP.has(String(p.operator))) return "logic";
  if (p?.type === "SwitchCase") return "logic";
  if (p?.type === "CallExpression") {
    const c = p.callee as AstNode | undefined;
    const nm = String(c?.name ?? (c?.type === "MemberExpression" ? (c.property as AstNode)?.name : "") ?? "?");
    if (LOGIC.has(nm)) return "logic";
    if (MUT.has(nm)) return "mutate";
    if (STYLE.has(nm)) return "styleCall";
    if (DATA.has(nm)) return "dataValue";
    return `call:${nm}`;
  }
  if (p?.type === "ObjectProperty") {
    const k = String((p.key as AstNode)?.name ?? "?");
    if (DISP.has(k)) return "propDisplay";
    if (DATA.has(k)) return "dataValue";
    return `prop:${k}`;
  }
  if (p?.type === "AssignmentExpression") return "assign";
  if (p?.type === "ConditionalExpression") return "ternary";
  if (p?.type === "LogicalExpression") return "logical";
  if (p?.type === "ReturnStatement") return "return";
  if (p?.type === "VariableDeclarator") return "varDecl";
  if (p?.type === "TemplateLiteral") return "template";
  if (p?.type === "ExpressionStatement") return "exprStmt";
  return p?.type ?? "?";
}

function visit(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && dict[n.value] !== undefined && typeof n.start === "number" && !/[\\\n\t]|\{\{|\}\}|\$\{|%\d|%s|^\s|\s$|:\/\/|[{}=;`]|^#|^--|^- /.test(n.value)) {
    const cls = classify(n, parents);
    if (cls.startsWith("call:")) {
      otherCount++;
      const name = cls.slice(5);
      const arr = callers.get(name) ?? [];
      arr.push({ n: n.start, sample: n.value.slice(0, 60) });
      callers.set(name, arr);
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAst(x)) visit(x, [...parents, n]); } else if (isAst(c)) visit(c, [...parents, n]); }
}
visit(ast, []);
console.log(`dict literals in call positions: ${otherCount}`);
console.log(`\ncalls by name (with samples):`);
for (const [nm, arr] of [...callers.entries()].sort((a,b)=>b[1].length-a[1].length).slice(0, 40)) {
  console.log(`  ${String(arr.length).padStart(4)}  ${nm.padEnd(16)} ${arr.slice(0,2).map(a=>JSON.stringify(a.sample)).join("  ")}`);
}
