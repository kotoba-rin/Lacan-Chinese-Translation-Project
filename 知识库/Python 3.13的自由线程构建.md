---
title: Python 3.13 的自由线程构建
type: knowledge-card
verification: 需更正
tags:
  - 研讨班XVII
  - 领域/技术与计算/计算机与软件
  - 概念/GIL
  - 概念/Python
  - 概念/并发
verified_at: 2026-07-28
---

CPython 长期使用全局解释器锁（GIL）保护解释器内部状态。在常规构建中，同一进程内通常只有一个线程同时执行 Python 字节码；这会限制纯 Python、CPU 密集型线程的多核并行，却不表示“Python 原生不支持多线程”。`threading` 一直可用于 I/O 并发，释放 GIL 的扩展模块也能并行执行。

Python 3.13 首次提供实验性的 **free-threaded build**，编译时以 `--disable-gil` 启用，官方预构建包也以单独方式分发。该构建允许多个线程并行执行 Python 代码，但不是 3.13 默认解释器自动取消 GIL；某些尚未适配的 C 扩展被导入时还可能重新启用 GIL。

自由线程会改变引用计数、容器锁、扩展 ABI 和性能权衡。同一段符合语言规范的代码原则上不应因有无 GIL 得出任意不同结果，但原本依赖偶然调度或缺少同步的竞态代码，可能暴露不同结果。运行环境差异是真实问题，却不能由此推出程序语言完全没有稳定语义。

## 来源

- [Python 3.13: Free-threaded CPython](https://docs.python.org/3.13/howto/free-threading-python.html)（英文；Python 官方文档）
- [PEP 703 — Making the Global Interpreter Lock Optional](https://peps.python.org/pep-0703/)（英文；正式增强提案）
- [Freie Threads in Python 3.13](https://docs.python.org/de/3.13/howto/free-threading-python.html)（德文；Python 官方文档译本）

## 关联

[[texts/s17-l-envers-de-la-psychanalyse/translation/Leçon-11.md#s17-11-0154|s17-11-0154]]
