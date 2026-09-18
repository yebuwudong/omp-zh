#!/usr/bin/env bun
/**
 * Extract display-position English strings that are NOT yet in the dictionary.
 *
 * Uses the same role classifier as patch.ts, then reports what is missing in
 * each display role so the gap can be translated.
 *
 *   bun tools/extract-gaps.ts            # summary + full list
 *   bun tools/extract-gaps.ts settings   # only settings-schema ui blocks
 */

import { parse } from "@babel/parser";
import * as path from "node:path";

interface AstNode {
	type: string;
	start?: number | null;
	end?: number | null;
	[key: string]: unknown;
}
const isAstNode = (v: unknown): v is AstNode =>
	typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

const WORK = path.resolve(import.meta.dir, "..");
const PKG = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent";
const CLI_PATH = process.env.OMP_ZH_SRC ? process.env.OMP_ZH_SRC : path.join(PKG, "dist/cli.js");

const dict: Record<string, string> = { ...(await Bun.file(path.join(WORK, "dict.json")).json()), ...(await Bun.file(path.join(WORK, "dict-extra.json")).json()) };
const code = await Bun.file(CLI_PATH).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

const childrenOf = (node: AstNode): AstNode[] => {
	const out: AstNode[] = [];
	for (const k of Object.keys(node)) {
		if (k === "start" || k === "end" || k === "loc" || k === "range" || k === "leadingComments" || k === "trailingComments") continue;
		const v = node[k];
		if (Array.isArray(v)) { for (const c of v) if (isAstNode(c)) out.push(c); }
		else if (isAstNode(v)) out.push(v);
	}
	return out;
};
const nameOf = (n: AstNode | undefined): string => (n === undefined ? "" : String(n.name ?? ""));
const propKeyOf = (node: AstNode): string => {
	const key = node.key as AstNode | undefined;
	if (!key) return "";
	if (key.type === "Identifier") return String(key.name ?? "");
	return key.type === "StringLiteral" ? String(key.value ?? "") : "";
};
const propNameOf = (member: AstNode | undefined): string => {
	if (!member || member.type !== "MemberExpression" || member.computed) return "";
	return nameOf(member.property as AstNode | undefined);
};

const STYLE_CALLS: Record<string, true> = {
	fg: true, bg: true, bold: true, dim: true, italic: true, underline: true, strikethrough: true,
	inverse: true, muted: true, accent: true, success: true, error: true, warning: true, info: true, hint: true,
	showStatus: true, showWarning: true, showError: true, showInfo: true, setStatus: true, output: true,
	notice: true, notify: true, toast: true, print: true, log: true, write: true, render: true, pe: true,
};
const DISPLAY_KEYS: Record<string, true> = {
	label: true, description: true, title: true, displayName: true, placeholder: true, hint: true,
	subtitle: true, helpText: true, emptyText: true, tooltip: true, about: true, notice: true,
	caption: true, detail: true, warning: true, heading: true, message: true, text: true,
	selectorText: true, tips: true, footer: true, header: true,
};
const MODEL_FACING_SIBLINGS: Record<string, true> = {
	parameters: true, inputSchema: true, loadMode: true, summary: true,
};

