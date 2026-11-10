---
title: Subversion与Git：集中式、分布式和托管平台
type: knowledge-card
verification: 部分准确
tags:
  - 研讨班XIXb
  - 领域/技术与计算/计算机与软件
  - 领域/技术与计算/技术与工程
  - 概念/版本控制
verified_at: 2026-07-28
---

Apache Subversion 通常简称 SVN，是 2000 年启动的开源、集中式版本控制系统。集中式模型以服务器上的中央版本库为权威历史；使用者检出工作副本，再把修改提交回该版本库。Subversion 最初旨在改进 CVS，在目录版本化、原子提交和历史管理等方面提供更一致的模型。

Git 是分布式版本控制系统。一次完整的克隆通常包含项目文件、提交历史和分支信息；开发者能够在本地创建提交、浏览历史和建立分支，再与一个或多个远程版本库交换对象。团队仍可约定某个远程仓库为协作中心，但这属于工作流选择，不改变 Git 的分布式数据模型。

GitHub 和 GitLab 不是与 SVN 同一层级的版本控制系统：两者都是以 Git 仓库为基础的托管与协作平台，并在其上提供议题、合并或拉取请求、代码审查、持续集成等功能。因此，严格的对比应是“SVN 与 Git”，而不是“SVN 与 GitHub/GitLab”。集中式和分布式各有权限控制、离线工作、仓库规模与运维方式上的取舍；“较旧”本身不能推出某一工具在所有场景中都已失效。

普通词 *subversion* 在法语和英语中表示对既有秩序的颠覆、推翻或扰乱，源于晚期拉丁语 *subversio*。软件名称 Subversion 借用了同一拼写，但产品架构是集中式的；名称的政治或修辞含义与其版本控制模型不可混为一谈。

## 来源

- [Apache Subversion](https://subversion.apache.org/)（英文；项目官网及集中式模型说明）
- [*Gestion de versions avec Subversion*](https://svnbook.red-bean.com/fr/1.8/svn-book.pdf)（法文；Subversion 官方参考书法译本）
- [Git：About Version Control](https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control)（英文；Git 官方参考书）
- [GitHub Docs：About Git](https://docs.github.com/en/get-started/using-git/about-git)（英文；Git 与 GitHub 的层级区别）
- [GitLab Docs：Use Git](https://docs.gitlab.com/topics/git/)（英文；Git 与 GitLab 的层级区别）
- [CNRTL：subversion](https://www.cnrtl.fr/etymologie/subversion)（法文；词源和早期义项）

## 关联

[[texts/s19b-le-savoir-du-psychanalyste/translation/Leçon-01.md#s19b-01-0174|s19b-01-0174]]
