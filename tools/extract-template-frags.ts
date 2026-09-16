#!/usr/bin/env bun
/**
 * Collect English UI fragments from template literals that sit in DISPLAY
 * positions (arguments of rendering calls, values of display-ish properties).
 *
 * Those literals concatenate with runtime values, so the literal-level patcher
 * cannot translate them. The fix is to wrap the whole template in a fragment
 * translator at runtime; this tool produces the fragment vocabulary that
 * translator needs.
 *
 *   bun tools/extract-template-frags.ts
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
const CLI_PATH = path.join(PKG, "dist/cli.js");

const base: Record<string, string> = await Bun.file(path.join(WORK, "dict.json")).json();
const extra: Record<string, string> = await Bun.file(path.join(WORK, "dict-extra.json")).json();
const merged: Record<string, string> = { ...base };
for (const [k, v] of Object.entries(extra)) if (v !== k) merged[k] = v;

const code = await Bun.file(CLI_PATH).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

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
const nameOf = (n: AstNode | undefined): string => (n === undefined ? "" : String(n.name ?? ""));
const propNameOf = (m: AstNode | undefined): string => {
	if (!m || m.type !== "MemberExpression" || m.computed) return "";
	return nameOf(m.property as AstNode | undefined);
};
const propKeyOf = (n: AstNode): string => {
	const k = n.key as AstNode | undefined;
	if (!k) return "";
	return k.type === "Identifier" ? String(k.name ?? "") : String(k.value ?? "");
};

/** Static fragment shapes worth translating; everything else is code/data. */
const NOISE = /(SQL|INSERT|DELETE|ALTER|SELECT|UPDATE|CREATE\s+TABLE|PRAGMA|VALUES|FROM\s)|(Object\.|getOwnProperty|prototype|__\w+__)|(@[a-z]|\{\{|\$\{|%[sd])|^[/{}()\[\];=<>|&*#@$%^~`+]/;

interface Frag { text: string; count: number; sample: string }
const frags = new Map<string, Frag & { positions: number[] }>();

const visit = (node: AstNode, parents: AstNode[]): void => {
	if (node.type === "TemplateLiteral" && typeof node.start === "number") {
		const exprs = node.expressions as unknown[] | undefined;
		const quasis = node.quasis as AstNode[] | undefined;
		if (Array.isArray(exprs) && exprs.length > 0 && Array.isArray(quasis)) {
			// Is this template in a display position?
			const parent = parents[parents.length - 1];
			let displayRole = "";
			if (parent?.type === "CallExpression" && Array.isArray(parent.arguments) && parent.arguments.includes(node)) {
				const callee = parent.callee as AstNode | undefined;
				const calleeName = callee?.type === "MemberExpression" ? propNameOf(callee) : nameOf(callee);
				if (STYLE_CALLS[calleeName]) displayRole = "call:" + calleeName;
			}
			if (!displayRole && parent?.type === "ObjectProperty" && parent.value === node && DISPLAY_KEYS[propKeyOf(parent)]) {
				displayRole = "prop:" + propKeyOf(parent);
			}
			if (!displayRole && parent?.type === "VariableDeclarator") displayRole = "var";
			if (!displayRole && parent?.type === "AssignmentExpression" && parent.right === node) displayRole = "assign";
			if (displayRole) {
				// collect every static quasi that carries copy
				for (const q of quasis) {
					const raw = String((q.value as { cooked?: unknown } | undefined)?.cooked ?? "");
					const text = raw;
					if (text.trim().length < 6) continue;
					if (!/[A-Za-z]{2}/.test(text)) continue;
					if (NOISE.test(text.trim())) continue;
					if (merged[text] !== undefined) continue; // already handled as a literal
					const words = text.trim().split(/\s+/).filter(Boolean);
					if (words.length < 2) continue;
					const prev = frags.get(text);
					if (prev) { prev.count++; prev.positions.push(node.start); }
					else frags.set(text, {
						text, count: 1, positions: [node.start],
						sample: (displayRole + " · " + text.replace(/\n/g, "\\n")).slice(0, 110),
					});
				}
			}
		}
	}
	for (const k of Object.keys(node)) {
		if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
		const c = node[k];
		if (Array.isArray(c)) { for (const x of c) if (isAstNode(x)) visit(x, [...parents, node]); }
		else if (isAstNode(c)) visit(c, [...parents, node]);
	}
};
visit(ast, []);

const list = [...frags.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
console.log(`display-position template fragments needing translation: ${list.length}`);
console.log(`total occurrences: ${list.reduce((a, f) => a + f.count, 0)}`);

const CHUNK = 150;
const chunks = Math.ceil(list.length / CHUNK);
for (let i = 0; i < chunks; i++) {
	const slice = list.slice(i * CHUNK, (i + 1) * CHUNK);
	await Bun.write(path.join(WORK, `frags-chunk-${String(i).padStart(2, "0")}.json`),
		JSON.stringify(slice.map(f => ({ en: f.text, ctx: f.sample.split(" · ")[0] })), null, 1));
}
console.log(`\nwrote ${chunks} fragment chunks (frags-chunk-NN.json)`);
console.log("\nsample:");
for (const f of list.slice(0, 30)) console.log(`  ×${f.count}  ${JSON.stringify(f.text.slice(0, 90))}`);
