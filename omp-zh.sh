#!/usr/bin/env bash
# omp 汉化 —— 一键操作入口
#
#   ./omp-zh.sh apply    应用/重新应用汉化（omp 升级后重跑此命令即可）
#   ./omp-zh.sh restore  还原为官方英文版
#   ./omp-zh.sh verify   校验当前产物完整性
#   ./omp-zh.sh test     校验 + 运行时值标签/回退断言
#   ./omp-zh.sh report   生成翻译清单（不修改文件）
#   ./omp-zh.sh status   查看当前状态
set -euo pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
	echo "需要 bun（https://bun.sh）：bun 未安装或不在 PATH 中" >&2
	exit 1
fi

# 依赖只用于解析产物 AST；缺失时自动补齐（首次运行需要网络）
if [[ ! -d "$HERE/node_modules/@babel/parser" ]]; then
	echo "首次运行：安装依赖……"
	(cd "$HERE" && bun install --silent) || {
		echo "依赖安装失败，请手动执行：cd $HERE && bun install" >&2
		exit 1
	}
fi

# omp 安装路径由 patch.ts 自行探测（OMP_PKG 可覆盖）。
# `patch.ts path` 约定只往 stdout 写一行路径，但模块加载期的进度输出
# （首次侧载新版本时跑 `bun add`）曾经混进来，使 $CLI 变成多行、`[[ -f ]]`
# 判定失败而静默不打补丁。这里取最后一行并显式校验，避免重演。
CLI_RAW="$(cd "$HERE" && bun run patch.ts path 2>/dev/null || true)"
CLI="$(printf '%s\n' "$CLI_RAW" | grep -v '^[[:space:]]*$' | tail -n1)"

run_patch() {
	cd "$HERE"
	bun run patch.ts "$1"
}

case "${1:-status}" in
apply)
	if [[ ! -f "$CLI" ]]; then
		echo "找不到 omp 产物：$CLI" >&2
		[[ -n "$CLI_RAW" && "$CLI_RAW" != "$CLI" ]] && echo "（patch.ts path 原始输出：$CLI_RAW）" >&2
		exit 1
	fi
	# 已打补丁时先还原，保证从干净基线重来
	if grep -q 'var __omp_i18n_d=' "$CLI"; then
		echo "检测到已有汉化，先还原到原始版本……"
		run_patch restore
	fi
	run_patch apply
	chmod +x "$CLI"
	run_patch verify
	bun tools/test-value-labels.ts
	echo
	# A binary install keeps the official `omp` untouched and puts the Chinese
	# UI behind `omp-zh`; running plain `omp` then looks like a failed patch.
	# The sidecar layout is the tell, and patch.ts already linked the launcher
	# into ~/.local/bin, so point the user at the command that actually works.
	if [[ "$CLI" == *"/.omp-zh/runtime/"* ]]; then
		echo "注意：本机 omp 是预编译二进制，汉化产物在侧载目录，官方 omp 保持不变。"
		echo "      中文界面请用 \`omp-zh\` 启动（已自动链接到 ~/.local/bin，新开终端生效）。"
		echo "      直接运行 \`omp\` 仍是英文，这是预期行为。"
		echo
	fi
	echo "汉化完成。若 TUI 已在运行，请退出后重新打开。"
	echo "临时切回英文：OMP_ZH=0 omp-zh"
	;;
test)
	run_patch verify
	echo
	bun tools/test-value-labels.ts
	echo
	echo "--- OMP_ZH=0 回退检查 ---"
	OMP_ZH=0 bun tools/test-value-labels.ts
	;;
restore)
	run_patch restore
	chmod +x "$CLI"
	echo "已还原为官方英文版。"
	;;
verify)
	run_patch verify
	;;
report)
	run_patch report
	;;
status)
	echo "omp 版本:      $(timeout 30 "$CLI" --version 2>/dev/null || echo '（无法执行）')"
	echo "产物路径:      $CLI"
	if grep -q 'var __omp_i18n_d=' "$CLI"; then
		n=$(grep -o '__omp_i18n_t(' "$CLI" | wc -l)
		echo "汉化状态:      已应用（约 $n 处调用点）"
	else
		echo "汉化状态:      未应用（官方英文版）"
	fi
	b=$(cd "$HERE" && bun patch.ts list 2>/dev/null | head -1)
	echo "备份:          ${b:-（无）}"
	# Which command actually shows Chinese depends on the install shape, so
	# report the launcher state rather than leaving the user to guess.
	if [[ "$CLI" == *"/.omp-zh/runtime/"* ]]; then
		echo "启动方式:      omp-zh（预编译二进制安装；官方 omp 始终为英文）"
		if command -v omp-zh >/dev/null 2>&1; then
			echo "               omp-zh 已在 PATH 中：$(command -v omp-zh)"
		else
			echo "               警告：omp-zh 不在 PATH 中，请执行：export PATH=\"\$HOME/.omp-zh/bin:\$PATH\""
		fi
	else
		echo "启动方式:      omp（就地汉化，直接运行即为中文）"
	fi
	;;
*)
	echo "用法: $0 {apply|restore|verify|test|report|status}" >&2
	exit 1
	;;
esac
