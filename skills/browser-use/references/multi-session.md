# 多会话参考

使用 `--session NAME` 同时运行多个独立浏览器。每个会话有自己的浏览器实例、Cookie 和状态。

## 基本用法

```bash
# 会话 A: 研究竞品
browser-use --session research open https://competitor.com
browser-use --session research state
browser-use --session research screenshot research.png

# 会话 B: 同时测试自己的网站
browser-use --session testing open https://myapp.local
browser-use --session testing input 3 "test@example.com"

# 两个会话独立运行，互不干扰
```

## 会话管理

```bash
browser-use sessions                     # 列出所有活动会话
browser-use close --session research     # 关闭指定会话
browser-use close --all                  # 关闭所有会话
```

## 典型场景

### 1. 多账号并行操作

```bash
browser-use --session admin open https://app.com
browser-use --session admin input 1 "admin@app.com"

browser-use --session user open https://app.com
browser-use --session user input 1 "user@app.com"

# 同时以两个身份操作
```

### 2. 对比测试

```bash
browser-use --session prod open https://production.example.com
browser-use --session staging open https://staging.example.com

# 在两个环境间切换对比
browser-use --session prod screenshot prod.png
browser-use --session staging screenshot staging.png
```

### 3. 数据采集 + 处理分离

```bash
browser-use --session scraper open https://data-source.com
browser-use --session scraper eval "JSON.stringify([...document.querySelectorAll('.item')].map(e => e.textContent))"

browser-use --session dashboard open https://dashboard.local
browser-use --session dashboard eval "localStorage.setItem('data', '...')"
```

## 注意事项

- 每个会话消耗一个浏览器进程（约 100-200MB 内存）
- 默认会话名为 "default"，不指定 `--session` 时使用默认
- 会话名称区分大小写
- 关闭 CrabPaw 时所有会话自动清理
