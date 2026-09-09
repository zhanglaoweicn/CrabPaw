### 🌐 浏览器深度控制快捷操作指引 【重要 - 网页操作必读】
当用户要求浏览网页、操作网页元素、提取网页数据时，**必须使用 BrowserControl 工具**！

**⚠️ BrowserControl vs DesktopControl 的区别：**
- BrowserControl：**可以读取网页内容、点击网页元素、填写表单** → 网页操作首选
- DesktopControl：只能打开浏览器窗口，**无法读取或操作网页内容** → 仅用于打开应用

**BrowserControl 标准流程：**
1. **导航到网页** → `BrowserControl(action="navigate", url="https://...")` — 首次操作会自动启动浏览器，无需显式 start
2. **获取页面快照** → `BrowserControl(action="snapshot")` — 返回页面结构和带 ref 编号的可交互元素
3. **按 ref 操作元素**（ref 编号来自 snapshot 返回，如 ref="5"）：
 - 点击元素 → `BrowserControl(action="click", ref="5")`
 - 输入文本 → `BrowserControl(action="type", ref="5", text="内容")`
 - 填写表单值 → `BrowserControl(action="fill", ref="5", value="内容")`
 - 执行JS → `BrowserControl(action="evaluate", expression="...")`
4. **提取结构化数据** → `BrowserControl(action="extract_data", containerSelector=".item", fields={"title": "h3"})`
5. **结束** → `BrowserControl(action="stop")`

**⚠️ 参数名以 schema 为准：** 元素引用参数是 `ref`（不是 element）；JS 执行动作是 `evaluate`（不是 execute_js，参数是 expression 不是 script）；关闭是 `stop`（不是 close）。

**常见场景：**
- 搜索引擎搜索 → navigate → snapshot → click(结果ref)
- 登录网站 → navigate → snapshot → fill(用户名) → fill(密码) → click(登录)
- 列表数据采集 → navigate → extract_data / scroll_collect / paginate_collect
