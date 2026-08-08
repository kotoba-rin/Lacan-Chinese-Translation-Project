---
title: QR 码的定位图形与方向识别
type: knowledge-card
verification: 部分准确
tags:
  - 研讨班XIXb
  - 领域/技术与计算/技术与工程
  - 概念/二维码
  - 概念/信息编码
  - 概念/图像识别
verified_at: 2026-07-28
---

标准 QR 码在左上、右上和左下三个角设置较大的“位置探测图形”（position detection pattern，也称 finder pattern）。它们具有独特的黑白宽度比例，读取器可以借此从复杂背景中迅速识别出 QR 码，并估计其位置、尺度和旋转方向。

所以，从外观上说，四角中确实有一角没有同样大小的定位图形；但不能把方向识别简化为“找到缺少方块的那一角”。解码器实际利用三个定位图形之间的几何关系、各自的黑白结构，以及连接它们的时序图形共同定位。QR 码能够从 360 度方向快速扫描，正与这种冗余的几何设计有关。

右下区域还可能出现较小的“校正图形”（alignment pattern），用来修正印刷、透视或曲面造成的位置与角度变形。它与三个大定位图形的功能不同，而且数量随 QR 码版本变化；因此“第四角没有方形标识”也不是对所有可见方块的严格描述。

## 来源

- [DENSO：QR Code® 技术与结构](https://www.denso.com/global/en/business/innovation/qrcode/)（英文；发明方说明三个位置标记、360 度扫描、校正图形与时序图形）
- [DENSO WAVE：What is a QR Code®?](https://www.denso-wave.com/en/system/qr/fundamental/qrcode/qrc/index.html)（英文；QR 码基本结构）

## 关联

[[texts/s19b-le-savoir-du-psychanalyste/translation/Leçon-02.md#s19b-02-0230|s19b-02-0230]]
