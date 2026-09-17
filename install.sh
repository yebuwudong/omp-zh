#!/usr/bin/env bash
# omp 汉化 —— 一行命令入口（始终拉取最新补丁）
#
#   curl -fsSL https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.sh | bash
#
# 可选参数（透传给 omp-zh.sh）：
#   curl -fsSL .../install.sh | bash -s -- status    # 查看状态
#   curl -fsSL .../install.sh | bash -s -- restore   # 还原英文
#
# 环境变量：
#   OMP_ZH_HOME   补丁仓库的本地目录（默认 ~/.omp-zh）
set -euo pipefail

REPO="https://github.com/yebuwudong/omp-zh.git"
TARBALL="https://github.com/yebuwudong/omp-zh/archive/refs/heads/main.tar.gz"
DIR="${OMP_ZH_HOME:-$HOME/.omp-zh}"
CMD="${1:-apply}"

die() { echo "错误：$*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "需要 bun（https://bun.sh）——请先安装：curl -fsSL https://bun.sh/install | bash"

# 拉取或更新补丁仓库。git 不可用时退回 tarball（无法增量更新，但保证能装上）。
if [[ -d "$DIR/.git" ]]; then
	git -C "$DIR" pull --ff-only --quiet || die "更新 $DIR 失败，请检查网络；如需强制同步：rm -rf $DIR 后重跑本命令"
elif [[ -d "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
	# 目录存在但不是 git 仓库（旧 tarball 安装）：原地覆盖为最新版
	if command -v git >/dev/null 2>&1; then
		rm -rf "$DIR"
		git clone --depth 1 --quiet "$REPO" "$DIR" || die "克隆 $REPO 失败"
	else
		curl -fsSL "$TARBALL" | tar -xz -C "$DIR" --strip-components=1 --overwrite || die "下载最新版失败"
	fi
elif command -v git >/dev/null 2>&1; then
	git clone --depth 1 --quiet "$REPO" "$DIR" || die "克隆 $REPO 失败"
else
	mkdir -p "$DIR"
	curl -fsSL "$TARBALL" | tar -xz -C "$DIR" --strip-components=1 || die "下载最新版失败"
fi

cd "$DIR"
[[ -f ./omp-zh.sh ]] || die "$DIR 里没有 omp-zh.sh，仓库内容异常"

# babel/parser 用于解析 23MB 产物；首次安装或依赖缺失时自动补齐。
if [[ ! -d ./node_modules/@babel/parser ]]; then
	echo "安装依赖……"
	bun install --silent || bun install || die "依赖安装失败：cd $DIR && bun install"
fi

exec ./omp-zh.sh "$CMD"
