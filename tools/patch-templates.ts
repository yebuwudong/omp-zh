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
	/**
	 * Alternate anchors for upstream refactors. When the footer stopped being a
	 * literal (`Enter/Space to change`) and became a keybinding lookup
	 * (`${ut("tui.select.confirm")}/${we("space")} to change`), no amount of
	 * identifier wildcarding recovers the old anchor — the literal text is
	 * simply gone. Each alternate is tried with the same exact-then-loose
	 * strategy.
	 */
	alts?: readonly string[];
}

/**
 * Verified display templates. Each anchor must appear exactly once; the tool
 * refuses to patch when it cannot prove uniqueness.
 */
export const TEMPLATE_TARGETS: readonly TemplateTarget[] = [
	{
		name: "settings footer hint",
		anchor: "`Enter/Space to change \\xB7 ${i}Type to search \\xB7 Esc to cancel`",
		// A later upstream build assembles the same line from the keybinding table.
		alts: [
			'`${ut("tui.select.confirm")}/${we("space")} to change \\xB7 ${i}Type to search \\xB7 ${ut("tui.select.cancel")} to cancel`',
		],
	},
	{
		name: "settings footer hint (jump variant)",
		anchor: "`Enter/Space to change \\xB7 ${this.#a?",
		// The same refactor renders the tab section from keybindings too.
		alts: [
			"`${e}/${we(\"space\")} to change \\xB7 ${o} \\xB7 Type to search \\xB7 ${t} to close`",
		],
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
		// Exact match for every spelling before any wildcard pass, so a bundle
		// that still carries the original literal is never re-anchored.
		const spellings = [target.anchor, ...(target.alts ?? [])];
		let idx = -1;
		let matched = "";
		for (const spelling of spellings) {
			const at = code.indexOf(spelling);
			if (at === -1) continue;
			idx = at;
			matched = spelling;
			break;
		}
		if (idx === -1) {
			// Minified identifiers are renamed on every release; retry with the
			// wildcard matcher and rewrite the anchor so the search below still
			// finds the template's opening backtick.
			for (const spelling of spellings) {
				const loose = matchLoose(code, spelling);
				if (loose.length === 0) continue;
				if (loose.length > 1) {
					missing.push(`${target.name} (anchor not unique: ${loose.length})`);
					idx = -1;
					break;
				}
				idx = loose[0].start;
				matched = spelling;
				break;
			}
			if (idx === -1) {
				if (!missing.some(m => m.startsWith(target.name))) missing.push(`${target.name} (anchor not found)`);
				continue;
			}
			const backtick = code.indexOf("`", idx);
			if (backtick === -1 || backtick - idx > matched.length + 40) {
				missing.push(`${target.name} (loose anchor has no template backtick)`);
				continue;
			}
			idx = backtick;
		} else if (code.indexOf(matched, idx + 1) !== -1) {
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
