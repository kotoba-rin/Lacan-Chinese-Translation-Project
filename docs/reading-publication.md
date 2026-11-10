# 阅读分支发布

`main` 保存完整编辑原稿；`reading` 保存从指定 `main` 提交自动生成的阅读版。阅读版移除建言，保留原文、译文正文、段下注释、分段 ID、公式、图片引用及知识卡链接。WordPress 文库从 GitHub 的 `reading` 分支获取内容。

每次向 GitHub 推送 `main` 后，`Publish reading branch` 工作流测试处理规则并更新 `reading`；也可手动运行工作流。发布读取 Git 中已经提交的版本，不读取工作区修改或未跟踪的笔记。它不会切换当前分支，也不改动当前暂存区。

本地可先导出到空目录检查：

```bash
python3 scripts/publish_reading_branch.py export \
  --source-root . --source-revision main --output-dir /tmp/lctp-reading-review
```

更新本地 `reading` 并推送到指定远程：

```bash
python3 scripts/publish_reading_branch.py publish \
  --source-root . --source-revision main \
  --target-branch reading --remote github --push
```

省略 `--push` 时只生成本地分支；`--remote` 用于读取并保留远程已有的分支历史。生成的提交以既有 `reading` 和原稿提交为父提交，通过正常快进推送发布，不重写旧分支历史。`reading` 已被某个工作区检出时，脚本拒绝改写该工作区的分支指针。

阅读版根目录的 `.reading-source.json` 记录原稿提交、处理协议及统计。验证时会从原稿重新计算整个阅读版树，拒绝丢失、额外或被篡改的文件：

```bash
python3 scripts/publish_reading_branch.py check --source-root . --revision reading
```

服务端验证使用可信的本地脚本，不执行从阅读分支下载的代码。读取浅克隆时至少获取两层历史，以保留阅读版提交的原稿父提交。

正文中的“建言”一词、代码示例和公式不会按字面关键词删除。译文课次沿用项目对旧式引文块的分类：以“注”“译注”“原文注”“出版说明”开头的块保留，其他旧式块作为建言移除；显式 `> <!-- 建言 -->` 块移除。其他 Markdown 的普通引文保留，只移除明确标记的建言。已核对为正文引文的 `s8-19-0093`、`s8-27-0007` 继续保留；若这些段落后来出现显式建言标记，发布停止，等待重新核查边界。
