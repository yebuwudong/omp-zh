# omp 汉化 —— Windows 一行命令入口（始终拉取最新补丁）
#
#   irm https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.ps1 | iex
#
# 可选参数（透传给 patch.ts 的编排子命令）：
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.ps1))) -Command status
#
# 环境变量：
#   OMP_ZH_HOME   补丁仓库的本地目录（默认 ~\.omp-zh）
param(
    [string]$Command = "setup"
)
$ErrorActionPreference = "Stop"

# 与上游 install.ps1 相同的门槛：5.1 缺少下面用到的 cmdlet 且错误难以定位。
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "需要 Windows PowerShell 5.1 或更新版本（当前 $($PSVersionTable.PSVersion)）。请安装 PowerShell 7：https://aka.ms/powershell"
}

function Die($msg) { Write-Host "错误：$msg" -ForegroundColor Red; exit 1 }

# ── bun ────────────────────────────────────────────────────────────────────
$Bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $Bun) {
    Die "需要 bun —— 请先安装：powershell -c `"irm bun.sh/install.ps1 | iex`"，装完重开终端再跑本命令"
}
Write-Host "bun: $(& bun --version)"

# ── 补丁仓库 ───────────────────────────────────────────────────────────────
$Repo = "https://github.com/yebuwudong/omp-zh.git"
$Dir = if ($env:OMP_ZH_HOME) { $env:OMP_ZH_HOME } else { Join-Path $env:USERPROFILE ".omp-zh" }
$Tarball = "https://github.com/yebuwudong/omp-zh/archive/refs/heads/main.tar.gz"

if (Test-Path (Join-Path $Dir ".git")) {
    Write-Host "更新补丁仓库：$Dir"
    git -C $Dir pull --ff-only --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  git pull 失败（本地有改动或网络问题），改用 tarball 覆盖……" -ForegroundColor Yellow
        if (Test-Path "$Dir.bak") { Remove-Item -Recurse -Force "$Dir.bak" }
        Move-Item $Dir "$Dir.bak"
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        curl.exe -fsSL $Tarball -o "$Dir\p.tgz"
        tar -xzf "$Dir\p.tgz" -C $Dir --strip-components=1
        Remove-Item "$Dir\p.tgz"
    }
}
elseif (Test-Path $Dir) {
    # 目录存在但不是 git 仓库（旧 tarball 安装）：原地覆盖为最新版
    Write-Host "覆盖旧安装：$Dir"
    if (Test-Path "$Dir.bak") { Remove-Item -Recurse -Force "$Dir.bak" }
    Move-Item $Dir "$Dir.bak"
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    curl.exe -fsSL $Tarball -o "$Dir\p.tgz"
    tar -xzf "$Dir\p.tgz" -C $Dir --strip-components=1
    Remove-Item "$Dir\p.tgz"
}
else {
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Host "克隆补丁仓库到：$Dir"
        git clone --depth 1 --quiet $Repo $Dir
        if ($LASTEXITCODE -ne 0) { Die "克隆 $Repo 失败，请检查网络" }
    } else {
        Write-Host "未检测到 git，改用 tarball 下载到：$Dir"
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        curl.exe -fsSL $Tarball -o "$Dir\p.tgz"
        tar -xzf "$Dir\p.tgz" -C $Dir --strip-components=1
        Remove-Item "$Dir\p.tgz"
    }
}

Set-Location $Dir
if (-not (Test-Path ".\patch.ts")) { Die "$Dir 里没有 patch.ts，仓库内容异常" }

# ── 依赖 ───────────────────────────────────────────────────────────────────
if (-not (Test-Path ".\node_modules\@babel\parser")) {
    Write-Host "安装依赖……"
    bun install
    if ($LASTEXITCODE -ne 0) { Die "依赖安装失败：cd $Dir && bun install" }
}

# ── 编排（apply / verify / restore / status 全在 patch.ts 里，跨平台共用）──
Write-Host ""
& bun patch.ts $Command
exit $LASTEXITCODE
