# couple-photo-orchestrator 2.24.24

本版新增 **Identity Lock v2**，用于降低多轮与八宫格生成中的真人脸漂移。

核心原则：真人原图/显式提升后的 active identity reference 负责脸部身份；每一格都重新从身份参考恢复脸，而不是从上一格生成脸继续迭代。

同时保留既有规则：原图只锁脸，不锁发型；正式发型执行 Editorial `hairstyle_design`。
