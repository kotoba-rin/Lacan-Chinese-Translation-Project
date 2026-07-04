# 贡献指南

本项目采用 Markdown 直译模式、GitHub Pull Request 协作和 mdBook 发布。README 用于介绍项目本身；贡献指南集中说明分支、项目结构、文本格式、本地构建和 PR 约定。

## 分支说明

- `main`：主干分支，保留完整整理稿，包括译文、注释、术语说明、导读、校订说明和建言等内容。
- `DEV`：脚本开发分支，针对 mdBook 页面功能适配进行开发迭代，完成后合并至 `main` 分支。

## 项目结构

- `texts/`：翻译协作源文件目录，长期维护原文、译文、术语表和原文关联图片。
- `texts/<seminar>/original/Leçon-xx.md`：按课时拆分的原文 Markdown，段落使用稳定 ID。
- `texts/<seminar>/translation/Leçon-xx.md`：对应课时的译文 Markdown，段落 ID 应与原文保持对应。
- `texts/<seminar>/notes/`：该期研讨班的阅读笔记和补充材料目录，每个材料单独放在一个 Markdown 文件中。
- `texts/<seminar>/original/assets/`：原文引用的图片资源。
- `texts/<seminar>/translation/assets/`：译文额外引用的图片资源。
- `texts/<seminar>/notes/assets/`：阅读笔记额外引用的图片资源。
- `texts/<seminar>/glossary.md`：该期研讨班的独立术语表。
- `texts/index.md`：mdBook 首页源文件，构建时生成到 `build/index.md`。
- `build/`：mdBook 临时生成展示层，由 `texts/` 和 `scripts/build_from_texts.py` 生成，不提交到仓库。
- `scripts/requirements.txt`：Python 脚本依赖清单，CI 和本地环境使用同一个入口安装依赖。
- `book.toml`：维护 mdBook 配置。
- `book/`：mdBook 生成结果，不提交到仓库。

## 文本分层规则

本项目采用“协作源文件”和“发布展示层”分离的方式维护文本。

协作者主要编辑 `texts/`：

- 原文放在 `texts/<seminar>/original/`。
- 译文放在 `texts/<seminar>/translation/`。
- 原文和译文都按课时拆分为 `Leçon-xx.md`。
- 段落使用稳定 ID 对齐，例如同一段原文和译文都保留 `s8-01-0001` 这样的 ID。
- 阅读笔记和补充材料放在 `texts/<seminar>/notes/`，通过 Obsidian 双链或分段 ID 与译文互相引用。
- 每期研讨班的术语表维护在 `texts/<seminar>/glossary.md`。

`build/` 只作为 mdBook 的临时发布入口。构建发布页面时，脚本会把同一课的原文和译文按段落 ID 合成为 `build/<seminar>/Leçon-xx.md`。这样可以在 GitHub Pages 上同时打包原文和译文，并通过页面脚本提供“显示原文 / 隐藏原文”的阅读开关。

因此，日常翻译 PR 应修改 `texts/`；项目说明页修改根目录 `README.md`，贡献指南修改根目录 `CONTRIBUTING.md`，mdBook 首页修改 `texts/index.md`。`build/` 中的双语展示页由构建脚本重新生成，不提交到仓库，避免把协作源文件和发布格式混在一起。

## 原文与分段

1. 共同翻译原文以 Staferla 的 Word/DOCX 文本为准。
2. 图片内容、图注和图片在正文中的相对位置以 Word/DOCX 导出的 Markdown 为准。
3. Word/DOCX 中已经以图片形式存在的公式、图形和符号继续保留为图片引用。
4. 段落 ID 是原文和译文对齐、讨论和审阅的锚点。

分段 ID 通常类似 `s8-01-0001`，表示研讨班、课次和段落序号。评论、校验、交流和 PR 审阅时，请尽量用分段 ID 指明讨论对象，避免使用“上一段”“第三段”这类容易失效的描述。

## mdBook 相关资源

