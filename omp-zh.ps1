# omp 汉化 —— Windows 一键操作入口
#
#   .\omp-zh.ps1 apply     应用/重新应用汉化（omp 升级后重跑即可）
#   .\omp-zh.ps1 restore   还原为官方英文版
#   .\omp-zh.ps1 verify    校验当前产物完整性
#   .\omp-zh.ps1 status    查看当前状态
#   .\omp-zh.ps1 doctor    环境诊断（贴 issue 用）
#
# apply/verify/restore 的编排逻辑在 patch.ts 的 setup 子命令里，跨平台共用；
# 本脚本只负责进程 spawn 与参数透传。
param(
    [string]$Command = "status",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)
$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $Bun) {
    Write-Host "需要 bun：bun 未安装或不在 PATH 中" -ForegroundColor Red
    Write-Host "安装：powershell -c `"irm bun.sh/install.ps1 | iex`""
    exit 1
}

# 依赖只用于解析产物 AST；缺失时自动补齐（首次运行需要网络）
if (-not (Test-Path (Join-Path $Here "node_modules\@babel\parser"))) {
    Write-Host "首次运行：安装依赖……"
    Push-Location $Here
    bun install
    Pop-Location
    if ($LASTEXITCODE -ne 0) { Write-Host "依赖安装失败，请手动执行：cd $Here && bun install" -ForegroundColor Red; exit 1 }
}

# setup（apply 的完整编排）之外的子命令直接透传 patch.ts；status 由本脚本
# 汇总 patch.ts doctor 的信息并补上中文说明。
if ($Command -eq "setup" -or $Command -eq "apply") {
    & bun (Join-Path $Here "patch.ts") setup @Rest
    exit $LASTEXITCODE
}

if ($Command -eq "status") {
    & bun (Join-Path $Here "patch.ts") doctor
    exit $LASTEXITCODE
}

& bun (Join-Path $Here "patch.ts") $Command @Rest
exit $LASTEXITCODE
