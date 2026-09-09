---
name: api-tester
version: 1.0.0
description: "API接口测试技能，支持REST/GraphQL/gRPC接口调试，自动生成测试用例、性能压测、Mock数据。当用户需要测试或调试后端接口、排查接口报错、生成接口测试用例时使用。"
metadata:
  crabpaw:
    emoji: "🧪"
    category: development
    capabilities: [code_review]
    triggers: [api, api_test, rest, graphql, grpc, http, endpoint, curl]
    platforms: [linux, macos, windows]
---

# 🧪 API测试

## 概述

专业的API接口测试工具，帮助快速验证接口功能和性能。

## 核心能力

| 能力 | 说明 |
|------|------|
| **请求构造** | 支持GET/POST/PUT/DELETE/PATCH，自定义Header/Body |
| **断言验证** | 状态码、响应体结构、字段类型、值范围 |
| **自动化测试** | 根据OpenAPI/Swagger文档自动生成测试用例 |
| **性能压测** | 并发请求、响应时间统计、吞吐量分析 |
| **Mock服务** | 根据接口定义自动生成Mock数据 |
| **环境管理** | 多环境变量切换（dev/staging/prod） |

## 支持的协议

- REST API (JSON/XML)
- GraphQL
- gRPC（需proto文件）
- WebSocket

## 使用方式

/api test <endpoint> --method POST
/api test --swagger <url>
/api perf <endpoint> --concurrency 100 --duration 30s
/api mock --schema <schema-file>

## 认证支持

- Bearer Token / API Key / Basic Auth / OAuth 2.0
- 自定义Header
