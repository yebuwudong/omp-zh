/**
 * Audit pass 2 — classify every dict-matched literal in the 18.2.2 bundle and
 * produce translate / ban lists with per-key evidence for manual review.
 */
import { parse } from "@babel/parser";

interface AstNode {
	type: string;
	start?: number | null;
	end?: number | null;
	[key: string]: unknown;
}
const isAstNode = (v: unknown): v is AstNode =>
	typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

const CLI = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
const dict: Record<string, string> = await Bun.file("dict.json").json();
const code = await Bun.file(CLI).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true });

const CMP_OPS: Record<string, true> = { "==": true, "===": true, "!=": true, "!==": true, "<": true, ">": true, "<=": true, ">=": true };
const LOGIC_CALLS: Record<string, true> = {
	includes: true, startsWith: true, endsWith: true, indexOf: true, lastIndexOf: true, search: true,
	match: true, matchAll: true, test: true, exec: true, split: true, replace: true, replaceAll: true,
	localeCompare: true, charAt: true, slice: true, substring: true, equals: true, has: true, get: true,
	join: true, concat: true, filter: true, find: true, some: true, every: true, map: true, reduce: true,
};
const MUTATE_CALLS: Record<string, true> = { add: true, push: true, unshift: true, splice: true, set: true, insert: true, append: true };
const STYLE_CALLS: Record<string, true> = {
	fg: true, bg: true, bold: true, dim: true, italic: true, underline: true, strikethrough: true,
	inverse: true, muted: true, accent: true, success: true, error: true, warning: true, info: true, hint: true,
};
const DISPLAY_KEYS: Record<string, true> = {
	label: true, description: true, title: true, displayName: true, placeholder: true, hint: true, subtitle: true,
	helpText: true, emptyText: true, tooltip: true, about: true, notice: true, caption: true, detail: true,
	warning: true, heading: true, summary: true, message: true, text: true, prompt: true, group: true,
};
const SCHEMA_KEYS: Record<string, true> = {
	inputSchema: true, parameters: true, schema: true, properties: true, jsonSchema: true, argsSchema: true, args: true, describe: true,
};
const RISKY = /[\\\n\t\r]|\{\{|\}\}|\$\{|%\d|%s|^\s|\s$|:\/\/|[{}=;`]|^#|^--|^- /;

type Role =
	| "objKey" | "importSrc" | "directive"
	| "logic" | "arrayTok" | "mutate" | "schema"
	| "propDisplay" | "classDisplay" | "assignDisplay" | "styleCall" | "arrayElem" | "other";

interface Occ { start: number; role: Role; via: string; snippet: string }
interface KeyInfo { key: string; zh: string; occs: Occ[] }

const occsByKey = new Map<string, Occ[]>();

function classify(node: AstNode, parents: AstNode[]): { role: Role; via: string } {
	const parent = parents[parents.length - 1];
	const gp = parents[parents.length - 2];
	const parentNode = parent as AstNode | undefined;
	const keyName = (n: AstNode | undefined): string =>
		String((n?.key as AstNode | undefined)?.name ?? (n?.key as AstNode | undefined)?.value ?? "");

	if (parentNode && (parentNode.type === "ObjectProperty" || parentNode.type === "ObjectMethod" ||
		parentNode.type === "ObjectTypeProperty" || parentNode.type === "ClassProperty" || parentNode.type === "ClassMethod" ||
		parentNode.type === "PropertyDefinition") && parentNode.key === node && !parentNode.computed) {
		return { role: "objKey", via: parentNode.type };
	}
	if (parentNode && (parentNode.type.startsWith("Import") || parentNode.type.startsWith("Export")) && parentNode.source === node) {
		return { role: "importSrc", via: parentNode.type };
	}
	if (parentNode?.type === "ExpressionStatement" && gp?.type === "Program") return { role: "directive", via: "program" };
	if (parentNode?.type === "SwitchCase" && parentNode.test === node) return { role: "logic", via: "switch" };
	if (parentNode?.type === "MemberExpression" && parentNode.computed && parentNode.property === node) return { role: "logic", via: "computedMember" };
	if (parentNode?.type === "NewExpression" && (parentNode.callee as AstNode | undefined)?.name === "RegExp") return { role: "logic", via: "regexp" };
	if (parentNode?.type === "BinaryExpression" && typeof parentNode.operator === "string" && CMP_OPS[parentNode.operator] && (parentNode.left === node || parentNode.right === node)) {
		return { role: "logic", via: "cmp:" + parentNode.operator };
	}
	if (parentNode?.type === "CallExpression" && parentNode.callee) {
		const callee = parentNode.callee as AstNode;
		const propName = callee.type === "MemberExpression" ? String((callee.property as AstNode | undefined)?.name ?? "") : "";
		const fnName = String(callee.name ?? propName);
		const isArg = Array.isArray(parentNode.arguments) && parentNode.arguments.includes(node);
		if (isArg && (LOGIC_CALLS[fnName] || LOGIC_CALLS[propName])) return { role: "logic", via: "call:" + (propName || fnName) };
		if (isArg && (MUTATE_CALLS[propName] || MUTATE_CALLS[fnName])) return { role: "mutate", via: "call:" + (propName || fnName) };
		if (isArg && (STYLE_CALLS[propName] || STYLE_CALLS[fnName])) return { role: "styleCall", via: "style:" + (propName || fnName) };
	}
	// schema subtree?
	for (let i = parents.length - 1; i >= 0 && i >= parents.length - 9; i--) {
		const p = parents[i];
		if (!p) break;
		if (p.type === "ObjectProperty" && !p.computed && SCHEMA_KEYS[keyName(p)]) return { role: "schema", via: "schema:" + keyName(p) };
		if (p.type === "CallExpression" && Array.isArray(p.arguments) && p.arguments.includes(node)) {
			const c = p.callee as AstNode | undefined;
			const n = String(c?.name ?? (c?.property as AstNode | undefined)?.name ?? "");
			if (n === "describe") return { role: "schema", via: "describe" };
		}
	}
	if (parentNode && (parentNode.type === "ObjectProperty" || parentNode.type === "ClassProperty" || parentNode.type === "PropertyDefinition") &&
		parentNode.value === node && !parentNode.computed && DISPLAY_KEYS[keyName(parentNode)]) {
		return { role: "propDisplay", via: "prop:" + keyName(parentNode) };
	}
	if (parentNode?.type === "AssignmentExpression" && parentNode.right === node) {
		const left = parentNode.left as AstNode | undefined;
		if (left?.type === "MemberExpression" && !left.computed) {
			const nm = String((left.property as AstNode | undefined)?.name ?? "");
			if (DISPLAY_KEYS[nm]) return { role: "assignDisplay", via: "assign:" + nm };
		}
	}
	if (parentNode?.type === "ArrayExpression") {
		const elems = parentNode.elements.filter(Boolean) as AstNode[];
		if (elems.length >= 2 && elems.every(e => e.type === "StringLiteral")) {
			const short = elems.filter(e => typeof e.value === "string" && (e.value as string).length <= 14 && !/\s/.test(e.value as string)).length;
			if (short / elems.length >= 0.7) return { role: "arrayTok", via: `arrayTok[${elems.length}]` };
			return { role: "arrayElem", via: `array[${elems.length}]` };
		}
		return { role: "arrayElem", via: `arrayMixed[${elems.length}]` };
	}
	return { role: "other", via: parentNode?.type ?? "?" };
}

function walk(node: AstNode, parents: AstNode[]): void {
	if (node.type === "StringLiteral" && typeof node.value === "string" && typeof node.start === "number") {
		const v = node.value;
		if (dict[v] !== undefined && !RISKY.test(v)) {
			const { role, via } = classify(node, parents);
			const a = Math.max(0, node.start - 90);
			const b = Math.min(code.length, (node.end ?? node.start) + 90);
			const occ: Occ = { start: node.start, role, via, snippet: code.slice(a, b).replace(/\n/g, "↵") };
			const list = occsByKey.get(v) ?? [];
			list.push(occ);
			occsByKey.set(v, list);
		}
	}
	for (const k of Object.keys(node)) {
		if (k === "start" || k === "end" || k === "loc" || k === "range" || k === "leadingComments" || k === "trailingComments") continue;
		const child = node[k];
		if (Array.isArray(child)) { for (const c of child) if (isAstNode(c)) walk(c, [...parents, node]); }
		else if (isAstNode(child)) walk(child, [...parents, node]);
	}
}
walk(ast as unknown as AstNode, []);

// ── decision ───────────────────────────────────────────────────────────────
const BAN_ROLES: Record<string, true> = { objKey: true, importSrc: true, directive: true, logic: true, arrayTok: true, mutate: true };
const TRANSLATABLE_ROLES: Record<string, true> = { propDisplay: true, classDisplay: true, assignDisplay: true, styleCall: true, arrayElem: true, other: true };

interface Verdict { key: string; zh: string; occs: Occ[]; decision: "translate" | "ban"; reason: string }
const verdicts: Verdict[] = [];
for (const [key, occs] of occsByKey) {
	const banned = occs.find(o => BAN_ROLES[o.role]);
	let decision: Verdict["decision"] = "translate";
	let reason = "";
	if (banned) { decision = "ban"; reason = `${banned.role}:${banned.via}`; }
	else {
		const single = !/\s/.test(key);
		const lower = key === key.toLowerCase() && !/[_.\-]/.test(key);
		const displayEvidence = occs.some(o => o.role === "propDisplay" || o.role === "classDisplay" || o.role === "assignDisplay" || o.role === "styleCall");
		const otherCount = occs.filter(o => o.role === "other").length;
		if (lower) { decision = "ban"; reason = "lowercase-token"; }
		else if (single && !displayEvidence) { decision = "ban"; reason = "single-word-no-display-evidence"; }
		else if (otherCount > 0 && !displayEvidence) { decision = "ban"; reason = "other-only"; }
		else if (single && otherCount > 0) { decision = "ban"; reason = `single-word-other(${occs.find(o=>o.role==="other")?.via})`; }
	}
	verdicts.push({ key, zh: dict[key], occs, decision, reason });
}

const trans = verdicts.filter(v => v.decision === "translate");
const bans = verdicts.filter(v => v.decision === "ban");
console.log(`keys matched in bundle: ${verdicts.length}`);
console.log(`TRANSLATE: ${trans.length} keys / ${trans.reduce((a, v) => a + v.occs.length, 0)} occurrences`);
console.log(`BAN: ${bans.length} keys`);
const banReasons = new Map<string, number>();
for (const b of bans) { const c = b.reason.split(/[(:]/)[0]; banReasons.set(c, (banReasons.get(c) ?? 0) + 1); }
console.log("\nban reasons:");
for (const [r, n] of [...banReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

// write details for review
const detailLines: string[] = [];
for (const v of trans) {
	detailLines.push(`\n===== ${JSON.stringify(v.key)} → ${JSON.stringify(v.zh)}  (${v.occs.length} occ)`);
	for (const o of v.occs) detailLines.push(`  [${o.role}|${o.via}] ${o.snippet}`);
}
await Bun.write("review-translate.txt", detailLines.join("\n"));

const banLines: string[] = [];
for (const b of bans) {
	banLines.push(`\n===== ${JSON.stringify(b.key)}  reason=${b.reason}  (${b.occs.length} occ)`);
	const seen = new Set<string>();
	for (const o of b.occs) { const sig = `${o.role}|${o.via}`; if (seen.has(sig)) continue; seen.add(sig); banLines.push(`  [${sig}] ${o.snippet}`); }
}
await Bun.write("review-ban.txt", banLines.join("\n"));

const single = trans.filter(v => !/\s/.test(v.key));
console.log(`\nTRANSLATE single-word keys: ${single.length}`);
console.log(single.map(v => JSON.stringify(v.key)).join(" "));
const arrOnly = trans.filter(v => v.occs.every(o => o.role === "arrayElem"));
console.log(`\narrayElem-only keys: ${arrOnly.length}`);
console.log(arrOnly.slice(0, 80).map(v => JSON.stringify(v.key)).join(" "));
