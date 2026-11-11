#!/usr/bin/env bun
/**
 * 注意：对「已打补丁」的产物运行会大量误报（原文已被替换掉）；体检请
 * 用 pristine 备份：bun tools/anchor-check.ts <backup>/cli.js.orig-pristine。
 * 这里对每个锚点跑与 resolveAnchor 相同的策略链（primary exact → alts
 * exact → primary loose → alts loose），列出所有在当前产物上完全无法
 * 定位的条目，并打印 find 中关键字符串在产物里的真实上下文，方便对照
 * 上游新拼写补 alts。
 *
 * 用法：bun tools/anchor-check.ts [cli.js 路径]
 */
import * as fs from "node:fs";
import { parse } from "@babel/parser";
import { matchLoose, resolveAnchorSpellings } from "./loose-anchor";

interface Spelling { find: string; replace: string }
interface AnchorPatch { name: string; find: string; replace: string; all?: true; loose?: { find: string; replace: string }; alts?: readonly Spelling[] }

const patchSrc = fs.readFileSync(new URL("../patch.ts", import.meta.url), "utf8");

/**
 * 从 patch.ts 源码里截取 ANCHOR_PATCHES 数组字面量文本。
 *
 * 早期版本是手写的括号配平扫描（字符串/反引号感知），但 patch.ts 里锚点
 * 条目的注释也含有反引号和括号，遇到 `[` 就跟着配平会把数组截断，报
 * 「unbalanced ANCHOR_PATCHES array」。改成用 babel 直接取 AST 里
 * `ANCHOR_PATCHES` 初始化器 的源码切片——注释与正则都不再是问题。
 */
const extractArray = (src: string): string => {
	const ast = parse(src, { sourceType: "module", plugins: ["typescript"], errorRecovery: true });
	for (const node of ast.program.body) {
		if (node.type !== "VariableDeclaration") continue;
		for (const decl of node.declarations) {
			if (decl.id.type === "Identifier" && decl.id.name === "ANCHOR_PATCHES" && decl.init) {
				return src.slice(decl.init.start!, decl.init.end!);
			}
		}
	}
	throw new Error("ANCHOR_PATCHES not found in patch.ts");
};

// patch.ts 无 import.meta.main 守卫，直接 import 会执行入口命令；
// 数组体是纯数据（字符串模板），在补齐 FN 常量后求值是安全的。
const ANCHOR_PATCHES: readonly AnchorPatch[] = new Function(
	"FN", "FN_FRAG", "FN_BLOCK", "FN_VLM", "FN_VR",
	`return ${extractArray(patchSrc)};`,
)("__omp_i18n_t", "__omp_i18n_f", "__omp_i18n_b", "__omp_i18n_vlm", "__omp_i18n_vr");

// 与 omp-zh.sh 相同的兜底顺序：`bun patch.ts path` 打印补丁器自己探测的产物路径。
const probe = Bun.spawnSync(["bun", "run", new URL("../patch.ts", import.meta.url).pathname, "path"], {
	stdout: "pipe", stderr: "ignore",
});
const probed = probe.stdout.toString().trim().split("\n").filter(l => l.trim() !== "").pop();
const cliPath = process.argv[2] ?? process.env.OMP_PKG ?? probed;
if (!cliPath || !fs.existsSync(cliPath)) {
	console.error("无法定位 omp 产物；用法: bun tools/anchor-check.ts [cli.js 路径]");
	process.exit(1);
}
const code = fs.readFileSync(cliPath, "utf8");

const findOccurrences = (haystack: string, needle: string): number[] => {
	const out: number[] = [];
	if (needle.length === 0) return out;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return out;
		out.push(idx);
		from = idx + needle.length;
	}
};

let ok = 0;
interface Problem { name: string; find: string; kind: "missing" | "ambiguous"; detail?: string }
const problems: Problem[] = [];
// 体检必须与 apply 的判定完全一致，否则会出现「体检 74/74 全绿、apply 却报
// anchor not unique」这种误报——只数「能不能命中」而不数「命中几个」就会漏掉
// 不唯一。这里直接复用 resolveAnchorSpellings，并把多命中当成问题。
for (const patchEntry of ANCHOR_PATCHES) {
	const spellings: Spelling[] = [{ find: patchEntry.find, replace: patchEntry.replace }, ...(patchEntry.alts ?? [])];
	const hits = resolveAnchorSpellings(code, spellings, patchEntry.all);
	if (hits.length === 0) {
		problems.push({ name: patchEntry.name, find: patchEntry.find, kind: "missing" });
		continue;
	}
	if (hits.length > 1 && !patchEntry.all) {
		// 哪一条拼写撑出了多命中？逐条查，方便判断该加长锚点还是补 alts。
		const blame = spellings
			.map(s => ({ s, n: findOccurrences(code, s.find).length || matchLoose(code, s.find).length }))
			.filter(x => x.n > 1)
			.sort((a, b) => b.n - a.n)[0];
		problems.push({
			name: patchEntry.name,
			find: blame?.s.find ?? patchEntry.find,
			kind: "ambiguous",
			detail: `${hits.length} matches${blame ? ` (spelling matches ${blame.n})` : ""}`,
		});
		continue;
	}
	ok++;
}

console.log(`bundle: ${cliPath} (${(code.length / 1e6).toFixed(1)}MB)`);
const missingCount = problems.filter(p => p.kind === "missing").length;
const ambiguousCount = problems.length - missingCount;
console.log(
	`anchors: ${ok}/${ANCHOR_PATCHES.length} applicable, ${missingCount} missing, ${ambiguousCount} not unique\n`,
);
for (const m of problems) {
	console.log(`✗ ${m.name}  [${m.kind === "missing" ? "找不到" : "不唯一"}]${m.detail ? `  ${m.detail}` : ""}`);
	console.log(`  find: ${m.find.slice(0, 200)}`);
	if (m.kind === "missing") {
		// 用 find 里最长的带空格字面量片段在产物中定位上下文，帮助写 alts
		const literals = [...m.find.matchAll(/"([^"]{6,})"/g)].map(x => x[1])
			.concat([...m.find.matchAll(/[A-Za-z][A-Za-z ,.:;/()'"-]{10,}/g)].map(x => x[0]));
		const probe = literals.sort((a, b) => b.length - a.length)[0];
		if (probe) {
			const idx = code.indexOf(probe);
			if (idx !== -1) console.log(`  ctx : …${code.slice(Math.max(0, idx - 120), idx + probe.length + 80).replace(/\n/g, "\\n")}…`);
			else console.log(`  ctx : (probe "${probe.slice(0, 60)}" not in bundle)`);
		}
	} else {
		// 多命中：打印前两个位置的真实上下文，看锚点是否需要加长。
		const hits = resolveAnchorSpellings(code, [{ find: m.find, replace: "" }], false);
		for (const [i, h] of hits.slice(0, 3).entries()) {
			console.log(`  #${i + 1} : …${code.slice(Math.max(0, h.start - 90), h.end + 60).replace(/\n/g, "\\n")}…`);
		}
		if (hits.length === 0) {
			for (const [i, h] of matchLoose(code, m.find).slice(0, 3).entries()) {
				console.log(`  #${i + 1} : …${code.slice(Math.max(0, h.start - 90), h.end + 60).replace(/\n/g, "\\n")}…`);
			}
		}
	}
	console.log();
}
if (problems.length > 0) process.exitCode = 1;

