# omp 中文界面汉化（18.2.x）

把已安装的官方 omp（18.2.x）界面汉化为简体中文，**不改变版本、不替换安装、不动运行时结构**。

```
~/.omp-zh/
├── install.sh                    一行命令入口（curl | bash）
├── omp-zh.sh                     一键入口：apply / restore / verify / report / status
├── patch.ts                      补丁器（AST 分类 + 词典替换 + 锚点自动适配 + 校验）
├── dict.json                     2129 条英→中映射（源自 oh-my-pi-cn 汉化分支）
├── dict-extra.json               2700 条补充映射
├── analysis/                     侦察与词典构建脚本
└── tools/                        审计、实测、回退验证脚本
    ├── loose-anchor.ts           锚点通配匹配（重打包重命名自动适配）
    └── patch-templates.ts        模板字面量包裹

备份位于 <omp>/dist/.omp-zh-backup/（跟着安装走，多份 clone 共享）
```

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

## 日常使用

```bash
cd ~/.omp-zh
./omp-zh.sh status     # 查看当前汉化状态
./omp-zh.sh restore    # 还原成官方英文版
./omp-zh.sh apply      # 重新应用汉化
```

临时切回英文（不改文件）：

```bash
OMP_ZH=0 omp
```

## omp 升级后怎么办

`omp upgrade` / `bun install -g` 会覆盖 `dist/cli.js`，汉化随之丢失。重跑一条命令即可：

```bash
cd ~/omp-zh && ./omp-zh.sh apply
```

补丁器自带**锚点自动适配**：官方每次重打包都会重命名压缩后的内部变量
（如 `Ke`→`$e`、`$3e`→`Sje`），补丁会在精确匹配失败时切换到通配匹配，
自动捕获新变量名并代入替换文本，无需人工修锚点：

```
anchor adapted: help epilogue block ($3e→Sje)
anchor adapted: thinking flag description (S5→U5)
...
anchors: 61/61 applied
```

只有上游**改动文案或删除代码**（而非重命名）时才会真正失配，此时 `apply`
会报错退出且不写出坏产物（英文版原样保留），把报错发 issue 即可。

跨大版本升级（如 19.x）后建议顺便跑一次 `./omp-zh.sh report`，
命中数量若骤降说明产物结构大改，需要同步补丁规则。

## 汉化范围

已汉化：

- 设置面板：分组标题、条目名称、描述、页脚提示（`按 Enter/空格修改 · 按 Tab 跳转分区 · ←/→ 切换标签 · 输入以搜索 · 按 Esc 关闭`）
- 欢迎屏：`欢迎回来！`、`提示`、`LSP 服务器`、`最近会话`、快捷键说明
- 首次启动向导与供应商登录流程的说明文字
- 状态栏通知、错误与警告文案、斜杠命令描述与状态（`loop 循环：关闭`、`循环：已暂停`…）
- 欢迎屏随机 Tip 正文（27 条全部）
- 约 4827 个界面字符串

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

- 产物语法完整（23 MB，零解析错误）
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

## 已知限制

- 极少数词典未收录的条目仍为英文（如 `Agent Reactions`、`Mouse Click-to-Focus`）。
- 翻译来自社区分支 `yequ172672/oh-my-pi-cn`（基线 17.4.1），个别术语与 18.2.x 新功能不完全对齐。
- 已实测：`--version`、欢迎屏、设置面板（含页脚与右列值）、slash 补全描述、`OMP_ZH=0` 回退、TUI 冒烟零残留。

## 设置行右列的值显示

设置面板每行右侧显示的是**原始配置值**（`true`/`false`/`rebuild`/`braille`/`none`…），官方英文版同样直显。
这里复刻了上游汉化分支的 `valueLabels` 机制（该分支在组件层实现；18.2.x 产物还没有这个字段，
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

译文取自 [yequ172672/oh-my-pi-cn](https://github.com/yequ172672/oh-my-pi-cn)（MIT，与上游
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 同许可）。本地仅做版本适配与安全裁剪，未改动译文语义。
