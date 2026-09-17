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

# omp 安装路径由 patch.ts 自行探测（OMP_PKG 可覆盖）
CLI="$(cd "$HERE" && bun run patch.ts path)"

run_patch() {
	cd "$HERE"
	bun run patch.ts "$1"
}

case "${1:-status}" in
apply)
	if [[ ! -f "$CLI" ]]; then
		echo "找不到 omp 产物：$CLI" >&2
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
	echo "汉化完成。若 TUI 已在运行，请退出后重新打开 omp。"
	echo "临时切回英文：OMP_ZH=0 omp"
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
	;;
*)
	echo "用法: $0 {apply|restore|verify|test|report|status}" >&2
	exit 1
	;;
esac
