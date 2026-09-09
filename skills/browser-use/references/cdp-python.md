# CDP 原生控制与 Python 会话参考

CLI 命令处理大多数浏览器交互。当需要 CLI 未暴露的浏览器级控制时（激活标签页、拦截网络请求、设备模拟、直接操作 Chrome Target ID），使用 `browser-use python` 与原始 CDP 交互。

## Python 会话工作原理

`browser-use python "statement"` 每次调用执行一条 Python 语句。变量跨调用持久化 — 在一次调用中设置值，下次调用中使用。

预注入的 `browser` 对象包含常用操作的同步包装器（`browser.goto()`、`browser.click()` 等）。超出这些范围的操作，通过两个内部接口获取完全访问：

- `browser._run(coroutine)` — 同步运行任何异步协程（60 秒超时）
- `browser._session` — 原始 `BrowserSession`，包含完整 CDP 客户端访问

## 获取 CDP 客户端

```bash
browser-use python "cdp = browser._run(browser._session.get_or_create_cdp_session())"
```

之后 `cdp` 跨调用持久化。使用 `cdp.cdp_client.send.<Domain>.<method>()` 调用任何 CDP 命令，`cdp.session_id` 作为会话参数。

## 常用操作

### 激活标签页（让用户看到）

CLI 的 `tab switch` 只改变代理的内部焦点，Chrome 的可见标签页不会切换。要让用户看到特定标签页：

```bash
browser-use python "targets = browser._session.session_manager.get_all_page_targets()"
browser-use python "print([(i, t.url) for i, t in enumerate(targets)])"
browser-use python "cdp = browser._run(browser._session.get_or_create_cdp_session(target_id=None, focus=False))"
browser-use python "browser._run(cdp.cdp_client.send.Target.activateTarget(params={'targetId': targets[1].target_id}))"
```

### 列出所有标签页及 Target ID

```bash
browser-use python "targets = browser._session.session_manager.get_all_page_targets()"
browser-use python "
for i, t in enumerate(targets):
    print(f'{i}: {t.target_id[:12]}... {t.url}')
"
```

### 执行 JavaScript 并获取结果

```bash
browser-use python "cdp = browser._run(browser._session.get_or_create_cdp_session())"
browser-use python "result = browser._run(cdp.cdp_client.send.Runtime.evaluate(params={'expression': 'document.title', 'returnByValue': True}, session_id=cdp.session_id))"
browser-use python "print(result['result']['value'])"
```

### 模拟移动设备

```bash
browser-use python "cdp = browser._run(browser._session.get_or_create_cdp_session())"
browser-use python "browser._run(cdp.cdp_client.send.Emulation.setDeviceMetricsOverride(params={'width': 375, 'height': 812, 'deviceScaleFactor': 3, 'mobile': True}, session_id=cdp.session_id))"
```

### 通过 CDP 获取 Cookie

```bash
browser-use python "cdp = browser._run(browser._session.get_or_create_cdp_session())"
browser-use python "cookies = browser._run(cdp.cdp_client.send.Network.getCookies(params={}, session_id=cdp.session_id))"
browser-use python "print(cookies)"
```

## 提示

- 每次 `browser-use python` 调用是一条语句。多行字符串可用于 `for` 循环和 `if` 块，但不能混合语句和表达式。使用多次调用。
- 变量持久化：一次调用中设置 `cdp = ...`，下次调用中使用 `cdp`。
- `browser._run()` 桥接有 60 秒超时。长时间操作需增加超时或直接使用异步内部接口。
- 所有 CDP 域通过 `cdp.cdp_client.send.<Domain>.<method>()` 可用。完整 API 见 [Chrome DevTools Protocol 文档](https://chromedevtools.github.io/devtools-protocol/)。
