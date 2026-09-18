#!/usr/bin/env bun
/**
 * Value-cell resolution test for the settings rows.
 *
 * The TUI is not driven here: instead the patched runtime prologue is
 * extracted from the installed bundle and its helpers are exercised
 * in-process with the exact item shapes the settings list produces
 * (`defToItem` output fed to the row renderer's cell expression).
 *
 *   bun tools/test-value-labels.ts          # expect translated cells
 *   OMP_ZH=0 bun tools/test-value-labels.ts # expect raw values (kill switch)
 */

import * as path from "node:path";
const PKG = process.env.OMP_PKG ?? path.join(process.env.HOME ?? "~", ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const CLI = process.env.OMP_ZH_SRC ?? path.join(PKG, "dist/cli.js");
const code = await Bun.file(CLI).text();

const start = code.indexOf("var __omp_i18n_on=");
const end = code.indexOf("\n// @bun");
if (start === -1 || end === -1 || end < start) {
	console.error("FAIL: runtime prologue not found — bundle not patched?");
	process.exit(1);
}
const prologue = code.slice(start, end);

const load = new Function(`${prologue}; return { t: __omp_i18n_t, vlm: __omp_i18n_vlm, vr: __omp_i18n_vr, on: __omp_i18n_on };`) as () => {
	t: (s: string) => string;
	vlm: (o: unknown) => Record<string, string> | undefined;
	vr: (e: { currentValue?: unknown; values?: string[]; valueLabels?: Record<string, string> }) => string;
	on: boolean;
};
const h = load();

const off = process.env.OMP_ZH === "0";
let failed = 0;
const check = (name: string, got: unknown, want: unknown): void => {
	const ok = got === want;
	if (!ok) failed++;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`);
};

// Mirrors `case"submenu": ... valueLabels: __omp_i18n_vlm(e.options)`.
const submenu = (currentValue: string, options: { value: string; label: string }[]) => ({
	currentValue,
	values: options.map(o => o.value),
	valueLabels: h.vlm(options),
});

console.log(`OMP_ZH=0 kill switch active: ${off}, helper flag on: ${h.on}`);

console.log("\nsubmenu rows (per-setting map from def.options):");
const resize = submenu("rebuild", [
	{ value: "append", label: "Append" },
	{ value: "rebuild", label: "Rebuild" },
	{ value: "preserve", label: "Preserve" },
]);
check("tui.resizeScrollback=rebuild", h.vr(resize), off ? "rebuild" : "重建");
const spinner = submenu("braille", [
	{ value: "braille", label: "Braille" },
	{ value: "dots", label: "Dots" },
	{ value: "line", label: "Line" },
]);
check("tui.titleSpinner=braille", h.vr(spinner), off ? "braille" : "盲文");

console.log("\ncollision disambiguation (same raw value, different labels):");
const cacheRetention = submenu("none", [
	{ value: "auto", label: "Auto" },
	{ value: "short", label: "Short (5m)" },
	{ value: "long", label: "Long (1h)" },
	{ value: "none", label: "Off" },
]);
const vimMode = submenu("none", [
	{ value: "text", label: "Text" },
	{ value: "icon", label: "Icon" },
	{ value: "none", label: "Hidden" },
]);
check("providers.cacheRetention=none", h.vr(cacheRetention), off ? "none" : "关");
check("tui.vimModeDisplay=none", h.vr(vimMode), off ? "none" : "隐藏");

console.log("\nboolean rows (global fallback table):");
// defToItem: currentValue:"true", values:["true","false"], no per-item map.
check("boolean=true", h.vr({ currentValue: "true", values: ["true", "false"] }), off ? "true" : "是");
check("boolean=false", h.vr({ currentValue: "false", values: ["true", "false"] }), off ? "false" : "否");

console.log("\noption-less enum rows (global fallback table):");
check("ttsr.contextMode=discard", h.vr({ currentValue: "discard", values: ["discard", "keep"] }), off ? "discard" : "丢弃");
check("tui.hyperlinks=always", h.vr({ currentValue: "always", values: ["off", "auto", "always"] }), off ? "always" : "始终");

console.log("\nfree-text rows stay verbatim:");
check("text row path", h.vr({ currentValue: "/home/yebu/work" }), "/home/yebu/work");
check("text row empty", h.vr({ currentValue: "" }), "");
check("unknown token with values", h.vr({ currentValue: "zzz", values: ["zzz"] }), "zzz");

console.log("\nvlm edge cases:");
// Fork semantics: the map keeps every option whose label differs from the
// raw value (case included), and is only dropped when nothing differs.
check("label differing only in case is kept", JSON.stringify(h.vlm([{ value: "openai", label: "OpenAI" }])), off ? undefined : JSON.stringify({ openai: "OpenAI" }));
check("label identical to value -> undefined", h.vlm([{ value: "zhipu", label: "zhipu" }]), undefined);
check("empty options -> undefined", h.vlm([]), undefined);
const proto = h.vlm([
	{ value: "__proto__", label: "Rebuild" },
	{ value: "rebuild", label: "Rebuild" },
]);
check("forbidden key dropped, real key kept", JSON.stringify(proto), off ? JSON.stringify(proto) : JSON.stringify({ rebuild: "重建" }));
check("no prototype pollution", Object.getPrototypeOf(proto ?? {}) === Object.prototype && !Object.hasOwn(proto ?? {}, "__proto__"), true);

console.log(failed === 0 ? "\nall value-label assertions hold" : `\n${failed} FAILED`);
if (failed > 0) process.exit(1);
