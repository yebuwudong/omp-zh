# omp 中文界面汉化

[![LINUX DO](https://img.shields.io/badge/社区-LINUX%20DO-blue)](https://linux.do)
[![License: MIT](https://img.shields.io/badge/许可-MIT-green)](./LICENSE)

把已安装的官方 omp 界面汉化为简体中文，**不改变版本、不替换安装、不动运行时结构**。
补丁器跟随上游持续适配，不绑定具体版本号——上游发新版后重跑一条命令即可。
本项目已链接认可 [LINUX DO](https://linux.do) 社区，并参与其
[开源推广](https://linux.do/t/topic/1776670)。

```
~/.omp-zh/
├── install.sh                    一行命令入口（curl | bash）
├── omp-zh.sh                     一键入口：apply / restore / verify / report / status
├── patch.ts                      补丁器（AST 分类 + 词典替换 + 锚点自动适配 + 校验）
├── dict.json                     2129 条英→中映射（源自 oh-my-pi-cn 汉化分支）
├── dict-extra.json               1200+ 条补充映射（含「保持英文」的显式标记）
├── analysis/                     侦察与词典构建脚本
└── tools/                        审计、实测、回退验证脚本
    ├── loose-anchor.ts           锚点通配匹配（重打包重命名自动适配）
    ├── patch-templates.ts        模板字面量包裹（拼接式提示）
    ├── anchor-check.ts           全量锚点体检（一次列出所有失配 + 产物真实上下文）
    └── scan-multiline-strings.ts 多行字符串语料扫描（欢迎页提示等整块文本）

备份位于 <omp>/dist/.omp-zh-backup/（跟着安装走，多份 clone 共享）
bin/、runtime/ 为本地生成物（启动器与侧载运行时），不入库
```

## 支持的安装方式

| omp 安装方式 | 汉化做法 |
|---|---|
| `bun install -g` / npm / nix | 直接改写包内 `dist/cli.js`，`omp` 启动即中文 |
| **官方预编译二进制**（`curl https://omp.sh/install \| sh`） | 二进制内嵌字节码不可改写，改为**侧载同版本 JS 运行时**并生成 `omp-zh` 启动器；原 omp 不动 |
| Homebrew | 通常指向 npm 包，同第一种 |
| 源码构建 | 直接改写构建产物 |

## Windows 支持现状

已在 Windows x64 / PowerShell 7.6.6 / Bun 1.3.14 上验证 omp 18.11.1 的 `.exe` 侧载：
应用汉化、中文启动、`OMP_ZH=0`、校验及字节一致的还原。其他安装方式和架构仍需实测。
需要 Bun **1.3.14 或更高版本**；锁文件兼容该版本，可用 `bun install --frozen-lockfile` 安装依赖。

| 环境 | 状态 |
|---|---|
| WSL / Git Bash | 与 Linux 相同路径，`install.sh`、`omp-zh.sh` 可直接用 |
| 原生 PowerShell / CMD | `patch.ts` 已能跑，`install.sh` / `omp-zh.sh` 这两个 bash 入口用不了 |
| 官方预编译 `.exe` | 上游提供 `omp-windows-x64.exe` / `omp-windows-arm64.exe`，并有配套的 `install.ps1` |

## Windows 的两种安装方式

### 方式一：官方预编译二进制（推荐）

上游为 Windows 提供了独立的 PowerShell 安装器，装到 `%LOCALAPPDATA%\omp\omp.exe`：

```powershell
irm https://omp.sh/install.ps1 | iex
```

二进制内嵌字节码，**不能就地改写**，所以汉化走侧载：补丁器取同版本 JS 包到
`~/.omp-zh/runtime/<版本>/`，改那一份，并生成 `%APPDATA%\npm\omp-zh.cmd` 启动器。
官方 `omp.exe` 保持原样（仍是英文，这是设计如此）。

```powershell
git clone https://github.com/yebuwudong/omp-zh.git $env:USERPROFILE\.omp-zh
cd $env:USERPROFILE\.omp-zh
bun install
bun patch.ts apply      # 打补丁 + 生成启动器
bun patch.ts verify     # 完整校验
omp-zh                  # 中文界面
bun patch.ts restore    # 还原
```

原生 Windows 的 `.cmd` 启动器直接用 Bun 运行侧载产物，不依赖 `sh`，也不执行可选的字节码预编译。
官方 omp 升级后重新运行 `bun patch.ts apply`；项目生成的 `.cmd` 会更新到对应版本，其他文件不会被覆盖。

若当前终端找不到 `omp`，可先用 `$env:OMP_PKG='C:\path\to\omp.exe'` 显式指定安装位置，
再运行 `doctor` 或 `apply`。这也适用于由其他应用管理的 `.exe` 安装。

### 方式二：npm / bun 全局包（就地汉化）

```powershell
npm install -g @oh-my-pi/pi-coding-agent
# 或
bun add -g @oh-my-pi/pi-coding-agent
```

这个形态下产物是 `dist/cli.js`，npm 会在旁边放一个 `omp.cmd` / `omp.ps1` 包装脚本。
补丁器已经处理了这个坑：`Bun.which("omp")` 在 Windows 上拿到的是**包装脚本而不是 JS**，
直接当作目标会让 Babel 去解析批处理语法、让备份的 `mkdir` 报 `ENOTDIR`。现在会把包装
脚本里的路径解析出来，定位真正的 `dist/cli.js`（支持 npm 的 `%~dp0` 形态、bun 的绝对路径
形态和 PowerShell 的 `$PSScriptRoot` 形态）。

这种安装**不需要启动器**：改的就是 `omp` 自己要跑的 `dist/cli.js`，敲 `omp` 即为中文。

```
bun patch.ts apply / verify / restore
```

已知限制：

- 已验证上述 x64 侧载路径，npm/Bun 全局包和 arm64 尚需真机反馈。
- Windows 上不做 `chmod` / symlink（前者无意义，后者需要管理员权限或开发者模式），
  启动器改为 `.cmd` 文件。
- 完整对等的 PowerShell 版 `install.ps1` / `omp-zh.ps1`（自动 clone、更新、一键 apply 等）
  尚未提供，目前需要手动跑 `bun patch.ts` 子命令。

## 诊断

装不上、报错、或者行为不符合预期时，先跑一次 `doctor` —— 它会在任何平台上输出环境信息、
解析到的目标路径、产物形态和备份清单，且**目标解析失败时也不会崩**（这正是最需要诊断的时候）：

```bash
bun patch.ts doctor
```

Windows 上会额外输出 `USERPROFILE`、`APPDATA`、`PATHEXT`、是否找到 `sh`，以及包装脚本
解析出的真实 bundle 路径。提 issue 时把整段贴上来即可。

`doctor` 只检查现有文件，不下载侧载运行时、不创建或更新启动器。首次使用时若提示侧载产物缺失，
运行 `bun patch.ts apply` 才会获取并汉化同版本运行时。

侧载目录 `~/.omp-zh/runtime/<版本>/`，启动器 `~/.omp-zh/bin/omp-zh`。补丁器会按 `omp --version` 自动选择路径，无需手工配置。

**二进制安装请用 `omp-zh` 启动**（官方 `omp` 保持原样，仍是英文——这是设计如此，不是补丁失败）。
补丁器会自动把启动器软链到 `~/.local/bin/omp-zh`（已存在则不覆盖），所以新开终端后直接敲 `omp-zh` 即可，无需手改 shell 配置。
启动器内部用绝对路径调用 `bun`，不依赖 `~/.bun/bin` 是否在 PATH 中。
若 `~/.local/bin` 也不在你的 PATH 中，会打印一行 `export PATH=...` 提示，或改用 `~/.omp-zh/bin/omp-zh` 绝对路径。

启动器在**运行时**解析要跑哪个侧载版本：先取官方 `omp --version`，命中就用该版本的侧载运行时；
官方刚升级、对应侧载还没打补丁时，退回到最新的已汉化侧载并在 stderr 提示重跑 `apply`。
因此官方 omp 升级后 `omp-zh` 不会继续跑旧版本（早期版本把版本号写死在启动器里，会出现
「官方 18.10.1、omp-zh 还停在 18.10.0」）。

> 不确定该敲哪个命令？`./omp-zh.sh status` 最后一行会写明「启动方式」。

## 启动性能：预编译字节码二进制

侧载运行时是一个约 30 MB 的 JS 产物，每次启动都要重新解析、编译一遍——本机（arm64）实测
**约 1.1 秒**，而官方编译二进制只要 **0.13 秒**。

非 Windows 平台的 `apply` 会自动把打好补丁的产物**预编译成带字节码的独立二进制**（`runtime/<版本>/omp-zh-native`），
启动器优先使用它：

| 启动路径 | 耗时 |
|---|---|
| 字节码二进制（默认） | **约 0.2 秒** |
| bun 读取 JS 产物（回退） | 约 1.1 秒 |
| 官方 omp（原生，无汉化） | 约 0.13 秒 |

代价是每次 `apply` 多花约 5 秒编译、每个版本多占约 190 MB 磁盘。只要启动超过 6 次就回本。

实现上有三个必须记住的坑，都写在 `patch.ts` 的注释里：

1. **`--format=esm` 是必需的，不是可选项。** `--bytecode` 默认转 CommonJS，而 CJS 不支持顶层
   `await`，上游产物里有 162 处。不带这个参数时 Bun 只报一句 `Failed to generate bytecode`，
   既不提格式也不提 await。
2. **编译必须在侧载目录内进行。** `cwd` 换到别处会因 `@oh-my-pi/pi-natives/vcs` 这类
   子路径导出解析不到而失败。
3. **二进制必须比 `cli.js` 新才用。** 上游升级会重写 `cli.js`，而旧二进制里嵌的是旧版界面；
   启动器用 `-nt` 判断新鲜度，`apply` 会先删旧二进制再重建，`restore` 也会一并删除
   （否则「还原英文」之后仍是中文）。

预编译是**尽力而为**：任何失败都只打印原因并退回 JS 路径，不会让 `apply` 失败。
非 Windows 平台可设 `OMP_ZH_NO_NATIVE=1` 跳过，或运行 `bun patch.ts native` 单独重建。
Windows 的启动器使用 JS 路径，默认跳过预编译；本节的性能数据不适用于 Windows。

## 快速开始（一行命令，始终用最新补丁）

```bash
curl -fsSL https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.sh | bash
```

自动 clone/更新补丁仓库到 `~/.omp-zh`、补齐依赖并应用汉化。**omp 升级后重跑同一行命令即可**——
每次都会拉取最新补丁（含新版本适配），无需手动改任何东西。

```bash
# 查看状态 / 还原英文 / 完整校验
curl -fsSL https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.sh | bash -s -- status
curl -fsSL https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.sh | bash -s -- restore
curl -fsSL https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.sh | bash -s -- test
```

或手动 clone（等价）：

```bash
git clone https://github.com/yebuwudong/omp-zh.git ~/.omp-zh
cd ~/.omp-zh && ./omp-zh.sh apply
```

### 更新补丁

补丁会持续跟进上游版本，更新方式二选一（等价，第二条内部就是 `git pull`）：

```bash
# 方式一：重跑安装命令（自动 pull + 应用）
curl -fsSL https://raw.githubusercontent.com/yebuwudong/omp-zh/main/install.sh | bash

# 方式二：手动更新已 clone 的目录
cd ~/.omp-zh && git pull && ./omp-zh.sh apply
```

> `git pull` 只对**已经 clone 过**的目录有效（默认位置 `~/.omp-zh`，可用 `OMP_ZH_HOME` 改）。
> 第一次使用请走上方的安装命令。

## 日常使用

```bash
cd ~/.omp-zh
./omp-zh.sh status     # 查看当前汉化状态
./omp-zh.sh restore    # 还原成官方英文版
./omp-zh.sh apply      # 重新应用汉化
```

临时切回英文（不改文件）：

```bash
OMP_ZH=0 omp-zh     # 二进制安装
OMP_ZH=0 omp        # npm / bun -g 就地安装
```

不确定该用哪个命令？跑一次 `./omp-zh.sh status`，最后一行会写明启动方式。

## omp 升级后怎么办

`omp upgrade` / `bun install -g` 会覆盖 `dist/cli.js`，汉化随之丢失。重跑一条命令即可：

```bash
cd ~/omp-zh && ./omp-zh.sh apply
```

补丁器自带**两层自动适配**，绝大多数上游发版无需人工介入：

**一、标识符重命名（通配匹配）** —— 官方每次重打包都会重命名压缩后的内部变量
（如 `Ke`→`$e`、`$3e`→`Sje`），补丁会在精确匹配失败时切换到通配匹配，
自动捕获新变量名并代入替换文本：

```
anchor adapted: help epilogue block ($3e→Sje)
anchor adapted: thinking flag description (S5→U5)
...
anchors: 61/61 applied
```

**二、文案改为动态渲染（多形态锚点）** —— 有时上游会把写死的提示文字改成按快捷键表拼装，
字面量彻底消失，通配匹配也无能为力：

```js
// 旧：字面量
`${n}j/k:select  Enter:open  t:${s}  Tab:details  r/x:manage  Esc:close`
// 新：按键名运行时渲染
`${n}${keys(["j","k"])}:select  ${key("enter")}:open  ...`
```

这类情况由锚点的 `alts` 字段承载：同一处 UI 的多种上游形态并列声明，
精确匹配逐形态尝试、通配匹配兜底，取第一个命中者。设置页脚的模板包裹同理。

只有上游**改动文案或删除代码**（而非重命名、也非形态变化）时才会真正失配，此时 `apply`
会报错退出且不写出坏产物（英文版原样保留），把报错发 issue 即可。

> 模板目标（设置页脚等字面量改写够不到的界面）失配属**硬失败**，
> `check` 会以 exit 1 拦截，避免某块 UI 悄悄停留在英文。

大版本升级后建议顺便跑一次 `./omp-zh.sh report`，
命中数量若骤降说明产物结构大改，需要同步补丁规则。

## 维护者工具：一键补译

上游每次发版都会带来十几条新界面文案。补译只需一条命令：

```bash
cd ~/.omp-zh
bun tools/translate.ts
```

它会依次执行（每步都有进度提示）：

| 步骤 | 动作 |
|---|---|
| 1/6 扫描 | 对照词典找出版本里未翻译的界面英文 |
| 2/6 翻译 | 调用 OpenAI 兼容端点批量翻译 + **模型自查**（带着上下文和校验标记复核草稿并修订；`--no-review` 可关） |
| 3/6 打印 | 输出全部候选（审计留痕，不打断流程） |
| 4/6 并入 | 写进 `dict-extra.json` |
| 5/6 验证 | 自动跑 `apply` + 完整断言（锚点、游离中文、回退） |
| 6/6 发布 | 需显式 `--push` 才提交推送 |

**默认全自动**：初译后由同一模型复核（看到原句、调用上下文、机械校验标记），修订结果重新过一遍校验才允许并入；
候选文件 `dict-candidates.json` 保留完整记录供事后追溯。

常用参数：

```bash
bun tools/translate.ts --review           # 停在审阅（只打候选，不写词典）
bun tools/translate.ts --no-review        # 关闭模型自查（单遍翻译）
bun tools/translate.ts --dry-run          # 只扫描+翻译，不写任何文件
bun tools/translate.ts --push             # 验证通过后自动 commit + push
bun tools/translate.ts --model cn:glm-5.3 # 换翻译模型
bun tools/translate.ts --endpoint https://api.openai.com/v1   # 换端点
```

端点与凭据解析顺序（**密钥永不入库**）：

```
--endpoint / OMP_ZH_ENDPOINT 环境变量
  ↓ 未设置时
~/.omp/agent/models.yml 里记录的本地网关
  ↓ 都没有
报错提示你配置
```

模型解析顺序：`--model` / `OMP_ZH_MODEL` → `~/.omp/agent/models.yml` 里的第一个模型 id。
未显式指定时不再回落到写死的别名，避免换机器后每个批次都 404。

自动质量保障（无需人工）：

1. **结构校验（硬门禁）**：占位符 `${x}`、数字形态不一致 → **拒绝并入**（词典里没有该键，界面保持原文，不会出错）
2. **术语锁（软提示）**：原文含 `Compact`/`Vibe`/`Advisor`/`Prewalk`… 时检查译文是否用了既定译法，违反则标记但仍并入，在输出里提示
3. **审计留痕**：全部候选写入 `dict-candidates.json`，随时可回看

> 需要手工介入时，底层工具可单独使用：
> `bun tools/extract-gaps.ts --json report-gaps.json` 扫描缺口，
> `bun tools/auto-translate.ts` 生成候选，`--accept` 并入。
>
> 扫描/翻译工具自己解析补丁目标（含二进制安装的侧载目录），无需设置任何环境变量；
> 需要指定时用 `OMP_ZH_SRC`（直接给 `cli.js` 路径）或 `OMP_PKG`（给包目录）。

## 汉化范围

已汉化：

- 设置面板：分组标题、条目名称、描述、页脚提示（`按 Enter/空格修改 · 按 Tab 跳转分区 · ←/→ 切换标签 · 输入以搜索 · 按 Esc 关闭`）
- 欢迎屏：`欢迎回来！`、`提示`、`LSP 服务器`、`最近会话`、快捷键说明
- 首次启动向导与供应商登录流程的说明文字
- 状态栏通知、错误与警告文案、斜杠命令描述与状态（`loop 循环：关闭`、`循环：已暂停`…）
- 欢迎屏随机 Tip 正文（27 条全部）
- 约 4200 处调用点、3200 余条词条（随上游发版持续增长）

**不汉化**（有意保留英文）：

| 类别 | 例子 | 原因 |
|---|---|---|
| 面向模型的提示词 | 工具 JSON-Schema 的 `description`、`summary` | 属于 prompt，翻译会改变 agent 行为 |
| 枚举与协议值 | `low`/`high`/`xhigh`、`braille`、`rebuild`、`true`/`false` | 参与 `===` 比较、`switch` 分支与持久化，翻译会破坏逻辑 |
| 设置分组标识 | `TAB_GROUPS` 数组与 `ui.group` | 排序用 `indexOf` 字符串匹配，必须两侧一致 |
| 命令与参数名 | `--auto-approve`、`/settings` | 输入标识符 |
| 用户数据 | 模型名、提供商名、版本号、工作目录 | 运行时数据，非界面文案 |

## 安全设计

补丁器只改写**能证明是展示用途**的字符串字面量，判定基于 AST 上下文：

- ✅ 翻译：`label:`/`description:`/`title:` 等属性值、主题样式函数参数（`fg`/`bold`/`showStatus`…）、
  设置分组名（属性侧与 `TAB_GROUPS` 数组侧**同时**翻译）、`return` 语句中的短状态标签
- ❌ 跳过：对象键、import 源、比较运算、`switch` 分支、正则、计算属性、枚举数组、
  集合构造调用、模型侧 schema 子树

任何字符串只要在某处出现在"逻辑/身份位"，就**整条跳过**——避免同一文本半英半中出现不一致。

**拼接模板**（如页脚 `Enter/Space to change · ${x}Type to search`）单独处理：整段模板包裹进
运行时片段翻译函数 `__omp_i18n_f`，在字符串拼装完成后替换静态片段。

`./omp-zh.sh verify` 会重新解析产物并断言：

- 产物语法完整（约 27 MB，零解析错误）
- 所有 CJK 字面量都经由翻译函数，无游离中文落入逻辑位置
- 每次翻译调用的参数都在词典内
- **无标识符粘连**（minified 代码 `return"…"` 改写后不得变成 `return__omp_i18n_t`）
- **无原型属性名被包裹**（见下）

### 原型链陷阱（已修复）

JS 里 `dict["__proto__"]` 返回 `Object.prototype` 而非 `undefined`，会骗过 `!== undefined` 守卫。
修复前有 25 处上游**原型污染防护被静默破坏**：

```js
// 上游源码：跳过原型污染键
if (k === "__proto__" || k === "constructor") continue;
// 错误改写后：__omp_i18n_t("__proto__") 返回 Object.prototype
if (k === __omp_i18n_t("__proto__") || ...) continue;  // 恒为 false，防护失效
```

修复：所有查表改用 `Object.hasOwn` 隔离原型链 + `FORBIDDEN_KEYS` 显式拒绝 13 个 JS 原型属性名，
`verify` 断言这两类键永不出现在调用点。

## 更新日志

### 预编译字节码二进制 + Windows 兼容性

**启动性能**：侧载运行时是 30MB JS 产物，每次启动重新解析编译要 1.1 秒。`apply` 现在会额外
把它预编译成带字节码的独立二进制，启动器优先使用，**实测从 1.1 秒降到 0.2 秒**。细节见
上面「启动性能」一节，包括 `--format=esm` 为什么是必需的。

**Windows 兼容性**（未真机验证）：

1. **包装脚本不再被当成目标**。Windows 的 npm/bun 会在 PATH 上放 `omp.cmd` / `omp.ps1`，
   `Bun.which("omp")` 拿到的就是它。此前直接当作 bundle 会让 Babel 解析批处理语法、
   让备份的 `mkdir` 报 `ENOTDIR`。现在会从包装脚本里解析出真正的 `dist/cli.js`，支持
   npm 的 `%~dp0` 相对形态、bun 的绝对路径形态和 PowerShell 的 `$PSScriptRoot` 形态。
2. **目标解析失败不再拖垮 `doctor`**。以前 `resolveTarget()` 在模块加载期执行且没有兜底，
   Windows 上跑任何命令（包括 `doctor`）都是先崩再谈诊断 —— 恰恰在最需要诊断的时候拿不到
   信息。现在解析失败会回退并提示跑 `doctor`，`doctor` 本身也补上了 bundle 缺失的分支。
3. **`chmod` 与 symlink 平台化**。Windows 上跳过 `chmod`（无意义）与 symlink（需要管理员
   权限或开发者模式），改为在 `%APPDATA%\npm` 生成 `.cmd` 启动器；`.cmd` 里 `sh` 分支用
   POSIX 正斜杠路径（Git Bash 会把它交给真 shell，反斜杠会被当转义），bun 分支用原生反斜杠。
4. **`doctor` 增加 Windows 诊断项**：`USERPROFILE`、`APPDATA`、`PATHEXT`、是否找到 `sh`、
   包装脚本解析结果。
5. **`OMP_PKG` 指向 `.exe` 时走侧载**。官方 Windows 安装器装的是
   `%LOCALAPPDATA%\omp\omp.exe`，把它当包目录会拼出 `omp.exe\dist\cli.js` 这种无效
   路径。现在识别出这是预编译二进制，改走侧载并生成启动器。

### 适配 omp 18.10.x：启动器版本漂移、欢迎页提示、设置页脚、词典缺口

面向 omp **18.10.1** 的一轮修复，四类问题都表现为「界面仍是英文」：

1. **启动器把版本号写死**（最影响使用）
   预编译二进制安装靠 `~/.omp-zh/bin/omp-zh` 启动侧载运行时，而旧启动器把
   `runtime/<版本>/…/cli.js` 的绝对路径写死在文件里。官方 omp 原地升级到 18.10.1 后，
   侧载目录要等下一次 `apply` 才出现，于是 `omp-zh` 一直跑旧版本（表现为「官方 18.10.1、
   omp-zh 还停在 18.10.0」）。现在启动器在**运行时**解析：先取官方 `omp --version`，
   命中就用对应侧载；没有该版本的已汉化侧载时，回退到最新的已汉化侧载并在 stderr
   提示重跑 `apply`。嵌入脚本同时改为 POSIX 可移植写法（`awk` 比较版本、
   `grep -oE` 提取），不再依赖 BSD `sort -V` 与 `sed` 的反向引用。

2. **欢迎页提示（tips）整块未汉化**
   `findBlocks` 只认「无插值的模板字面量」，而上游把 34 行 tips 语料放在一个普通字符串
   常量里，因此整块被漏掉：字面量扫描只看到一个 3.5KB 的键（任何词条都匹配不上），
   块改写器又看不到它。现在两类字面量都识别。同时 `Tip: ` 前缀是独立键、且同文本
   还出现在 `startsWith` 判断里，被禁用规则整条拦下 —— 改为把 `Tip: ${…}` 模板
   纳入 `TEMPLATE_TARGETS`，整行走 fragment 翻译，判断式不受影响。

3. **设置页脚与短标签**
   `to change` 这类片段若作为全局 fragment 键，会把
   `Ask the user to change the setting themselves.` 之类的句子改成中英混排；
   实测确认后改为**带中点的窄键**（` to change ·`），只可能命中按键提示行。
   另有 40 个短标签（`Find`/`Wait`/`Quit`/`Toggle`…）此前被 `schema:toolClass`、
   `stray(other:…)` 等保守规则整条跳过 —— 逐个用 `patch.ts probe` 审计后，
   对「同一文本另有身份副本」的键启用既有的 `SPLIT_UI_STRINGS` 拆分机制：
   只翻译渲染副本，身份副本（`k==="File"`、表头数组、XML 标签）保持英文。
   `Abort`/`Approve`/`Revise` **不拆分**：`select()` 返回的就是选项 label，
   调用方拿它做比较，拆开会让批准流程失效。工具类 `label` 也确认只用于渲染
   （送给模型的是 `name`/`description`/`parameters`），可安全翻译。

4. **词典缺口与噪声**
   补译 134 条（121 条可翻译缺口 + 13 条 tips 行）+ 40 条短标签，缺口数
   **164 → 0**。`dict-extra.json` 此前被按 tab 缩进重写，导致 PR 里 6300 行
   纯格式 diff（真实改动只有 16 条）；写入器统一为 `localeCompare` + 1 空格缩进，
   与既有文件字节一致。

5. **`/hotkeys` 面板**
   两个渲染路径都漏了。markdown 路径拼出 `| Key | Action |` 与 `| <键> | <动作> |`，
   整串走 fragment 翻译，但表头是短 token（低于 fragment 长度下限）替换不到 ——
   改为词条覆盖表头/分隔行 + 锚点包裹两个面板类的 `cols` head。
   另有一行动作由键位查表拼成（源码 `(${Ne("up")} when empty)`，渲染为
   `（↑ when empty）`）：词条存的是源码拼写（`Up`），永远匹配不上渲染结果，
   加锚点把该模板包进 fragment 翻译并按渲染文本补词条。

验证：18.10.1 与 18.10.2 产物均 **65/65 锚点、0 缺口**；`apply`/`verify` 全部不变量成立；
PTY 实机抓取欢迎页、设置页、`/hotkeys` 面板，tips、页脚、设置项、表头均为中文，
且英文句子未被 fragment 误伤（`Ask the user to change the setting themselves.` 原样返回）。
`/hotkeys` 之外还顺带确认了启动器自愈：验证期间官方 omp 自动升到 18.10.2，
`omp-zh` 无需手工干预即跟随到新版本的侧载运行时。

### 补译流程修复：静默丢批、静默成功、无效词条

一轮补译暴露出三个问题，都影响「翻译结果是否可信」：

1. **整批静默丢失（最严重）**
   `chat()` 固定传 `max_tokens: 4000`。20 条 UI 文案的 JSON 回包会超过这个上限而被截断，
   解析器用 `lastIndexOf("}")` 取到的是**中间**某个括号，于是整批 20 条全部丢失，
   表现为「模型返回了非法 JSON」。现在**不再传 `max_tokens`**，用端点自己的默认值：
   推理模型会先把预算花在隐藏思考上，任何我们选的上限要么截断 JSON、要么让 `content` 直接为空
   （`finish_reason: "length"`）。实测同一条请求：传 400 → 空内容；不传 → 完整返回。

2. **全部批次失败却报成功**
   批次异常被 `continue` 吞掉，死端点也能跑完并输出「完成」、`exit=0`。
   现在累计失败数，一条候选都没产出时直接硬失败并给出端点地址。

3. **翻译注定无效的词条**
   有些缺口键的同一文本也出现在逻辑/身份位，补丁器会整条跳过（`decideAll` 的 ban 规则），
   给它们加词条永远不生效。新增 `patch.ts probe --keys <file>` 批量判定，
   `translate.ts` 在**花钱翻译之前**先剔除这些键，并打印被排除的清单。

解析器同时改为括号配对扫描：截断会明确报 `response was truncated`，而不是含混的
`model returned no JSON`；`chat()` 还会区分「端点返回空内容」与「输出预算耗尽」。

### 补译工具路径解析 + 被救回锚点的验证误报

`bun tools/translate.ts` 在二进制安装上报 `ENOENT: ~/.bun/install/global/...`：扫描工具写死了
npm 全局安装路径，而本机汉化产物在侧载目录。现在扫描/翻译工具自动向补丁器询问目标路径，
二进制安装、npm/bun 全局安装、`OMP_PKG` / `OMP_ZH_SRC` 显式指定都能正确解析。

同时修掉一个会**卡住整个补译流程**的验证误报：上游把面板标题从 `super("History")` 改成
常量对象后，锚点找不到，但键本身仍能被字面量扫描翻译到 —— 这类「救回」的锚点已正确写入产物，
`verify` 却仍报 `anchor not applied`，使 `translate.ts` 第 5 步（自动验证）失败、无法发布。
现在 `planAnchors` 显式返回被救回的锚点名，写入 manifest，`verify` 与 `obsolete` 同等对待。

顺带修掉两处易误判的地方：

- `check --code <已打补丁文件>` 现在自动回退到旁边的原始备份，不再把「已汉化」误报成
  「锚点全部失配」（CI 里表现为假的硬失败）。
- `check` 摘要改为按**条目名去重**统计（`61/61 entries ok`）。此前把 `all: true` 锚点的多个
  写入点相加，会出现 `63/61` 这种自相矛盾的数字。

### 动态渲染锚点适配 + PATH 自动补全

修掉「补丁显示成功、界面仍是英文」这一整类问题，共三处根因：

1. **锚点失配导致 `apply` 整体失败**（上游某次重构后开始）
   上游把 Agent Hub 快捷键提示与设置页脚从字面量改为按键表动态渲染，
   6 处锚点/模板目标失效。新增 `alts` 多形态锚点机制：同一 UI 的多种上游形态并列声明，
   精确匹配逐形态尝试、通配匹配兜底。回归测试覆盖新旧多种产物形态，均 `61/61 anchors applied`。

2. **启动器不在 PATH**
   二进制安装的汉化产物在侧载目录，必须用 `omp-zh` 启动；而 `~/.omp-zh/bin` 默认不在 PATH，
   用户敲 `omp` 看到英文，误以为补丁失败。现在补丁器自动软链到 `~/.local/bin`（不覆盖已有文件），
   `status` 与 `doctor` 都会报告启动方式与 PATH 状态。

3. **启动器依赖 `bun` 在 PATH**
   改用 `process.execPath` 记录的绝对路径调用 `bun`，最小环境（无 `~/.bun/bin`）也能启动。

另外修掉一个**静默失败**：`patch.ts path` 在首次侧载新版本时会把 `bun add` 的进度输出混进 stdout，
使 `omp-zh.sh` 里的 `$CLI` 变成多行、`[[ -f ]]` 判定失败后直接退出，补丁从未应用。
现进度输出一律走 stderr，且 `omp-zh.sh` 取最后一行并显式校验。

CI 门禁同步收紧：模板目标失配从「软警告（exit 2）」升为「硬失败（exit 1）」，
因为它和锚点一样会让某块 UI 悄悄停留在英文。

## 已知限制

- 极少数词典未收录的条目仍为英文（如 `Agent Reactions`、`Mouse Click-to-Focus`）。
- 翻译来自社区分支 `yequ172672/oh-my-pi-cn`，个别术语可能与上游新增功能不完全对齐。
- **Windows 验证范围见「Windows 支持现状」**；`install.sh` / `omp-zh.sh` 是 bash 脚本，Windows 上需手动执行 `bun patch.ts` 子命令。
- 已实测：`--version`、欢迎屏、设置面板（含页脚与右列值）、slash 补全描述、`OMP_ZH=0` 回退、TUI 冒烟零残留。

## 设置行右列的值显示

设置面板每行右侧显示的是**原始配置值**（`true`/`false`/`rebuild`/`braille`/`none`…），官方英文版同样直显。
这里复刻了上游汉化分支的 `valueLabels` 机制（该分支在组件层实现；官方产物没有这个字段，
所以在字符串层等价重建）：

1. `defToItem` 构建行时，`__omp_i18n_vlm(e.options)` 把该设置自己的选项标签映射成
   `{原值 → 显示标签}`（标签走词典，例如 `Rebuild`→`重建`）。设置里 `none` 在不同条目下含义不同
   （`关`/`无`/`隐藏`），所以必须按设置各自的选项表解析，不能全局一刀切。
2. 无选项的行（布尔值与少数就地循环的枚举，如 `discard`/`keep`、`per-call`）回退到全局表
   `__omp_i18n_vd`（`true`→`是` 等），这些取值集合无歧义。
3. 行渲染时 `__omp_i18n_vr(e)` 先查第 1 步的表，再查全局表；**文本框、多选、提供商限额等自由文本
   行原样显示**（代码里只对带 `values` 集合的行做映射，路径、API key、模型 id 不会被误翻）。
4. 搜索索引同步收录映射后的标签，因此输入 `重建` 能搜到「调整滚动历史」条目。

运行时可断言验证（无需截图）：

```bash
./omp-zh.sh test            # verify + 值标签断言（译文、歧义消解、自由文本原样）
OMP_ZH=0 bun tools/test-value-labels.ts   # 回退断言（全英文）
```

## 来源与许可

本项目以 [MIT](./LICENSE) 发布。译文取自
[yequ172672/oh-my-pi-cn](https://github.com/yequ172672/oh-my-pi-cn)（MIT，与上游
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 同许可），本地仅做版本适配与安全裁剪，
未改动译文语义。`LICENSE` 里保留了上游与译文来源的原始版权声明，再分发时请一并保留。
