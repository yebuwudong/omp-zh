#!/usr/bin/env bun
/**
 * Runtime assertions for anchors whose site the dictionary scan cannot reach.
 *
 * The literal scan only sees whole strings; anchors exist for the spots where
 * upstream builds UI text at runtime (`${zRo[e]}: ${t}`, `Setup step ${s+1} of
 * ${o.length}` left untranslated). A missing anchor is caught by `apply`
 * refusing to run, but "the anchor matched" and "the text reaches the screen in
 * Chinese" are different claims — an anchor can match the wrong call site or
 * wrap only part of the string.
 *
 * So this drives the extracted runtime prologue in-process (same technique as
 * tools/test-value-labels.ts) with the exact snippets each anchor protects.
 * No TUI, no pty: it finishes in a second instead of waiting on a terminal.
 *
 *   bun tools/test-anchors.ts          # expect translations
 *   OMP_ZH=0 bun tools/test-anchors.ts # expect raw English (kill switch)
 */

import * as path from "node:path";
import * as os from "node:os";
import { existsSync } from "node:fs";

const resolveCli = (): string => {
	if (process.env.OMP_ZH_SRC) return process.env.OMP_ZH_SRC;
	const pkg = process.env.OMP_PKG;
	if (pkg) return path.join(pkg, "dist", "cli.js");
	const fromPatcher = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "patch.ts"), "path"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const resolved = fromPatcher.exitCode === 0 ? fromPatcher.stdout.toString().trim() : "";
	if (resolved && existsSync(resolved)) return resolved;
	return path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
};

const CLI = resolveCli();
const code = await Bun.file(CLI).text();
const start = code.indexOf("var __omp_i18n_on=");
const end = code.indexOf("\n// @bun");
if (start === -1 || end === -1 || end < start) {
	console.error("FAIL: runtime prologue not found — bundle not patched?");
	process.exit(1);
}
const helpers = new Function(`${code.slice(start, end)}; return { t: __omp_i18n_t, f: __omp_i18n_f };`)() as {
	t: (s: string) => string;
	f: (s: string) => string;
};

const off = process.env.OMP_ZH === "0";
let failed = 0;
const check = (name: string, got: unknown, want: unknown): void => {
	const ok = got === want;
	if (!ok) failed++;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`);
};

console.log(`bundle: ${CLI}`);
console.log(`OMP_ZH=0 kill switch active: ${off}`);

// setup progress: `Setup step ${s+1} of ${o.length}` in 18.18's renderer.
const progress = "Setup step {{current}} of {{total}}";
check(
	"setup progress 7/8",
	helpers.t(progress).replace("{{current}}", "7").replace("{{total}}", "8"),
	off ? "Setup step 7 of 8" : "设置步骤 7 / 8",
);

// setup scene heading: title/subtitle reach the screen as fragments.
check("setup title fragment", helpers.f("Setup"), off ? "Setup" : "设置");
check(
	"unrelated English survives",
	helpers.f("Let me know when you're done."),
	"Let me know when you're done.",
);

// error / warning sinks: the message body is translated, the `Error: ` /
// `Warning: ` prefix is composed by upstream and left as-is.
const errorBody = "Server name required. Usage: /mcp remove <name> [--scope project|user]";
check(
	"error message body",
	helpers.f(errorBody),
	off ? errorBody : "缺少服务器名称。用法：/mcp remove <名称> [--scope project|user]",
);
const warningBody = "Wait for the current response to finish or abort it before forking.";
check(
	"warning message body",
	helpers.f(warningBody),
	off ? warningBody : "请等待当前响应完成或中止后再创建分叉。",
);

console.log(failed === 0 ? "\nall anchor runtime assertions hold" : `\n${failed} assertion(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
