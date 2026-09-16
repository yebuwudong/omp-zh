/**
 * Extract every string literal passed to localizeUiText()/t() in the fork's
 * own (already-shipped) localization call sites. Those sites are proven-safe:
 * the fork maintainers chose them precisely because they are display-only.
 */
import { parse } from "@babel/parser";
import * as path from "node:path";
import * as fs from "node:fs/promises";

interface AstNode {
	type: string;
	start?: number | null;
	end?: number | null;
	[k: string]: unknown;
}
const isAstNode = (v: unknown): v is AstNode =>
	typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

const FORK = "/home/yebu/oh-my-pi-cn-work/fork/packages";
const ROOTS = [path.join(FORK, "coding-agent/src"), path.join(FORK, "tui/src")];
const OUT = path.join(import.meta.dir, "whitelist.json");

const FN_NAMES: Record<string, true> = { localizeUiText: true, t: true };

async function collectFiles(dir: string, acc: string[]): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name === "node_modules") continue; await collectFiles(p, acc); }
		else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) acc.push(p);
	}
}

const files: string[] = [];
for (const root of ROOTS) await collectFiles(root, files);

const literals = new Set<string>();
const templates: string[] = [];
let callSites = 0;

for (const file of files) {
	const src = await Bun.file(file).text();
	let ast: AstNode;
	try {
		ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true }) as unknown as AstNode;
	} catch { continue; }

	function walk(node: AstNode): void {
		if (node.type === "CallExpression") {
			const callee = node.callee as AstNode | undefined;
			const name = String(callee?.name ?? (callee?.type === "MemberExpression" ? (callee?.property as AstNode | undefined)?.name : "") ?? "");
			if (callee?.type === "Identifier" && FN_NAMES[name] && Array.isArray(node.arguments) && node.arguments.length > 0) {
				callSites++;
				const first = node.arguments[0] as AstNode | undefined;
				if (first?.type === "StringLiteral" && typeof first.value === "string") literals.add(first.value);
				else if (first?.type === "TemplateLiteral") {
					const quasis = first.quasis as AstNode[];
					const exprs = first.expressions as AstNode[];
					if (exprs.length === 0 && quasis.length === 1) {
						const raw = String((quasis[0].value as { raw?: unknown })?.raw ?? "");
						if (!raw.includes("\n")) literals.add(raw.replace(/\\([`$\\])/g, "$1"));
					} else {
						templates.push(`${file}: ${src.slice(first.start ?? 0, first.end ?? 0).replace(/\n/g, " ").slice(0, 150)}`);
					}
				}
			}
		}
		for (const k of Object.keys(node)) {
			if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
			const child = node[k];
			if (Array.isArray(child)) { for (const c of child) if (isAstNode(c)) walk(c); }
			else if (isAstNode(child)) walk(child);
		}
	}
	walk(ast);
}

const list = [...literals].sort();
await Bun.write(OUT, JSON.stringify(list, null, 0));
console.log(`files scanned: ${files.length}`);
console.log(`localizeUiText/t call sites: ${callSites}`);
console.log(`unique literal arguments: ${list.length}`);
console.log(`\nsample:`);
for (const s of list.slice(0, 40)) console.log(`  ${JSON.stringify(s)}`);
console.log(`\ntemplate-with-expressions sites (need manual handling): ${templates.length}`);
for (const s of templates.slice(0, 10)) console.log(`  ${s}`);
