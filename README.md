# Lacan-Chinese-Translation-Project

**拉康中文开放翻译计划**

<img src="assets/16-9.png" alt="拉康中文开放翻译计划横幅" width="720">

拉康中文开放翻译计划的目标，是让更多中文读者能够参与到阅读拉康、翻译拉康和校订拉康的过程中。本项目以开放协作方式整理、翻译、校订和维护雅克·拉康研讨班及相关文本的中文材料。

mdBook 在线阅读地址：[https://kotoba-rin.github.io/Lacan-Chinese-Translation-Project/index.html](https://kotoba-rin.github.io/Lacan-Chinese-Translation-Project/index.html)

本仓库采用 Markdown 直译模式、GitHub Pull Request 协作、mdBook 构建和 GitHub Actions 发布到 GitHub Pages。项目结构、分支规则、本地构建和 PR 约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 文本来源

本项目整理和翻译的研讨班原始文本主要来自 [Staferla](http://staferla.free.fr/)。

## 项目目标

- 为中文读者提供可读、可校订、可持续维护的拉康相关文本译稿。
- 让阅读者可以围绕具体段落提出修订、疑问、注释和术语建议。
- 保留必要的译注、术语讨论、导读、校订说明和修订痕迹。
- 使用适合 GitHub 浏览、引用、勘误和再整理的文件结构。
- 鼓励复制、传播、修订、注释和再发布。

## 参与方式

欢迎通过 issue 的方式提交对文本的补充、矫正、解释和考证：

- 补充文本、注释、导读或读书笔记。
- 矫正译文、原文分段、术语或格式问题。
- 解释关键术语、句法判断或段落理解。
- 考证文本来源、版本差异、引文出处或相关背景。
- 报告图片缺失、链接错误或段落不清等问题。

如果要直接修改文件，也欢迎通过 Pull Request 提交。较大的译文修改请尽量说明理由，尤其是涉及关键术语、句法判断或版本差异的地方。具体协作约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

更推荐 fork 本项目，维护一套自己的版本。通过对照不同派生版本中的翻译、注释与解读，可以形成更有针对性的交流。不要让他人替代了你的话语。

## 分段 ID 说明

分段 ID 是本项目协作时引用具体段落的稳定锚点，格式通常类似 `s8-01-0001`，表示研讨班、课次和段落序号。原文与译文通过同一个分段 ID 对齐，构建脚本也依靠这些 ID 生成双语对照页面。

在评论、校验、交流和 Pull Request 审阅过程中，请尽量使用分段 ID 指明讨论对象。例如可以写“`s8-01-0001` 的术语建议”或“请核对 `s8-01-0002` 与原文的对应关系”。这样比只说“第三段”更稳定，因为页面展示、排序或上下文发生变化后，分段 ID 仍能定位到同一处文本。

维护文本时不要随意改动已有分段 ID。只有在原文分段结构确实需要调整时，才同步更新相关原文、译文、注释和 PR 说明，避免评论、校验记录和后续修订失去引用对象。

## Obsidian 插件

本仓库内置了一个 Obsidian 桌面端插件：`Lacan Translation Helper`。它用于在 Obsidian 中阅读、编辑和对照 `texts/` 下的原文与译文。

### 安装说明

1. 安装 Obsidian 桌面端。
2. 将本仓库 clone 或 fork 到本地。
3. 在 Obsidian 中选择“Open folder as vault”，打开本仓库根目录。
4. 进入 Obsidian 设置，打开“Community plugins”，关闭安全模式限制后启用 `Lacan Translation Helper`。
5. 如果插件没有显示，确认本地存在 `.obsidian/plugins/lacan-translation-helper/manifest.json`、`main.js` 和 `styles.css`，然后重启 Obsidian 或重新加载插件。

插件的 Git 同步功能需要本机安装 Git CLI，不需要安装 Obsidian Git 插件。插件当前是桌面端插件，不适用于 iPad 或手机端的插件内 Git 同步。

### 使用说明

插件主要提供以下功能：

- 在 `texts/<seminar>/original/Leçon-xx.md` 和 `texts/<seminar>/translation/Leçon-xx.md` 之间创建、填充和维护译文骨架。
- 保存译文文件后，根据 `<!-- untranslated -->` 自动计算翻译进度，并写入文件 frontmatter。
- 在 Obsidian Bases 中按研讨班和课次查看条目，快速进入原文、译文或创建缺失译文。
- 同步 GitHub 主仓库内容，并支持配置多个 fork 作为对照版本。
- 在阅读预览中选择 fork 后，可在具体分段旁展开该分段的对照内容。

常用入口：

- 右键原文课文，可以选择“生成译文骨架”。
- 右键译文课文，可以选择“为空译文填充分段骨架”。
- 命令面板中可以运行 `Create translation skeleton from active lesson`、`Update translation progress for all lessons` 和 `Sync configured GitHub repositories`。
- 插件设置页中可以配置仓库地址、Reader/Editer 模式、GitHub HTTP 代理、启动时自动同步和 fork 对照版本。

模式说明：

- Reader：同步 GitHub 主仓库的最新更新到本地当前项目，适合只阅读或查看译文的人。
- Editer：同步主仓库时只下载为对照版本，不覆盖你正在编辑的当前文件，适合参与翻译的人。
- Fork 对照：Reader 和 Editer 都可以使用。先在设置页添加 fork，再在文本页面顶部选择 fork 版本，之后可在分段旁展开对照。

同步说明：

- “立即同步”会获取主项目和已启用 fork 的最新内容。Reader 模式下会先弹出确认框，确认后直接用 GitHub 主仓库覆盖当前项目；Editer 模式不会覆盖当前文件。
- 如果当前目录还没有 `.git`，插件会先自动执行 `git init`。
- Reader 模式同步会将当前项目对齐到 GitHub 主仓库，用于处理从 zip 或普通文件夹打开项目时文件尚未被 Git 跟踪的情况；如需保留本地编辑内容，请先使用 Editer 模式或手动备份本地修改。
- Reader 模式默认不建议开启启动时自动同步。开启时插件会弹出说明，避免用户误以为 Reader 同步会保留本地编辑内容。
- GitHub HTTP 代理只作用于插件执行的 GitHub 同步命令，不会改变 Obsidian 其它网络操作。
- fork 会保存到独立的本地对照分支，避免覆盖当前正在编辑的内容。

Obsidian 语法兼容说明：

- 在 `texts/` 下编辑原文、译文和注释时，可以直接使用 Obsidian 常用 LaTeX 写法：行内公式写作 `$...$`，块级公式写作 `$$...$$`。
- 不需要在源文本中手动改成 mdBook 的 MathJax 分隔符。构建时，`scripts/build_from_texts.py` 会把 Obsidian LaTeX 写法转换成 mdBook 可识别的形式。
- 脚本也会适配 Obsidian 图片嵌入语法，例如 `![[texts/s8-le-transfert/original/assets/image5.jpeg|268]]`，构建时会转换为 mdBook 可以渲染的图片引用。
- 阅读笔记放在 `texts/<seminar>/notes/`。译文中可以用 `[[notes/材料文件名|显示标题]]` 引入笔记，笔记中可以用 `[[s8-01-0001|显示标题]]` 精确链接到对应译文段落；构建后 mdBook 页面会转换为普通 HTML 链接，并在对应译文段落旁显示相关阅读笔记。
- 代码块和行内代码中的内容不会被当作 LaTeX 或图片语法转换。

编辑译文时请注意 `id` 和 `ids` 的关系：

```markdown
<!-- id: s8-06-0058 -->
<!-- ids: s8-06-0058 s8-06-0059 -->

这里写 0058 和 0059 合并后的译文。
```

`<!-- id: ... -->` 表示一个译文块的开始；`<!-- ids: ... -->` 表示这个译文块实际对应的原文分段列表。使用 `ids` 时，它必须紧跟在当前块的 `id` 后面，并且列表中应包含当前 `id`。不要把 `ids` 写在上一段译文之后当作“下一段声明”，否则构建脚本会把它解析成上一段的对齐规则。

## 当前内容翻译进度

- `texts/s8-le-transfert`：研讨班 VIII，*Le transfert*（更新中）。
- `texts/s17-l-envers-de-la-psychanalyse`：研讨班 XVII，*L'envers de la psychanalyse*（待校订）。
- `texts/s19b-le-savoir-du-psychanalyste`：研讨班 XIXb，*Le savoir du psychanalyste*（待校订）。

## 许可证

[![License: CC-BY 4.0](https://img.shields.io/badge/License-CC--BY%204.0-slategray?logo=creativecommons&logoColor=white)](./LICENSE)

本项目贡献者自行创作的中文译文、译注、术语表、导读、校订说明、读书笔记、项目文档，以及用于整理、构建和发布的脚本、模板、自动化配置，采用 [CC-BY 4.0](./LICENSE) 许可证。适用范围和版权说明见 [NOTICE.md](./NOTICE.md)。

完整说明：

- [署名 4.0 协议国际版 CC BY 4.0 Deed](https://creativecommons.org/licenses/by/4.0/deed.zh-hans)
- [Attribution 4.0 International CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.en)

## 版权声明

本项目可能包含或引用原始法文文本、原文图片、扫描整理结果以及其他第三方材料。上述材料不因收录、引用、对照展示或构建发布而自动纳入本项目的 CC BY 4.0 授权范围。

本项目整理和对照使用的法语原文主要来自互联网上公开可访问资料，包括 Staferla（[http://staferla.free.fr/](http://staferla.free.fr/)）。

这些材料的权利状态以其来源、权利人声明和适用法律为准。本项目不对其版权归属、授权状态或可复用性作法律判断，也不改变其自身的版权状态。
