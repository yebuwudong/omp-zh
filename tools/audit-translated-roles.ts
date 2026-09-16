/** List which keys/yías have non-display roles in the translate set. */
import { parse } from "@babel/parser";
interface AstNode { type: string; start?: number|null; end?: number|null; [k: string]: unknown }
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as {type?:unknown}).type === "string";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const extra: Record<string,string> = await Bun.file("dict-extra.json").json();
const merged: Record<string,string> = { ...dict };
for (const [k,v] of Object.entries(extra)) if (v !== k) merged[k] = v;
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

// Reuse: find which literals classified as logic/arrayTok/mutate would be translated
// by checking the structural allowlist overlap.
const STRUCTURAL = new Set(["USAGE","COMMANDS","ARGUMENTS","FLAGS","EXAMPLES","NAME","STATE","PID","UPTIME","RESTARTS","COMMAND"]);
const found: {key:string; role:string; via:string; snippet:string}[] = [];

const CMP = new Set(["==","===","!=","!==","<",">","<=",">="]);
const LOGIC_CALLS = new Set(["includes","startsWith","endsWith","indexOf","lastIndexOf","search","match","matchAll","test","exec","split","replace","replaceAll","localeCompare","charAt","slice","substring","equals","has","get","join","concat","filter","find","some","every","map","reduce"]);
const MUT = new Set(["add","push","unshift","splice","set","insert","append","define"]);

function role(n: AstNode, parents: AstNode[]): {role:string; via:string} {
  const p = parents[parents.length-1];
  if (p?.type === "SwitchCase" && p.test === n) return {role:"logic", via:"switch"};
  if (p?.type === "BinaryExpression" && typeof p.operator === "string" && CMP.has(p.operator)) return {role:"logic", via:"cmp:"+p.operator};
  if (p?.type === "CallExpression") {
    const c = p.callee as AstNode | undefined;
    const nm = String(c?.name ?? (c?.type==="MemberExpression" ? (c.property as AstNode)?.name : "") ?? "");
    if (Array.isArray(p.arguments) && p.arguments.includes(n)) {
      if (LOGIC_CALLS.has(nm)) return {role:"logic", via:"call:"+nm};
      if (MUT.has(nm)) return {role:"mutate", via:"call:"+nm};
    }
  }
  if (p?.type === "ArrayExpression") {
    const elems = (p.elements as (AstNode|null)[]).filter((e): e is AstNode => !!e && isAstNode(e));
    if (elems.length >= 2 && elems.every(e => e.type === "StringLiteral")) {
      const short = elems.filter(e => typeof e.value === "string" && (e.value as string).length <= 14 && !/\s/.test(e.value as string)).length;
      if (short / elems.length >= 0.7) return {role:"arrayTok", via:`arrayTok[${elems.length}]`};
    }
  }
  return {role:"none", via:""};
}

function visit(n: AstNode, parents: AstNode[]): void {
  if (n.type === "StringLiteral" && typeof n.value === "string" && typeof n.start === "number") {
    if (merged[n.value] !== undefined && STRUCTURAL.has(n.value)) {
      const r = role(n, parents);
      if (r.role !== "none") found.push({key:n.value, role:r.role, via:r.via, snippet: code.slice(Math.max(0,(n.start??0)-60), (n.start??0)+80).replace(/\n/g,"↵")});
    }
  }
  for (const k of Object.keys(n)) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const c = n[k]; if (Array.isArray(c)) { for (const x of c) if (isAstNode(x)) visit(x, [...parents, n]); } else if (isAstNode(c)) visit(c, [...parents, n]); }
}
visit(ast, []);
console.log(`structural allowlist keys in logic/arrayTok/mutate roles: ${found.length}`);
for (const f of found) console.log(`  ${f.key.padEnd(10)} ${f.role.padEnd(10)} ${f.via.padEnd(18)} …${f.snippet.slice(0,90)}…`);
