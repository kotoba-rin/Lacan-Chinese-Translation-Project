# 第八期电子书导出

`scripts/export_ebook.py` 从当前 `texts/s8-le-transfert/translation/` 生成独立中文阅读版 PDF 和 EPUB，不改写原文、译文、知识卡、`build/` 或 `book/`。

内容范围：27课中文译文、正文图示、段下注释，以及原有知识卡反向关联。移除建言、`notes/` 独立阅读笔记及其链接；不附入法文全文、术语表或知识卡全文。知识卡使用在线版绝对链接，需联网打开；正文、图示及 SVG 公式可离线阅读。

## 使用

需要 Python 3、Pandoc、Node.js、Poppler（`pdftoppm`）和 WeasyPrint 的本地 Pango 依赖。Python 包可以放在隔离目录，不影响网站构建环境：

```sh
python3 -m pip install --target .cache/ebooks/python weasyprint lxml Pillow
npm install --prefix .cache/ebooks --no-audit --no-fund mathjax-full
mkdir -p .cache/ebooks/fonts
curl -fL 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf' -o .cache/ebooks/fonts/NotoSansSC-wght.ttf
curl -fL 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt' -o .cache/ebooks/fonts/OFL.txt
python3 scripts/export_ebook.py
```

macOS 默认读取 `/opt/homebrew/lib` 下的动态库。PDF 正文优先使用本机宋体；页眉、标题、知识卡链接使用 Noto Sans SC，构建时生成静态 TrueType 子集并嵌入。`EBOOK_SANS_FONT` 可指定原始 Noto Sans SC TrueType 文件。其他系统需提供静态 TrueType 格式的正文字体。EPUB 使用阅读器字体，不打包系统字体。可用 `EBOOK_NODE_MODULES` 指向已有 MathJax 依赖目录。

曾用的苹方 CFF 子集在 Poppler 中正常，却在 macOS CoreGraphics 中出现页眉错字和标题数字重叠。现在导出会检查所有 PDF 字体必须使用静态 TrueType 嵌入，防止静默退回不兼容字体；代表页面应同时使用 Poppler 和 CoreGraphics 检查。字体格式验证不能替代渲染检查。

输出位于 `output/ebooks/s8-le-transfert/`。`--output-dir` 可改目录，`--epub-only` 可只导出 EPUB。`.cache/ebooks/s8-staging/` 是可重建的中间目录。

## 内容校验

复用网站构建器的分段、合并 ID、注释与建言分类，逐课核对原文 ID 覆盖，不允许缺段、重复 ID 或未译块。现有规则把下面两段正文误归为建言，因此电子书作局部保留：

- `s8-19-0093`：法文也以引用块排版；从十字架形象谈到信仰价值以外的突破，是原文正文。
- `s8-27-0007`：对应法文 `à contestation sinon à discordance.`，是正文的句子续段。

这两个例外仅用于电子书，不修改网页分类。如段落后来出现显式建言标记，导出会停止以要求复查。

注释保留原文标号和段落位置。图片只收集保留内容实际引用的本地资源；图像最长边限制为2000像素。TeX 在构建时转为 SVG；普通转义方括号不当作公式。EPUB 输出检查所有内链、图片、XML、分段 ID、注释数量与知识卡链接数量。PDF 还需检查渲染页面、字体、目录、分页、链接和公式。

`制作清单.json` 记录逐段注释哈希、关联卡链接、源文件哈希、分段覆盖及文件哈希，用于追溯版本。输出不是自动更新的版本，需重新运行导出。

本命令只创建本地电子书，不执行 Git 推送或网站发布。