- 项目地址：[rust-lang/mdBook](https://github.com/rust-lang/mdBook)
- 使用文档：[mdBook Documentation](https://rust-lang.github.io/mdBook/)
- 下载地址：[mdBook Releases](https://github.com/rust-lang/mdBook/releases)

本项目不提交 mdBook 二进制文件，也不提交生成后的 `build/` 和 `book/` 目录。`bin/` 是本地工具目录，已加入 `.gitignore`；GitHub Actions 会在 CI 中下载 Linux 版 mdBook。本地使用时，请先安装 `mdbook` 并确保它在 `PATH` 中：

```bash
mdbook --version
```

常见安装方式：

```bash
cargo install mdbook
```

也可以从 [mdBook Releases](https://github.com/rust-lang/mdBook/releases) 下载对应系统的预编译二进制文件，解压后放到本机 `PATH` 中。

Python 脚本依赖由 `scripts/requirements.txt` 维护。当前脚本只使用 Python 标准库，仍建议使用同一命令初始化环境，方便后续新增依赖：

```bash
python3 -m pip install -r scripts/requirements.txt
```

## 生成发布展示层

`scripts/build_from_texts.py` 用来把长期维护的 `texts/` 内容合成为 mdBook 使用的 `build/` 展示层。日常翻译、校对和分段调整应优先修改 `texts/`；修改完成后再运行这个脚本重新生成 `build/`。

从全部 `texts/<seminar>/original/` 目录生成 `build/`：

```bash
python3 scripts/build_from_texts.py
```

只生成某一期研讨班：

```bash
python3 scripts/build_from_texts.py --seminar s8-le-transfert
```

一次只生成多期研讨班，可以重复传入 `--seminar`：

```bash
python3 scripts/build_from_texts.py \
  --seminar s8-le-transfert \
  --seminar s20-encore
```

只更新课文页面、不重写 `build/SUMMARY.md`：

```bash
python3 scripts/build_from_texts.py --seminar s8-le-transfert --skip-summary
```

生成 `build/` 后再打包 mdBook：

```bash
python3 scripts/build_from_texts.py
mdbook build
```

本地预览：

```bash
python3 scripts/build_from_texts.py
mdbook serve --open
```

## 输入目录约定

脚本读取以下文件：

- `texts/index.md`：可选。存在时会生成 `build/index.md`，作为 mdBook 首页。
- `texts/<seminar>/original/Leçon-xx.md`：必需。每个 `<!-- id: ... -->` 标记开始一个原文段落，直到下一个 ID 标记为止。
- `texts/<seminar>/translation/Leçon-xx.md`：可选。文件不存在时，该课原文仍会生成，译文位置显示 `[无对应译文]`。
- `texts/<seminar>/notes/*.md`：可选。每个文件生成一个阅读笔记页面。笔记中的分段 ID 会生成到对应译文段落的反向链接。
- `texts/<seminar>/original/assets/`：可选。原文图片会复制到 `build/<seminar>/assets/`。
- `texts/<seminar>/translation/assets/`：可选。译文额外图片也会复制到 `build/<seminar>/assets/`。
- `texts/<seminar>/notes/assets/`：可选。阅读笔记图片会复制到 `build/<seminar>/notes/assets/`。
- `texts/<seminar>/glossary.md`：可选。存在时会复制为 `build/<seminar>/glossary.md`。
- `texts/<seminar>/original/README.md`：可选。存在时脚本会优先用其中的标题生成 `build/<seminar>/README.md`。

`<seminar>` 必须使用目录 slug，例如 `s8-le-transfert`、`s20-encore`。`Leçon-xx.md` 的编号用于排序，建议保持两位数字，例如 `Leçon-01.md`。

## 原文格式

原文课文的基本结构如下：

```markdown
# Leçon 01 | 16 Novembre 1960

<!-- id: s8-01-0001 -->

原文第一段。

<!-- id: s8-01-0002 -->

原文第二段。
```

标题位于第一个段落 ID 之前。`## Notes` 及其后面的内容会被视为原文注释区，生成到页面底部的注释块里。

## 译文格式

译文同样使用 `<!-- id: ... -->` 标记。一个 ID 到下一个 ID 之间的内容是一个译文条目：

```markdown
<!-- id: s8-01-0001 -->

中文译文第一段。

<!-- id: s8-01-0002 -->

中文译文第二段。
```

译文分段规则：

- 两段之间有空行，视为不同 Markdown 段落。
- 只有换行但没有空行，仍视为同一个文本区块。
- 译文条目下方的引用区块会被视为对该译文条目的注释或建言。

如果一个中文译文条目对应多个原文段落，在译文 ID 后添加 `<!-- ids: ... -->`：

```markdown
<!-- id: s8-01-0001 -->
<!-- ids: s8-01-0001 s8-01-0002 s8-01-0003 -->

这一个中文译文区块对应上面三个原文段落。
```

其中 `id` 是该译文条目的锚点，`ids` 是它实际覆盖的原文段落 ID 列表。生成页面时，这些原文段落会合并显示在同一个对照区块里。

如果某段已经确认暂不翻译，可以标记：

```markdown
<!-- id: s8-01-0004 -->
<!-- untranslated -->
```

页面会显示 `[未译]`。如果完全没有对应译文文件或译文 ID，页面会显示 `[无对应译文]`。

构建前会先检查每个原文、译文和阅读笔记文件中的 `<!-- id: ... -->` 锚点声明。同一个文件里如果出现重复 `id`，脚本会直接报错退出，并输出重复 ID 所在文件和行号。`<!-- ids: ... -->` 合并声明不算新的锚点。

## 阅读笔记和双向链接

每期研讨班可以在 `texts/<seminar>/notes/` 下维护阅读笔记和补充材料。每个材料单独一个 Markdown 文件，文件名建议使用可读 slug，例如 `platon-banquet.md` 或 `transfert-definition.md`。

阅读笔记可以用 frontmatter 标明关联分段：

```markdown
---
title: 柏拉图《会饮》背景
segments:
  - s8-01-0005
  - s8-01-0006
---

# 柏拉图《会饮》背景

这里讨论 [[s8-01-0005|第一处相关段落]]。
```

译文中可以通过 Obsidian 双链引入笔记：

```markdown
<!-- id: s8-01-0005 -->

这里是译文正文。参见 [[notes/platon-banquet|柏拉图《会饮》背景]]。
```

构建时，`[[notes/platon-banquet|柏拉图《会饮》背景]]` 会转换成指向阅读笔记页面的 mdBook 链接；`[[s8-01-0005|第一处相关段落]]` 会转换成指向对应课文段落锚点的链接。脚本也会根据阅读笔记中的分段 ID，在对应译文段落旁生成“相关阅读笔记”反向入口。

## 注释和建言

译文条目中的连续引用区块会被单独分类：

```markdown
<!-- id: s8-01-0005 -->

这里是译文正文。

> 注：这里是译注。

> 这里是建言。
```

识别规则：

- 连续引用区块的第一条非空内容，以 `注` 开头，或者以 `【注】`、`[注]`、`（注` 这类形式开头，则整个引用区块归为“注释”。
- 其他引用区块归为“建言”。
- 页面会提供“原文 / 注释 / 建言”三个开关，分别控制这些内容的显示。

## mdBook 公式规则

`book.toml` 已启用 `mathjax-support = true`。为兼容 mdBook 内置 MathJax 支持，Markdown 源码中的 LaTeX 公式按以下方式书写：

- 行内公式使用 `\\(...\\)`。
- 块级公式使用 `\\[...\\]`。
- 公式中的反斜线需要按 Markdown/MathJax 规则保留；非公式文本不要误写成公式块，例如舞台提示或校订提示应保持普通文本。
- 不使用 `$...$` 或 `$$...$$` 作为本项目的默认公式分隔符。
- 这条规则只适用于源码中已经是文本形式的 LaTeX；原 Word 中的公式图片仍按图片处理。

## PR 协作

1. 内容校订基于 `main` 分支创建修改分支；mdBook 页面功能或脚本开发基于 `DEV` 分支创建修改分支。
2. 只修改与本次校订相关的课次、图片和术语表，优先修改 `texts/` 中的协作源文件。
3. 涉及关键术语、句法判断、版本差异或大段重译时，在 PR 说明中写明理由。
4. 新增图片放入对应研讨班目录的 `assets/`，正文中使用相对路径，例如 `![](assets/example.png)`。
5. 项目说明页修改根目录 `README.md`，贡献指南修改根目录 `CONTRIBUTING.md`，mdBook 首页修改 `texts/index.md`。
6. 新增课次时修改 `texts/` 中的源文件结构，并运行 `python3 scripts/build_from_texts.py` 检查生成结果。
7. 提交 PR 后等待 GitHub Actions 的 mdBook 构建检查。

## 注意事项

- `build/` 是展示层，可以由脚本重建；长期维护内容应放在 `texts/`。
- 修改 `texts/` 后，提交前建议运行 `python3 scripts/build_from_texts.py && mdbook build`。
- 只想降低 PR 噪音时，可以用 `--seminar` 限定本次修改涉及的研讨班。
- 如果修改了研讨班目录结构、课次文件、标题或术语表，通常不要使用 `--skip-summary`，让脚本同步更新 `build/SUMMARY.md`。

## GitHub Pages 发布

`.github/workflows/mdbook.yml` 会在 PR 中构建检查 mdBook，并在 `main` 分支推送后构建 `book/` 并发布到 GitHub Pages。

在仓库设置中需要将 Pages 的构建来源设置为 **GitHub Actions**，并允许 `main` 分支部署到 `github-pages` 环境。
