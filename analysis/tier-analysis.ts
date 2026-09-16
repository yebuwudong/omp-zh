import { parse } from "@babel/parser";
const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string,string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });

const PROP_KEYS = new Set(["label","description","title","displayName","placeholder","hint","subtitle","helpText","emptyText","tooltip","about","notice","caption","detail","warning"]);
const DISPLAY_CALLS = new Set(["fg","bold","dim","italic","underline","strikethrough","inverse","accent","muted","success","error","warning","info"]);

const counts = { s1: 0, s2: 0, s3extra: 0, total: 0 };
const s1Keys = new Set<string>(), s2extra = new Set<string>(), s3extra = new Set<string>();
const logicCtx = /cmp:|switch|computed|call:(includes|startsWith|endsWith|indexOf|search|match|test|exec|split|replace|localeCompare|charAt)|regexp|token-array/;
const risky = /[\\\n\t\r]|\{\{|\}\}|\$\{|%\d|^\s|\s$|:\/\//;

function inLogic(node: any, parents: any[]): boolean {
  const CMP = new Set(["==","===","!=","!==","<",">","<=",">="]);
  const LOGIC_CALLS = new Set(["includes","startsWith","endsWith","indexOf","lastIndexOf","search","match","matchAll","test","exec","split","replace","replaceAll","padStart","padEnd","localeCompare","charAt","slice","substring","equals","has"]);
  for (let i = parents.length - 1; i >= 0 && i >= parents.length - 6; i--) {
    const p = parents[i]; if (!p) break;
    if (p.type === "BinaryExpression" && CMP.has(p.operator) && (p.left === node || p.right === node)) return true;
    if (p.type === "SwitchCase") return true;
    if (p.type === "MemberExpression" && p.computed && p.property === node) return true;
    if (p.type === "CallExpression" && p.callee?.type === "MemberExpression" && LOGIC_CALLS.has(p.callee.property?.name) && p.arguments?.includes(node)) return true;
    if (p.type === "NewExpression" && p.callee?.name === "RegExp") return true;
  }
  return false;
}

function walk(node: any, parents: any[]) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walk(c, parents); return; }
  if (node.type === "StringLiteral" && typeof node.value === "string" && dict[node.value] !== undefined && !risky.test(node.value)) {
    const v: string = node.value;
    const parent = parents[parents.length - 1];
    const gp = parents[parents.length - 2];
    const isObjKey = parent && (parent.type === "ObjectProperty" || parent.type === "ObjectMethod") && parent.key === node && !parent.computed;
    const isSrc = parent && parent.type.startsWith("Export") || parent?.type?.startsWith("Import");
    if (!isObjKey && !(parent?.type?.startsWith("Import") || parent?.type?.startsWith("Export"))) {
      counts.total++;
      // S1: property value of display-ish key
      let tier = "";
      if (parent?.type === "ObjectProperty" && parent.value === node && !parent.computed && PROP_KEYS.has(String(parent.key?.name ?? parent.key?.value))) {
        tier = "S1"; counts.s1++; s1Keys.add(v);
      } else if (parent?.type === "CallExpression" && parent.callee?.type === "MemberExpression" && DISPLAY_CALLS.has(String(parent.callee.property?.name))) {
        tier = "S2"; counts.s2++; s2extra.add(v);
      } else if (!inLogic(node, parents)) {
        tier = "S3"; counts.s3extra++; s3extra.add(v);
      }
    }
  }
  for (const k in node) { if (k==="start"||k==="end"||k==="loc"||k==="range") continue; const v = node[k]; if (v && typeof v === "object") walk(v, [...parents, node]); }
}
walk(ast, []);
console.log(`matched occurrences: ${counts.total}`);
console.log(`S1 prop-whitelist:   ${counts.s1} occ, ${s1Keys.size} unique keys`);
console.log(`S2 display-call:     ${counts.s2} occ, ${s2extra.size} unique keys (new)`);
console.log(`S3 other non-logic:  ${counts.s3extra} occ, ${s3extra.size} unique keys (new)`);
const s2only = [...s2extra].filter(k => !s1Keys.has(k));
const s3only = [...s3extra].filter(k => !s1Keys.has(k) && !s2extra.has(k));
console.log(`\nS2 exclusive keys sample:`);
for (const k of s2only.slice(0, 25)) console.log(`  ${JSON.stringify(k)}`);
console.log(`\nS3 exclusive keys sample (highest value for UI chrome?):`);
for (const k of s3only.slice(0, 40)) console.log(`  ${JSON.stringify(k)}`);
await Bun.write("tiers.json", JSON.stringify({ s1: [...s1Keys], s2: s2only, s3: s3only }, null, 0));
