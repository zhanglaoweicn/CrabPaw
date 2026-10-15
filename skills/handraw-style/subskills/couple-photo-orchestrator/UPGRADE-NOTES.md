# Upgrade Notes — 2.24.24

本版重点解决 8 宫格真人人脸逐格漂移。

- 新增总 Identity Lock。
- 每一个 Panel 单独重新从合法身份参考恢复人脸。
- 禁止 Panel A 的生成脸成为 Panel B 的隐式身份来源。
- 锁定关键脸部几何与年龄辨识度。
- 新增 Face Readability Gate，重点处理全身、远景、背身回望与倒影镜头。
- 原图依旧只锁脸，不锁发型。
