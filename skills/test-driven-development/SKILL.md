---
name: test-driven-development
description: "TDD技能，编码阶段自动激活，强制RED→GREEN→REFACTOR循环：先写失败测试→写最小实现→重构。当用户要实现新功能、修bug或写代码时使用。"
version: "1.0.0"
phase: implementation
mandatory: true
ironLaw: "YOU MUST WRITE THE TEST FIRST. CODE WRITTEN BEFORE ITS TEST WILL BE DELETED. THE CYCLE IS RED→GREEN→REFACTOR, IN THAT ORDER, NO EXCEPTIONS."
redFlags:
  - "这个逻辑太简单了，不需要测试"
  - "先写代码再补测试也一样"
  - "测试太费时间，先让功能跑起来"
  - "重构不是必须的，代码已经够好了"
  - "这个是 UI/配置/脚本，不需要 TDD"
metadata:
  crabpaw:
    emoji: 🔴🟢♻️
    category: engineering
    capabilities: [code_review]
    triggers:
      - implementation_start
      - code_writing
      - feature_development
---

# Test-Driven Development Skill

强制 RED→GREEN→REFACTOR 循环。先写测试，再写实现，最后重构。

## IRON LAW

**YOU MUST WRITE THE TEST FIRST.** 在测试之前写的代码将被删除。循环顺序是 RED→GREEN→REFACTOR，没有例外。

## 红旗警告

| 借口 | 为什么无效 |
|------|-----------|
| "这个逻辑太简单了，不需要测试" | 简单的逻辑更容易有边界错误，测试成本也最低 |
| "先写代码再补测试也一样" | 后补的测试倾向于验证实现而非规格，失去设计反馈 |
| "测试太费时间，先让功能跑起来" | 没有测试的"跑起来"只是看起来跑起来，隐藏的 bug 代价更高 |
| "重构不是必须的，代码已经够好了" | GREEN 阶段的代码是"让它通过"的代码，几乎总是需要重构 |
| "这个是 UI/配置/脚本，不需要 TDD" | 任何可验证的行为都可以 TDD，包括快照测试和集成测试 |

---

## 阶段1: RED — 写失败测试

1. **理解规格**: 从计划文档中提取当前任务的验收标准
2. **写测试**: 编写一个会失败的测试，描述期望行为
3. **运行测试**: 确认测试失败（RED），且失败原因正确
4. **失败信息审查**: 确认失败信息清晰描述了期望 vs 实际

### RED 检查点

- [ ] 测试描述了期望行为而非实现细节
- [ ] 测试失败，且失败原因正确
- [ ] 失败信息可读且有意义

---

## 阶段2: GREEN — 写最小实现

1. **最小实现**: 写刚好让测试通过的代码，不多不少
2. **运行测试**: 确认测试通过（GREEN）
3. **不做过度设计**: 不要预判未来需求，不要添加"以防万一"的代码

### GREEN 检查点

- [ ] 测试通过
- [ ] 实现是最小的（没有多余逻辑）
- [ ] 没有预判未来需求的代码

---

## 阶段3: REFACTOR — 重构

1. **识别坏味道**: 重复代码、过长函数、不清晰的命名
2. **小步重构**: 每次只做一个重构，运行测试确认不破坏
3. **消除重复**: 提取共享逻辑，保持 DRY
4. **改善命名**: 让代码自解释

### REFACTOR 检查点

- [ ] 所有测试仍然通过
- [ ] 没有重复代码
- [ ] 命名清晰自解释
- [ ] 函数长度合理（< 20 行）

---

## 循环

完成一个 RED→GREEN→REFACTOR 循环后，回到 RED 写下一个测试，直到所有验收标准都被覆盖。
