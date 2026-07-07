## 修改内容

- 研讨班：
- 课次：
- 类型：译文 / 注释 / 术语 / 图片 / 结构

## 校订说明

请说明关键修改理由，尤其是涉及术语、句法判断、版本差异或大段重译的地方。

## 检查清单

- [ ] 每一节仍对应一个 Markdown 文件。
- [ ] 新增图片已放在对应研讨班目录的 `assets/` 下，并使用相对路径引用。
- [ ] 涉及术语统一时，已更新对应研讨班的 `glossary.md`。
- [ ] 涉及目录结构时，`python3 scripts/build_from_texts.py` 可正常生成 `build/`。
- [ ] `python3 scripts/build_from_texts.py && mdbook clean && mdbook build` 或 GitHub Actions 构建通过。
