#!/usr/bin/env bun
/**
 * Extract English UI fragments from template-literal quasis.
 *
 * Concatenated hints ("Enter/Space to change · ${x}Type to search · Esc to
 * cancel") never exist as standalone string literals, so the literal-level
 * patcher cannot see them. This tool collects the static parts of template
 * literals that look like UI copy, then reports which ones lack a translation
 * in the merged dictionary so a fragment table can be built.
 *
 *   bun tools/extract-fragments.ts
 */

import { parse } from "@babel/parser";
import * as path from "node:path";

interface AstNode {
	type: string;
	start?: number | null;
	end?: number | null;
	[k: string]: unknown;
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

/** Fragments that are pure UI copy: contain letters, look like words/instructions. */
const UI_FRAGMENT = /[A-Za-z]{2}/;
/** Exclude template placeholders, code, paths. */
const NON_COPY = /\{\{|[\w.\-/]+\.(?:ts|js|json|md|py|rs|go|toml|yml|yaml)\b|:\/\/|[{}=;`]|^--|\$[A-Z_]+|@[a-z]/;

interface Frag {
	text: string;
	start: number;
	len: number;
	leftContext: string;
	rightContext: string;
}

const frags = new Map<string, Frag[]>();

const visit = (node: AstNode): void => {
	if (node.type === "TemplateLiteral") {
		const quasis = node.quasis as AstNode[] | undefined;
		const exprs = node.expressions as unknown[] | undefined;
		if (Array.isArray(quasis) && Array.isArray(exprs) && exprs.length > 0) {
			// only templates with interpolation: pure templates are covered by the literal scan
			for (let i = 0; i < quasis.length; i++) {
				const q = quasis[i];
				const raw = String((q.value as { cooked?: unknown } | undefined)?.cooked ?? (q.value as { raw?: unknown } | undefined)?.raw ?? "");
				if (typeof q.start !== "number" || typeof q.end !== "number") continue;
				// strip the surrounding backticks/`${` markers from the source range
				const src = code.slice(q.start, q.end);
				const text = raw;
				if (text.length < 6) continue;
				if (!UI_FRAGMENT.test(text)) continue;
				if (NON_COPY.test(text)) continue;
				// skip fragments that are just separators/whitespace with one word
				const words = text.trim().split(/\s+/).filter(Boolean);
				if (words.length < 2 && text.trim().length < 12) continue;
				const arr = frags.get(text) ?? [];
				arr.push({
					text,
					start: q.start,
					len: src.length,
					leftContext: i > 0 ? "«expr»" : "",
					rightContext: i < quasis.length - 1 ? "«expr»" : "",
				});
				frags.set(text, arr);
			}
		}
	}
	for (const k of Object.keys(node)) {
		if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
		const c = node[k];
		if (Array.isArray(c)) { for (const x of c) if (isAstNode(x)) visit(x); }
		else if (isAstNode(c)) visit(c);
	}
};
visit(ast);

const all = [...frags.entries()].sort((a, b) => b[1].length - a[1].length);
const untranslated = all.filter(([text]) => merged[text] === undefined);
const translated = all.filter(([text]) => merged[text] !== undefined);

console.log(`template fragments (with interpolation): ${all.length}`);
console.log(`  already covered by dict: ${translated.length}`);
console.log(`  needing translation:     ${untranslated.length}`);

console.log(`\n--- NEEDING TRANSLATION (${untranslated.length}) ---`);
for (const [text, occ] of untranslated) {
	const t = text.replace(/\n/g, "\\n");
	console.log(`${JSON.stringify(t)}\t×${occ.length}\t${occ[0].leftContext}${occ[0].rightContext}`);
}

await Bun.write(path.join(WORK, "report-fragments.tsv"),
	untranslated.map(([text, occ]) => `${JSON.stringify(text)}\t${occ.length}`).join("\n") + "\n");

const covered = translated.map(([text]) => text);
await Bun.write(path.join(WORK, "fragments-covered.json"), JSON.stringify(covered, null, 1));
console.log(`\n→ report-fragments.tsv (${untranslated.length}) / fragments-covered.json (${covered.length})`);