/** Skip strings that are code, flags, paths, or placeholders rather than prose. */
const NON_PROSE = /[\\\n\t\r]|\{\{|\}\}|\$\{|%\d|%s|:\/\/|[{}=;`~|<>]|^--|^- |^\/|^@|^[A-Z_]{3,}$/;
/** Prose test: has a space or looks like a sentence. */
const PROSE_LIKE = /[\s]|^[A-Z][a-z]{3,}[.!?…]?$/;

interface Gap {
	value: string;
	role: string;
	via: string;
	count: number;
	snippet: string;
}

const gaps = new Map<string, Gap>();

const classify = (node: AstNode, parents: AstNode[]): { role: string; via: string } => {
	const parent = parents[parents.length - 1];
	const grand = parents[parents.length - 2];

	if (parent && (parent.type === "ObjectProperty" || parent.type === "ClassProperty" || parent.type === "PropertyDefinition")) {
		const key = propKeyOf(parent);
		if (parent.value === node && !parent.computed && DISPLAY_KEYS[key]) {
			// model-facing guard（CLI 参数定义 `ns.*({description, required})` 属于 --help 文本，放行）
			const enclosing = parents[parents.length - 2];
			if (enclosing?.type === "ObjectExpression") {
				const siblings = (enclosing.properties as AstNode[]).filter(p => isAstNode(p) && p.type === "ObjectProperty");
				const nsCall = grand?.type === "ObjectProperty" &&
					(grand.value as AstNode | undefined)?.type === "CallExpression" &&
					((grand.value as AstNode).callee as AstNode | undefined)?.type === "MemberExpression" &&
					nameOf((((grand.value as AstNode).callee as AstNode).object) as AstNode | undefined) === "ns";
				if (!nsCall && siblings.map(propKeyOf).some(n => MODEL_FACING_SIBLINGS[n])) return { role: "skip", via: "modelFacing" };
				if (grand?.type === "ObjectProperty" && propKeyOf(grand) === "properties") return { role: "skip", via: "jsonSchema" };
			}
			if (enclosing?.type === "ClassBody") return { role: "skip", via: "toolClass" };
			return { role: parent.type === "ObjectProperty" ? "propDisplay" : "classDisplay", via: key };
		}
	}
	if (parent?.type === "CallExpression" && parent.callee) {
		const callee = parent.callee as AstNode;
		const calleeName = callee.type === "MemberExpression" ? propNameOf(callee) : nameOf(callee);
		if (Array.isArray(parent.arguments) && parent.arguments.includes(node) && STYLE_CALLS[calleeName]) {
			return { role: "styleCall", via: calleeName };
		}
	}
	return { role: "skip", via: parent?.type ?? "?" };
};

const visit = (node: AstNode, parents: AstNode[]): void => {
	if (node.type === "StringLiteral" && typeof node.value === "string" && typeof node.start === "number") {
		const value = node.value;
		// Control sequences (ANSI styling) are not copy: they must never enter
		// the gap list, or the translator would "translate" escape codes.
		if (dict[value] === undefined && !/[\u001b\x00-\x08\x0e-\x1f]/.test(value) &&
			/[A-Za-z]{2,}/.test(value) && !NON_PROSE.test(value) && PROSE_LIKE.test(value) && value.length >= 4) {
			const { role, via } = classify(node, parents);
			if (role !== "skip") {
				const prev = gaps.get(value);
				if (prev) prev.count++;
				else {
					gaps.set(value, {
						value, role, via, count: 1,
						snippet: code.slice(Math.max(0, node.start - 70), Math.min(code.length, node.start + 100)).replace(/\n/g, "↵"),
					});
				}
			}
		}
	}
	for (const child of childrenOf(node)) visit(child, [...parents, node]);
};
visit(ast, []);

const list = [...gaps.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
const byRole = new Map<string, number>();
for (const g of list) byRole.set(g.role, (byRole.get(g.role) ?? 0) + 1);

console.log(`bundle: ${(code.length / 1e6).toFixed(1)}MB, dict entries: ${Object.keys(dict).length}`);
console.log(`untranslated display strings: ${list.length}`);
console.log("\nby role:");
for (const [r, n] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

const mode = process.argv[2] ?? "all";
const filtered = mode === "settings" ? list.filter(g => g.role === "propDisplay" || g.role === "classDisplay") : list;

console.log(`\n--- ${filtered.length} strings ---`);
for (const g of filtered) {
	console.log(`${JSON.stringify(g.value)}\t[${g.role}|${g.via}] x${g.count}`);
}

// Machine-readable output for tools/auto-translate.ts: `--json <path>`.
// Includes the snippet so the translator sees the call site, and the role so
// it can skip anything that looks like an identifier.
const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
	const payload = {
		generatedAt: new Date().toISOString(),
		source: CLI_PATH,
		entries: filtered.map(g => ({ key: g.value, role: g.role, via: g.via, count: g.count, snippet: g.snippet })),
	};
	await Bun.write(process.argv[jsonIdx + 1], JSON.stringify(payload, null, 2));
	console.log(`→ ${process.argv[jsonIdx + 1]} (${filtered.length} entries)`);
}

const tsv = filtered.map(g => `${JSON.stringify(g.value)}\t${g.role}\t${g.via}\t${g.count}`).join("\n") + "\n";
await Bun.write(path.join(WORK, "report-gaps.tsv"), tsv);
await Bun.write(path.join(WORK, "report-gaps-detail.txt"),
	filtered.map(g => `\n===== ${JSON.stringify(g.value)}  [${g.role}|${g.via}] x${g.count}\n  …${g.snippet}…`).join("\n"));
console.log(`\n→ report-gaps.tsv / report-gaps-detail.txt`);
