#!/usr/bin/env bun
/**
 * Detect dictionary entries that can never take effect.
 *
 * A translation only reaches the screen when the bundle passes the string
 * through a helper. Two failure modes have bitten this project:
 *
 *   1. A key exists in dict-extra.json, but the bundle has no call site that
 *      consults it (the occurrence sits in a logic position the scan skips, or
 *      the template it belongs to is never wrapped in the fragment helper).
 *   2. A template's static fragments were translated, but the template itself
 *      was never wrapped, so the fragments are looked up against nothing.
 *
 * This tool parses the PATCHED bundle, collects every key the helpers can be
 * asked about (literal arguments, plus the fragment table contents), and
 * reports dictionary keys that no call site can reach. Run it after apply:
 *
 *   bun tools/check-orphan-entries.ts [--json report.json]
 *
 * Exit code 1 when orphan keys exist, so CI catches regressions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "@babel/parser";

const WORK = path.dirname(import.meta.dir);
const cliArg = process.argv.find(a => a.startsWith("--code="))?.slice(7);
const jsonArg = process.argv.find(a => a.startsWith("--json="))?.slice(7);

const resolveCli = (): string => {
	if (cliArg) return cliArg;
	// Ask the patcher, which knows about sidecar installs.
	const proc = Bun.spawnSync(["bun", path.join(WORK, "patch.ts"), "path"], { cwd: WORK });
	const out = proc.stdout.toString().trim().split("\n").filter(Boolean).pop();
	if (!out) throw new Error("cannot resolve cli.js (run `bun patch.ts path`)");
	return out;
};

const code = fs.readFileSync(resolveCli(), "utf8");
const ast = parse(code, { sourceType: "module", errorRecovery: true });

/** Keys reachable through a helper call. */
const reached = new Set<string>();
/** Fragment keys the runtime table can substitute. */
const fragKeys = new Set<string>();

const nameOf = (n: any): string | undefined => {
	if (!n) return undefined;
	if (n.type === "Identifier") return n.name;
	if (n.type === "MemberExpression" && !n.computed && n.property?.name) return n.property.name;
	return undefined;
};

const walk = (n: any): void => {
	if (!n || typeof n !== "object") return;
	if (n.type === "CallExpression") {
		const callee = nameOf(n.callee);
		if (callee === "__omp_i18n_t" || callee === "__omp_i18n_block") {
			const a = n.arguments?.[0];
			if (a?.type === "StringLiteral" && typeof a.value === "string") reached.add(a.value);
		}
		if (callee === "__omp_i18n_f") {
			const a = n.arguments?.[0];
			if (a?.type === "StringLiteral" && typeof a.value === "string") {
				reached.add(a.value);
			}
			// A fragment-wrapped template also lets every fragment key apply.
			if (a?.type === "TemplateLiteral") {
				for (const q of a.quasis ?? []) {
					const cooked = String(q.value.cooked ?? q.value.raw ?? "");
					if (cooked) fragKeys.add(cooked);
				}
			}
		}
	}
	for (const k of Object.keys(n)) {
		if (k === "loc" || k === "start" || k === "end") continue;
		const v = n[k];
		if (Array.isArray(v)) v.forEach(c => c && c.type && walk(c));
		else if (v && v.type) walk(v);
	}
};

walk(ast);

// The runtime dictionary and fragment keys are injected literals at the top of
// the bundle. Keys listed there are only *potential*; a key is orphaned when no
// call site can ever ask for it.
// The dictionary is a single-line literal but its value contains `};` sequences
// inside strings, so brace matching (not a lazy regex) is required.
const prologueAt = code.indexOf("var __omp_i18n_d=");
if (prologueAt < 0) throw new Error("dictionary prologue not found — is this bundle patched?");
const dictStart = code.indexOf("{", prologueAt);
let depth = 0, dictEnd = -1, inStr = false, esc = false;
for (let i = dictStart; i < code.length; i++) {
	const ch = code[i];
	if (inStr) {
		if (esc) { esc = false; continue; }
		if (ch === "\\") { esc = true; continue; }
		if (ch === '"') inStr = false;
		continue;
	}
	if (ch === '"') { inStr = true; continue; }
	if (ch === "{") depth++;
	else if (ch === "}") { depth--; if (depth === 0) { dictEnd = i; break; } }
}
if (dictEnd < 0) throw new Error("unterminated dictionary literal");
const runtimeDict: Record<string, string> = JSON.parse(code.slice(dictStart, dictEnd + 1));

// Keys reached either directly or as a fragment of a wrapped template.
const usable = (key: string): boolean => {
	if (reached.has(key)) return true;
	for (const frag of fragKeys) {
		if (frag === key) return true;
		// Fragment substitution: if this key appears inside a wrapped template's
		// static text, the runtime can substitute it.
		if (frag.includes(key)) return true;
	}
	return false;
};

const orphans = Object.keys(runtimeDict).filter(k => !usable(k));

console.log(`runtime dictionary keys: ${Object.keys(runtimeDict).length}`);
console.log(`  reachable via helper: ${reached.size}`);
console.log(`  wrapped-template fragments: ${fragKeys.size}`);
console.log(`  orphan (translated but unreachable): ${orphans.length}`);

if (orphans.length > 0) {
	console.log("\nSample orphans:");
	for (const k of orphans.slice(0, 20)) console.log(`  ${JSON.stringify(k.slice(0, 90))}`);
}

if (jsonArg) {
	fs.writeFileSync(jsonArg, JSON.stringify({ orphans, reached: [...reached], fragKeys: [...fragKeys] }, null, 2));
	console.log(`\n→ ${jsonArg}`);
}

process.exit(orphans.length > 0 ? 1 : 0);
