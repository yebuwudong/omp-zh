#!/usr/bin/env bun
/**
 * Targeted template-literal wrapping.
 *
 * A handful of UI hints are built by concatenating a runtime value into a
 * template (`Enter/Space to change · ${x}Type to search · Esc to close`).
 * They never exist as standalone string literals, so the literal patcher
 * cannot reach them and the result stays half-English.
 *
 * This tool wraps specific templates in `__omp_i18n_f(...)`, the runtime
 * fragment translator. Each target is located by a unique anchor in the
 * PRISTINE bundle so offsets stay stable across re-applies.
 *
 *   bun tools/patch-templates.ts list    # show targets and whether anchors resolve
 *   bun tools/patch-templates.ts apply   # (invoked by patch.ts apply)
 */

import * as path from "node:path";
import { matchLoose } from "./loose-anchor";

export interface TemplateTarget {
	/** Human label for reports. */
	name: string;
	/** Unique substring in the pristine bundle identifying the template's backtick. */
	anchor: string;
}

/**
 * Verified display templates. Each anchor must appear exactly once; the tool
 * refuses to patch when it cannot prove uniqueness.
 */
export const TEMPLATE_TARGETS: readonly TemplateTarget[] = [
	{
		name: "settings footer hint",
		anchor: "`Enter/Space to change \\xB7 ${i}Type to search \\xB7 Esc to cancel`",
	},
	{
		name: "settings footer hint (jump variant)",
		anchor: "`Enter/Space to change \\xB7 ${this.#a?",
	},
];

export interface WrapOp {
	name: string;
	start: number;
	end: number;
}

/** Locate each template literal's exact [start,end) span in `code`. */
export const locateTemplates = (code: string): { ops: WrapOp[]; missing: string[] } => {
	const ops: WrapOp[] = [];
	const missing: string[] = [];
	for (const target of TEMPLATE_TARGETS) {
		let idx = code.indexOf(target.anchor);
		if (idx === -1) {
			// Minified identifiers are renamed on every release; retry with the
			// wildcard matcher and rewrite the anchor so the search below still
			// finds the template's opening backtick.
			const loose = matchLoose(code, target.anchor);
			if (loose.length === 0) {
				missing.push(`${target.name} (anchor not found)`);
				continue;
			}
			if (loose.length > 1) {
				missing.push(`${target.name} (anchor not unique: ${loose.length})`);
				continue;
			}
			idx = loose[0].start;
			const backtick = code.indexOf("`", idx);
			if (backtick === -1 || backtick - idx > target.anchor.length + 40) {
				missing.push(`${target.name} (loose anchor has no template backtick)`);
				continue;
			}
			idx = backtick;
		} else if (code.indexOf(target.anchor, idx + 1) !== -1) {
			missing.push(`${target.name} (anchor not unique)`);
			continue;
		}
		// anchor starts at the template's opening backtick
		const start = idx;
		let end = -1;
		let depth = 0;
		for (let i = start + 1; i < code.length; i++) {
			const ch = code[i];
			if (ch === "\\") { i++; continue; }
			if (ch === "$" && code[i + 1] === "{") { depth++; i++; continue; }
			if (ch === "}") { if (depth > 0) { depth--; continue; } }
			if (ch === "`" && depth === 0) { end = i + 1; break; }
		}
		if (end === -1) {
			missing.push(`${target.name} (unterminated template)`);
			continue;
		}
		ops.push({ name: target.name, start, end });
	}
	ops.sort((a, b) => a.start - b.start);
	return { ops, missing };
};

if (import.meta.main) {
	const cmd = process.argv[2] ?? "list";
	const PKG = "/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent";
	const BACKUP = path.join(path.dirname(import.meta.dir), "backup", "cli.js.orig-pristine");
	const code = await Bun.file(cmd === "apply" ? PKG + "/dist/cli.js" : BACKUP).text();
	const { ops, missing } = locateTemplates(code);
	console.log(`targets: ${TEMPLATE_TARGETS.length}, located: ${ops.length}, missing: ${missing.length}`);
	for (const op of ops) {
		console.log(`  [ok] ${op.name}  @${op.start}..${op.end} (${op.end - op.start} chars)`);
		console.log(`       ${JSON.stringify(code.slice(op.start, Math.min(op.end, op.start + 100)))}`);
	}
	for (const m of missing) console.log(`  [MISS] ${m}`);
}
