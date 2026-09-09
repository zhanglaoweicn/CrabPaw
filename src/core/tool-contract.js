/**
 * Tool Contract System —— JSON Schema 工具契约定义 + Ajv 验证
 *
 * 职责：
 * 1. 为每个工具定义输入参数的 JSON Schema
 * 2. 编译 Ajv 验证函数
 * 3. 提供 getToolContract / validateToolInput / registerToolContract API
 */

const AjvModule = require('ajv');
const Ajv = AjvModule.default || AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });

const TOOL_CONTRACTS = {};

TOOL_CONTRACTS.Read = {
  description: "Read file contents",
  whenNotToUse: ["Don't use to check file existence", "Don't use to search content", "Don't use to write files"],
  // 2026-09-07 实机修复: 补 path/filePath 别名(三选一必填)——handler 三兼容但契约
  // 曾强制 file_path, 模型实机必传 path("分析+HTML"轮保底轮 Read 被拒烧掉最后一轮)。
  // 同 Write 契约的对齐模式(L25-26)。
  schema: { type: "object", properties: { file_path: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 }, filePath: { type: "string", minLength: 1 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } }, anyOf: [{ required: ["file_path"] }, { required: ["path"] }, { required: ["filePath"] }], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.Write = {
  description: "Write content to file",
  whenNotToUse: ["Don't use to read files", "Don't use for small modifications"],
  // 2026-08-04: 对齐 registry——补 path 别名,required 改为 [content](file_path/path 二选一)
  schema: { type: "object", properties: { file_path: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 }, content: { type: "string" } }, required: ["content"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.Edit = {
  description: "Edit file with precise replacement",
  whenNotToUse: ["Don't use to create new files", "Don't use for full rewrites"],
  // 2026-08-04: 对齐 registry——补 fuzzy 参数
  schema: { type: "object", properties: { file_path: { type: "string", minLength: 1 }, old_string: { type: "string" }, new_string: { type: "string" }, fuzzy: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.Bash = {
  description: "Execute shell commands",
  whenNotToUse: ["Don't use for math", "Don't use for file read", "Don't use for file write"],
  schema: { type: "object", properties: { command: { type: "string", minLength: 1 }, workdir: { type: "string" }, timeout: { type: "integer", minimum: 1000, maximum: 300000 } }, required: ["command"], additionalProperties: false },
  maxTimeout: 300000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.WebSearch = {
  description: "Search the web",
  whenNotToUse: ["Don't use for local code search", "Don't use for file search"],
  // 2026-08-03: 补 num 参数——LLM 常带 num=10 被契约拒（'should NOT have
  // additional properties'）→ 搜索工具被拒 → 用户查询无结果
  schema: { type: "object", properties: { query: { type: "string", minLength: 1 }, num: { type: "number", description: "返回结果数量（默认 5）" } }, required: ["query"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.WebFetch = {
  description: "Fetch web page content",
  whenNotToUse: ["Don't use for local files", "Don't use for API calls when SDK available"],
  schema: { type: "object", properties: { url: { type: "string", minLength: 1 } }, required: ["url"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.LS = {
  description: "List directory contents",
  whenNotToUse: ["Don't use for content search", "Don't use to read files"],
  // 2026-08-04: 对齐 registry——参数为 path/ignore,无必填(默认当前目录)
  schema: { type: "object", properties: { path: { type: "string", minLength: 1 }, ignore: { type: "array", items: { type: "string" } } }, required: [], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.Glob = {
  description: "Search files by glob pattern",
  whenNotToUse: ["Don't use for content search", "Don't use to read files"],
  // 2026-08-04: 对齐 registry——参数为 pattern/path
  schema: { type: "object", properties: { pattern: { type: "string", minLength: 1 }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.Grep = {
  description: "Search file content (grep)",
  whenNotToUse: ["Don't use to list files", "Don't use to read file content"],
  // 2026-08-04: 对齐 registry——参数为 pattern/path/glob/output_mode/-i/-n/-C
  schema: { type: "object", properties: { pattern: { type: "string", minLength: 1 }, path: { type: "string" }, glob: { type: "string" }, output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] }, "-i": { type: "boolean" }, "-n": { type: "boolean" }, "-C": { type: "integer" } }, required: ["pattern"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.TodoWrite = {
  description: "Create and manage todos",
  whenNotToUse: ["Don't use for chat history"],
  // 2026-08-04: 对齐 registry——todos 数组 + mode(replace/merge),required 仅 todos
  schema: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] }, priority: { type: "string", enum: ["high", "medium", "low"] } }, required: ["content", "status"] } }, mode: { type: "string", enum: ["replace", "merge"] } }, required: ["todos"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.TodoRead = {
  description: "Read todo list",
  whenNotToUse: ["Don't use to create tasks"],
  schema: { type: "object", properties: { status_filter: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MarkdownToExcel = {
  description: "Convert Markdown file to Excel (.xlsx) format",
  whenNotToUse: ["Don't use for non-Markdown input"],
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, output_path: { type: "string" }, title: { type: "string" }, colorScheme: { type: "string", enum: ["corporate", "green", "blue", "red", "purple", "dark"] } }, required: ["input_path"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MarkdownToPPT = {
  description: "Convert Markdown file to PowerPoint (.pptx) format",
  whenNotToUse: ["Don't use for non-Markdown input"],
  // 2026-08-23 别名兼容（deepseek 实机传 markdownContent 文本被拒）: anyOf 二选一,与 registry file-tools.js required:[] + markdownContent 对齐
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, markdownContent: { type: "string" }, output_path: { type: "string" }, title: { type: "string" }, style: { type: "string", enum: ["business_blue", "academic_white", "creative_purple", "tech_dark", "minimal_gray"] } }, anyOf: [{ required: ["input_path"] }, { required: ["markdownContent"] }], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MarkdownToPDF = {
  description: "Convert Markdown file to PDF format",
  whenNotToUse: ["Don't use for non-Markdown input"],
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, output_path: { type: "string" }, title: { type: "string" }, style: { type: "string", enum: ["商务报告", "中国公文", "学术论文", "简约现代"] }, author: { type: "string" } }, required: ["input_path"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MarkdownToHTML = {
  description: "Convert Markdown file to standalone HTML format",
  whenNotToUse: ["Don't use for non-Markdown input"],
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, output_path: { type: "string" }, title: { type: "string" }, style: { type: "string", enum: ["商务报告", "技术文档", "博客文章", "落地页", "简约暗色"] } }, required: ["input_path"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ImageEdit = {
  description: "Edit images — resize, crop, rotate, flip, format conversion, blur, sharpen, brightness/contrast/saturation, grayscale, watermark",
  whenNotToUse: ["Don't use for image generation", "Don't use for OCR"],
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, output_path: { type: "string" }, resize: { type: "object" }, crop: { type: "object" }, rotate: { anyOf: [{ type: "number" }, { type: "object", properties: { angle: { type: "number" }, background: { type: "string" } } }], description: "旋转角度(度数)或 {angle, background} 对象" }, flip: { type: "boolean" }, format: { type: "string", enum: ["png","jpeg","webp","avif","tiff","gif"] }, quality: { type: "number" }, blur: { type: "number" }, brightness: { type: "number" }, contrast: { type: "number" }, saturation: { type: "number" }, grayscale: { type: "boolean" }, watermark_text: { anyOf: [{ type: "string" }, { type: "object", properties: { text: { type: "string" }, size: { type: "number" }, color: { type: "string" } } }], description: "文字水印: 字符串或 { text, size, color } 对象" }, watermark_image: { type: "string" } }, required: ["input_path"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.VideoEdit = {
  description: "Edit video files — screenshots, trim, convert format, resize, rotate, mute, metadata. Requires ffmpeg.",
  whenNotToUse: ["Don't use for video generation"],
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, output_path: { type: "string" }, screenshot: { type: "object" }, trim: { type: "object" }, format: { type: "string", enum: ["mp4","webm","gif","mov","avi","mkv"] }, fps: { type: "number" }, resize: { type: "object" }, rotate: { type: "number", enum: [90,180,270] }, mute: { type: "boolean" }, info: { type: "boolean" } }, required: ["input_path"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.RemoveReminder = {
  description: "Remove a scheduled reminder",
  whenNotToUse: ["Don't use to list reminders"],
  schema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DeleteFile = {
  description: "Delete a file",
  whenNotToUse: ["Don't use for directories"],
  // 2026-08-04: 对齐 registry——参数为 file_paths 数组
  schema: { type: "object", properties: { file_paths: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["file_paths"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.CreateDirectory = {
  description: "Create directory",
  whenNotToUse: ["Don't use for file creation"],
  // 2026-08-04: 对齐 registry——参数为 path
  schema: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.WebExtract = {
  description: "Extract structured web content",
  whenNotToUse: ["Don't use for simple fetching"],
  schema: { type: "object", properties: { url: { type: "string", minLength: 1 }, urls: { type: "array", items: { type: "string" }, description: "多个URL列表(兼容)" }, format: { type: "string" } }, anyOf: [{ required: ["url"] }, { required: ["urls"] }], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
// 2026-09-06 契约单源化: schema 由 ./browser-control/schema 提供, 与 registry(browser-tools.js)同源。
// 此前静态子集缺 maxChars/value/direction 等十余参数, 依赖 ai.js 启动期 registerIntoRegistry
// 合并兜底——任何不经全量工具加载的校验方(测试/独立脚本)都会被 additionalProperties:false 误拒。
const { buildContractSchema: _buildBrowserContractSchema } = require('./browser-control/schema');
TOOL_CONTRACTS.BrowserControl = {
  description: "Browser automation control — supports snapshot/click/navigate/extract/scroll/paginate + CDP native click (click_at_cdp) + raw CDP commands (raw_cdp) + screenshot with coordinates (screenshot_with_coords)",
  whenNotToUse: ["Don't use for simple fetching", "Don't use for API calls"],
  schema: _buildBrowserContractSchema(),
  maxTimeout: 120000, riskLevel: "high", validate: null
};
// 2026-09-06 契约单源化: schema 由 ./desktop/schema 提供, 与 registry(desktop-tools.js)同源。
// 此前静态契约只有 6 参数, 孤立校验方被 additionalProperties:false 误拒(mouse_click(x,y) 等),
// 依赖 ai.js 启动期 registerIntoRegistry 合并兜底(与 BrowserControl 修复前同款问题)。
const { buildContractSchema: _buildDesktopContractSchema } = require('./desktop/schema');
TOOL_CONTRACTS.DesktopControl = {
  description: "Desktop application control — open apps, control windows, keyboard/mouse, screenshots, clipboard, system info",
  whenNotToUse: ["Don't use for file ops", "Don't use for commands"],
  schema: _buildDesktopContractSchema(),
  maxTimeout: 60000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.ImageAnalyze = {
  description: "Analyze images via vision models",
  whenNotToUse: ["Don't use for OCR", "Don't use for generation"],
  schema: { type: "object", properties: { image_path: { type: "string", minLength: 1 }, query: { type: "string" }, model: { type: "string" } }, required: ["image_path"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.ImageOCR = {
  description: "OCR text from images",
  whenNotToUse: ["Don't use for image analysis"],
  schema: { type: "object", properties: { image_path: { type: "string", minLength: 1 }, language: { type: "string" } }, required: ["image_path"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ImageGenerate = {
  description: "Generate images via AI",
  whenNotToUse: ["Don't use for analysis", "Don't use for video"],
  schema: { type: "object", properties: { prompt: { type: "string", minLength: 1 }, model: { type: "string" }, size: { type: "string" }, quality: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 4 } }, required: ["prompt"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.VideoGenerate = {
  description: "Generate videos via AI",
  whenNotToUse: ["Don't use for images"],
  schema: { type: "object", properties: { prompt: { type: "string", minLength: 1 }, model: { type: "string" }, duration: { type: "integer" }, resolution: { type: "string" } }, required: ["prompt"], additionalProperties: false },
  maxTimeout: 300000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.RemotionRender = {
  description: "Render a Remotion composition (React code) into an MP4 video — code-driven video generation",
  whenNotToUse: ["AI 创意实拍画面生成时用 VideoGenerate", "只是播放已有视频时用 SceneMedia", "合成物未在 src/compositions/index.tsx 登记时（先写组件并登记）"],
  schema: { type: "object", properties: { composition: { type: "string", minLength: 1 }, props: { type: "object" }, output_name: { type: "string" }, title: { type: "string" }, codec: { type: "string", enum: ["h264", "h265", "vp8", "vp9", "gif"] }, wait_seconds: { type: "integer", minimum: 5, maximum: 840 }, project_dir: { type: "string" }, concurrency: { type: "integer", minimum: 1 }, scale: { type: "number" } }, required: ["composition"], additionalProperties: false },
  maxTimeout: 900000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.RemotionStatus = {
  description: "Check Remotion render task status",
  whenNotToUse: ["渲染已同步完成时（RemotionRender 直接返回结果）"],
  schema: { type: "object", properties: { task_id: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.HyperFramesRender = {
  description: "Render a HyperFrames composition (HTML with timing attributes) into a video — template/block-style video generation",
  whenNotToUse: ["AI 创意实拍画面生成时用 VideoGenerate", "React 代码级精确控制用 RemotionRender", "合成物 HTML 不存在时（先创建）"],
  schema: { type: "object", properties: { composition: { type: "string", minLength: 1 }, props: { type: "object" }, output_name: { type: "string" }, title: { type: "string" }, format: { type: "string", enum: ["mp4", "webm", "gif"] }, fps: { type: "number" }, wait_seconds: { type: "integer", minimum: 5, maximum: 840 }, project_dir: { type: "string" } }, required: ["composition"], additionalProperties: false },
  maxTimeout: 900000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.HyperFramesStatus = {
  description: "Check HyperFrames render task status",
  whenNotToUse: ["渲染已同步完成时（HyperFramesRender 直接返回结果）"],
  schema: { type: "object", properties: { task_id: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.HyperFramesStageAsset = {
  description: "Stage an uploaded media file into the HyperFrames workspace assets/ folder",
  whenNotToUse: ["文件已在项目 assets/ 内时"],
  schema: { type: "object", properties: { file_path: { type: "string", minLength: 1 }, name: { type: "string" } }, required: ["file_path"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.HyperFramesTranscribe = {
  description: "Transcribe video/audio to word-level transcript.json (local whisper) or import .srt/.vtt/.json",
  whenNotToUse: ["whisper-cpp 未安装且无现成转写稿时", "不需要时间轴的纯文本总结"],
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, model: { type: "string" }, output_name: { type: "string" }, wait_seconds: { type: "integer", minimum: 5, maximum: 840 } }, required: ["input_path"], additionalProperties: false },
  maxTimeout: 900000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.SkillView = {
  description: "View skill details",
  whenNotToUse: ["Don't use to list all skills — use SkillsList instead", "Don't use to guess skill content — always load via SkillView before executing"],
  // 2026-09-07: name/skill_name 双别名——registry schema 用 name 而契约只认
  // skill_name, 模型两种写法各有一半概率被拒(宣传片实测 {name} 被契约拒)。
  // required 放空, 由 handler 校验二选一。
  schema: { type: "object", properties: { skill_name: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SkillsList = {
  description: "List available skills",
  whenNotToUse: ["Don't use to view individual skill details — use SkillView", "Don't call repeatedly in a loop — cache the result"],
  schema: { type: "object", properties: { category: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
// 2026-08-26: SkillExecute——执行器技能执行入口(注册表 skill-tools.js)。
// 仅对有 executor 的技能使用; 知识型技能走 SKILL.md 知识注入而非 execute。
TOOL_CONTRACTS.SkillExecute = {
  description: "Execute an executor-backed skill (chart-generator/excel-xlsx/deep-research etc)",
  whenNotToUse: ["Don't use for knowledge-only skills (no executor) — let the model apply SKILL.md directly", "Don't use to list skills — use SkillsList"],
  schema: { type: "object", properties: { skill: { type: "string", minLength: 1 }, input: { type: "string" } }, required: ["skill"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SkillManage = {
  description: "Manage skills",
  whenNotToUse: ["Don't use to view skills"],
  schema: { type: "object", properties: { action: { type: "string", minLength: 1 }, name: { type: "string" }, description: { type: "string" }, file_path: { type: "string" } }, required: ["action"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "medium", validate: null
};
// 2026-08-18 清理重复契约: SkillGenerate 曾在本文两处定义(L206/L382),
// 同键定义两次、后者静默覆盖前者(L382 处 description/required/maxTimeout 为准,
// 与 skill-generate-tool.js 注册表一致)。已删除先赋值的旧块, 保留后者。
// 2026-08-15 修复: 契约与注册表(clarify-tool.js)对齐——options 实为 array,
// 且注册表还有 context 字段。此前契约写 string 且缺 context,LLM 每次合法调用
// 都被拒("/ should be string")→ 连续失败触发熔断,连带拉黑 ShowHotspot/ShowWeather/
// StockQuery 等全部面板工具(面板打不开的直接根因)。
TOOL_CONTRACTS.Clarify = {
  description: "Clarify user requests",
  whenNotToUse: ["Don't use for simple confirmations"],
  schema: { type: "object", properties: { question: { type: "string", minLength: 1 }, options: { type: "array", items: { type: "string" } }, context: { type: "string" } }, required: ["question"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.PlanExit = {
  description: "Exit plan mode",
  whenNotToUse: ["Don't use for normal tool calls"],
  schema: { type: "object", properties: { reason: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
// 2026-08-01: Weather 契约已删除（旧版工具停用，统一 ShowWeather）
// 2026-08-18 清理重复契约: MusicSearch 曾在本文两处定义(L229/L487),
// 同键定义两次、后者静默覆盖前者。已删除先赋值的旧块, 保留后者。
TOOL_CONTRACTS.MediaStage = {
  description: "Control the media stage panel. Image opens from the left, video opens from the right, and music opens a record-player card from the right.",
  whenNotToUse: ["Don't use for general web search", "Don't use for file management"],
  schema: { type: "object", properties: {
    mode: { type: "string", enum: ["video", "camera", "image", "music"], description: "video=right-side video mode; camera=right-side camera video; image=left-side image mode; music=right-side record-player mode." },
    action: { type: "string", enum: ["show", "hide", "close", "play", "pause", "seek", "set_volume", "update"], description: "show loads media; hide/close closes and destroys it; play/pause controls playback; seek jumps; set_volume adjusts volume." },
    url: { type: "string", description: "Media URL for video/image. Must be a complete accessible URL." },
    src: { type: "string", description: "Audio file path for music mode. Use file:///absolute/path for local files or an HTTP direct audio link." },
    title: { type: "string", description: "Optional media title." },
    artist: { type: "string", description: "Optional artist name for music mode." },
    lrc: { type: "string", description: "Optional LRC-format lyrics for music mode." },
    cover: { type: "string", description: "Optional cover image path or URL for music mode." },
    alt: { type: "string", description: "Optional image alt description." },
    autoplay: { type: "boolean", description: "Autoplay, default true." },
    muted: { type: "boolean", description: "Mute video, default false." },
    volume: { type: "number", description: "Volume 0-1." },
    currentTime: { type: "number", description: "Seconds to seek to." },
    camera: { type: "boolean", description: "Explicitly open camera when mode=video; default false." },
  }, required: ["mode"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.StockQuery = {
  // 2026-08-17: 参数单源化对齐——registry 工具 schema 是 query 必需。契约此前写
  // symbol 必需 + additionalProperties:false：模型按工具 schema 传 {"query":...} 被拒
  // (实机 11:31:21 "should have required property 'symbol'")；传 {"symbol":...} 过校验但
  // handleStockQuery 不读 symbol → 返回"请提供股票名称或代码" → 用户看到"无法查询股票"。
  // 自动对齐(registerIntoRegistry)只补属性不修 required，故此处手写与工具一致。
  // 2026-08-17: 补 stocks 别名——实机(20:08:42) deepseek-v4-flash 传 {"stocks":"贵州茅台"}
  // 被拒("should NOT have additional properties; should have required property 'query'")，
  // 模型重试 query 才成功。与工具 schema 双端同步；required 改为 query/stocks 任选其一
  // （registerIntoRegistry 自动对齐只补属性不修 required，此处手写）。
  // 2026-08-21: 补 symbols/queries/stock 别名——实机(10:49:22-58) 模型传 {"symbols":"688836"}/
  // {"queries":"宇树科技"} 被拒 4 次；11:13:13 传 {"stock":"宇树科技"} 又被拒。
  // 与工具 schema anyOf 双端同步（单源化约束：required/anyOf 必须完全相同）。
  description: "Query stock data",
  whenNotToUse: [],
  schema: { type: "object", properties: { query: { type: "string", minLength: 1 }, stocks: { type: "string", minLength: 1 }, symbols: { type: "string", minLength: 1 }, queries: { type: "string", minLength: 1 }, stock: { type: "string", minLength: 1 } }, required: [], anyOf: [{ required: ["query"] }, { required: ["stocks"] }, { required: ["symbols"] }, { required: ["queries"] }, { required: ["stock"] }], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.EnterpriseQuery = {
  description: "Query enterprise info",
  whenNotToUse: [],
  schema: { type: "object", properties: { query: { type: "string", minLength: 1 }, source: { type: "string" }, action: { type: "string" } }, required: ["query"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.TextToSpeech = {
  description: "Convert text to speech",
  whenNotToUse: [],
  schema: { type: "object", properties: { text: { type: "string", minLength: 1 }, voice: { type: "string" }, speed: { type: "number", minimum: 0.5, maximum: 2.0 } }, required: ["text"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MarkdownToWord = {
  description: "Convert Markdown file to Word (.docx)",
  whenNotToUse: [],
  schema: { type: "object", properties: { input_path: { type: "string", minLength: 1 }, output_path: { type: "string" }, title: { type: "string" }, style: { type: "string", enum: ["商务报告", "中国公文", "学术论文", "简约现代"] }, author: { type: "string" }, send_to_wecom: { type: "boolean" }, wecom_user_id: { type: "string" } }, required: ["input_path"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.LarkSendText = {
  description: "Send text via Lark",
  whenNotToUse: [],
  schema: { type: "object", properties: { content: { type: "string", minLength: 1 }, chat_id: { type: "string" } }, required: ["content"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.WeComSendText = {
  description: "Send text via WeCom",
  whenNotToUse: [],
  schema: { type: "object", properties: { content: { type: "string", minLength: 1 }, chat_id: { type: "string" } }, required: ["content"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "medium", validate: null
};

// Lightweight contracts
const LWC = (desc, extra = {}) => ({ description: desc, whenNotToUse: extra.whenNotToUse || [], schema: extra.schema || { type: "object", properties: {}, required: [], additionalProperties: false }, maxTimeout: extra.maxTimeout || 30000, riskLevel: extra.riskLevel || "low", validate: extra.validate || null });
TOOL_CONTRACTS.ListVoices = LWC("List TTS voices", { schema: { type: "object", properties: { voice: { type: "string" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.LarkSendCard = LWC("Send card via Lark", { schema: { type: "object", properties: { content: { type: "string" }, card: { type: "object" }, chat_id: { type: "string" } }, required: ["content"], additionalProperties: false } });
TOOL_CONTRACTS.LarkCreateBitableRecord = LWC("Create Lark Bitable record", { schema: { type: "object", properties: { app_token: { type: "string" }, table_id: { type: "string" }, fields: { type: "object" } }, required: ["app_token", "table_id", "fields"], additionalProperties: false } });
TOOL_CONTRACTS.LarkCreateCalendarEvent = LWC("Create Lark calendar event", { schema: { type: "object", properties: { summary: { type: "string" }, start_time: { type: "string" }, end_time: { type: "string" }, description: { type: "string" } }, required: ["summary", "start_time"], additionalProperties: false } });
TOOL_CONTRACTS.LarkCreateDocument = LWC("Create Lark document", { schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, folder_token: { type: "string" } }, required: ["title", "content"], additionalProperties: false } });
TOOL_CONTRACTS.LarkCreateTask = LWC("Create Lark task", { schema: { type: "object", properties: { summary: { type: "string" }, description: { type: "string" }, due: { type: "string" } }, required: ["summary"], additionalProperties: false } });
TOOL_CONTRACTS.LarkQueryBitable = LWC("Query Lark Bitable", { schema: { type: "object", properties: { app_token: { type: "string" }, table_id: { type: "string" }, filter: { type: "object" }, page_size: { type: "integer" } }, required: ["app_token", "table_id"], additionalProperties: false } });
TOOL_CONTRACTS.LarkQueryCalendarEvents = LWC("Query Lark calendar events", { schema: { type: "object", properties: { start_time: { type: "string" }, end_time: { type: "string" }, page_size: { type: "integer" } }, required: ["start_time", "end_time"], additionalProperties: false } });
TOOL_CONTRACTS.LarkQueryWiki = LWC("Query Lark wiki", { schema: { type: "object", properties: { query: { type: "string" }, space_id: { type: "string" }, page_size: { type: "integer" } }, required: ["query"], additionalProperties: false } });
TOOL_CONTRACTS.WeComSendCard = LWC("Send card via WeCom", { schema: { type: "object", properties: { content: { type: "string" }, card: { type: "object" }, chat_id: { type: "string" } }, required: ["content"], additionalProperties: false } });
TOOL_CONTRACTS.WeComSendMarkdown = LWC("Send markdown via WeCom", { schema: { type: "object", properties: { content: { type: "string" }, chat_id: { type: "string" } }, required: ["content"], additionalProperties: false } });
TOOL_CONTRACTS.WeComCreateChat = LWC("Create WeCom chat", { schema: { type: "object", properties: { name: { type: "string" }, users: { type: "array", items: { type: "string" } }, owner: { type: "string" } }, required: ["name", "users"], additionalProperties: false } });
TOOL_CONTRACTS.WeComQueryApproval = LWC("Query WeCom approvals", { schema: { type: "object", properties: { sp_no: { type: "string" }, start_time: { type: "integer" }, end_time: { type: "integer" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.WeComQueryCalendar = LWC("Query WeCom calendar", { schema: { type: "object", properties: { start_time: { type: "integer" }, end_time: { type: "integer" } }, required: ["start_time", "end_time"], additionalProperties: false } });
TOOL_CONTRACTS.WeComQueryContacts = LWC("Query WeCom contacts", { schema: { type: "object", properties: { department_id: { type: "string" }, fetch_child: { type: "boolean" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.WeComSubmitApproval = LWC("Submit WeCom approval", { schema: { type: "object", properties: { creator_userid: { type: "string" }, template_id: { type: "string" }, approver: { type: "array" }, apply_data: { type: "array" }, summary: { type: "string" }, notifyer: { type: "array" }, use_template_approver: { type: "boolean" } }, required: ["creator_userid", "template_id"], additionalProperties: false } });
TOOL_CONTRACTS.WeComExternalContactList = LWC("List WeCom external contacts", { schema: { type: "object", properties: { userid: { type: "string" } }, required: ["userid"], additionalProperties: false } });
TOOL_CONTRACTS.WeComExternalContactGet = LWC("Get WeCom external contact detail", { schema: { type: "object", properties: { external_userid: { type: "string" } }, required: ["external_userid"], additionalProperties: false } });
TOOL_CONTRACTS.WeComExternalContactGroupChatList = LWC("List WeCom group chats", { schema: { type: "object", properties: { status_filter: { type: "integer" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.WeComCreateMeeting = LWC("Create WeCom meeting", { schema: { type: "object", properties: { topic: { type: "string" }, start_time: { type: "integer" }, end_time: { type: "integer" }, participants: { type: "array" }, meeting_type: { type: "integer" }, password: { type: "string" }, description: { type: "string" }, location: { type: "string" }, remind_time: { type: "integer" } }, required: ["topic", "start_time", "end_time"], additionalProperties: false } });
TOOL_CONTRACTS.WeComGetMeetingInfo = LWC("Get WeCom meeting info", { schema: { type: "object", properties: { meeting_id: { type: "string" } }, required: ["meeting_id"], additionalProperties: false } });
// 2026-08-22: 四个文档工具契约加 filePath 别名——2026-08-20 统一为 path 后，
// 实机("转成 HTML", 2026-08-21) deepseek-v4-flash 仍按旧惯传 {"filePath":...} 被
// additionalProperties:false 拒绝 → DocRead×N 失败 → 兜底 Bash+python 中文路径乱码
// 超时。与 ShowStock query/symbols、CreateCalendarEvent summary/start_time 同型，
// anyOf 放行 path 或 filePath 任一（handler 双兼容 params.path ?? params.filePath）。
TOOL_CONTRACTS.DocRead = LWC("Read document", { schema: { type: "object", properties: { path: { type: "string" }, filePath: { type: "string", description: "兼容别名(同 path)" }, format: { type: "string" } }, anyOf: [{ required: ["path"] }, { required: ["filePath"] }], additionalProperties: false } });
TOOL_CONTRACTS.DocToMarkdown = LWC("Convert document to markdown", { schema: { type: "object", properties: { path: { type: "string" }, filePath: { type: "string", description: "兼容别名(同 path)" }, output_path: { type: "string" } }, anyOf: [{ required: ["path"] }, { required: ["filePath"] }], additionalProperties: false } });
TOOL_CONTRACTS.PdfExtract = LWC("Extract PDF content", { schema: { type: "object", properties: { path: { type: "string" }, filePath: { type: "string", description: "兼容别名(同 path)" }, pages: { type: "string" }, extractTables: { type: "boolean" }, extractFields: { type: "boolean" } }, anyOf: [{ required: ["path"] }, { required: ["filePath"] }], additionalProperties: false } });
TOOL_CONTRACTS.XlsxQuery = LWC("Query XLSX spreadsheet", { schema: { type: "object", properties: { path: { type: "string" }, filePath: { type: "string", description: "兼容别名(同 path)" }, sheet: { type: "string" }, query: { type: "string" }, filter: { type: "string" }, columns: { type: "string" }, limit: { type: "number" } }, anyOf: [{ required: ["path"] }, { required: ["filePath"] }], additionalProperties: false } });
TOOL_CONTRACTS.EmailList = LWC("List emails", { schema: { type: "object", properties: { folder: { type: "string" }, limit: { type: "integer" }, unread: { type: "boolean" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.EmailRead = LWC("Read email", { schema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"], additionalProperties: false } });
TOOL_CONTRACTS.EmailSearch = LWC("Search emails", { schema: { type: "object", properties: { query: { type: "string" }, folder: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false } });
TOOL_CONTRACTS.EmailSend = LWC("Send email", { schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" } }, required: ["to", "subject", "body"], additionalProperties: false } });
// 2026-08-19 修复: 契约此前是 LarkCreateCalendarEvent 的复制品(required summary/start_time),
// 与 registry(src/tools/calendar-tool.js {title,datetime,description,duration}) 脱节——
// 模型按 registry 传 {title,datetime} 恒被拒 → 3 次循环 → DSML 兜底。自动对齐只补属性
// 不修 required, 故此处手写与工具一致; anyOf 四组合放行旧式 summary/start_time 别名
// (DSML/缓存上下文), 由 handler 归一化。详见 memory: schedule-card-round-2026-08-19
TOOL_CONTRACTS.CreateCalendarEvent = LWC("Create calendar event", { schema: { type: "object", properties: { title: { type: "string" }, datetime: { type: "string" }, description: { type: "string" }, duration: { type: "number" }, reminders: { type: "array", items: { type: "object", properties: { value: { type: "number", description: "提前分钟数" } }, required: ["value"], additionalProperties: false }, description: "提前提醒(分钟), 缺省提前10分钟, 空数组=不提醒" }, summary: { type: "string", description: "兼容别名(同 title)" }, start_time: { type: "string", description: "兼容别名(同 datetime)" } }, anyOf: [{ required: ["title", "datetime"] }, { required: ["title", "start_time"] }, { required: ["summary", "datetime"] }, { required: ["summary", "start_time"] }], additionalProperties: false } });
TOOL_CONTRACTS.Taskflow = LWC("Execute task workflow", { schema: { type: "object", properties: { workflow: { type: "string" }, params: { type: "object" } }, required: ["workflow"], additionalProperties: false } });
TOOL_CONTRACTS.Todo = LWC("Legacy todo alias", { schema: { type: "object", properties: { action: { type: "string" }, content: { type: "string" }, todos: { type: "array", description: "任务列表(与 TodoWrite 一致)——模型常误传 todos 数组给 todo" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.SendWecomFile = LWC("Send file via WeCom", { schema: { type: "object", properties: { file_path: { type: "string" }, user_id: { type: "string" }, chat_id: { type: "string" } }, required: ["file_path"], additionalProperties: false } });
// 2026-09-08: 海报生成双工具（方案见 docs/海报生成能力方案.md——双层渲染：AI 底图+HTML 确定性排版）
TOOL_CONTRACTS.PosterGenerate = LWC("Generate a marketing poster (product promo / festival / customer greeting) with AI background + deterministic text layout; product photos are composited as-is", {
  whenNotToUse: ["不要用于普通文章配图（改用 ImageGenerate）", "不要用于需要 AI 重绘产品本体的场景（产品保真红线）"],
  schema: { type: "object", properties: { template_id: { type: "string", enum: ["product", "festival", "greeting"] }, aspect: { type: "string", enum: ["1:1", "9:16", "16:9", "3:4", "4:3"] }, title: { type: "string", minLength: 1 }, subtitle: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, price: { type: "string" }, cta: { type: "string" }, bg_prompt: { type: "string" }, bg_image_path: { type: "string" }, variants: { type: "array", items: { type: "string", enum: ["1:1", "9:16", "16:9", "3:4", "4:3"] } }, product_image_path: { type: "string" }, brand: { type: "object", properties: { companyName: { type: "string" }, slogan: { type: "string" }, phone: { type: "string" }, address: { type: "string" }, accent: { type: "string" } }, additionalProperties: false } }, required: ["title"], additionalProperties: false },
  maxTimeout: 300000, riskLevel: "low"
});
TOOL_CONTRACTS.PosterBrandKit = LWC("Read/write the brand kit (company name, slogan, contact info, brand color) applied to all generated posters", {
  whenNotToUse: ["不要用它生成海报（用 PosterGenerate）"],
  schema: { type: "object", properties: { action: { type: "string", enum: ["get", "set"] }, companyName: { type: "string" }, slogan: { type: "string" }, phone: { type: "string" }, address: { type: "string" }, wechat: { type: "string" }, accent: { type: "string" } }, required: ["action"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "low"
});
TOOL_CONTRACTS.SendLarkFile = LWC("Send local file to Lark (upload via im/v1/files then send). Word/PDF/Excel/images/media up to 30MB. receive_id optional — falls back to configured larkUserId or the most recent Lark sender.", { schema: { type: "object", properties: { file_path: { type: "string", description: "要发送的文件的绝对路径" }, receive_id: { type: "string", description: "飞书接收者 open_id（可选；缺省自动推断）" } }, required: ["file_path"], additionalProperties: false } });
TOOL_CONTRACTS.HotSearch = LWC("Search trending topics", { schema: { type: "object", properties: { platform: { type: "string" }, limit: { type: "integer" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.PlatformKeysStatus = LWC("Check API key status", { schema: { type: "object", properties: { platform: { type: "string" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.WechatMpDraft = LWC("Create WeChat MP draft", { schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, digest: { type: "string" } }, required: ["title", "content"], additionalProperties: false } });
TOOL_CONTRACTS.WechatMpPublish = LWC("Publish WeChat MP article", { schema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"], additionalProperties: false } });
TOOL_CONTRACTS.SetReminder = LWC("Set reminder", { schema: { type: "object", properties: { text: { type: "string" }, time: { type: "string" } }, required: ["text", "time"], additionalProperties: false } });
TOOL_CONTRACTS.ListReminders = LWC("List reminders", { schema: { type: "object", properties: { limit: { type: "integer" }, status: { type: "string" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.DeleteReminder = LWC("Delete reminder", { schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
TOOL_CONTRACTS.ImageInfo = LWC("Get image metadata", { schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } });
TOOL_CONTRACTS.ShowCommodityQuery = LWC('ShowCommodityQuery', {
  description: '商品查询面板：浏览器导航至电商搜索（京东/淘宝/拼多多等免登录源优先），截图后由多模态视觉模型提取商品列表（名称/价格/销量/店铺）并在卡片表格化展示缩略图与排序。用于"查商品/比价"类请求。浏览器不可用时如实告知。',
  schema: { type: 'object', properties: { query: { type: 'string', minLength: 1, description: '商品关键词' }, source: { type: 'string', description: '数据源名称(可选)' }, action: { type: 'string', enum: ['show', 'hide'], default: 'show' } }, required: ['query'], additionalProperties: false },
  whenNotToUse: ['非商品查询', '用户仅闲聊时不查询'],
  riskLevel: 'low',
  maxTimeout: 60000,
});
TOOL_CONTRACTS.ShowBusinessReport = LWC('ShowBusinessReport', {
  description: '展示经营日报面板：导入的经营数据表清单/行数/角色（营收/库存/应收），用于"经营日报/经营情况/上个月经营"类请求。数据来自已导入的 CSV/Excel 报表（自动建表+NL2SQL 查询）。无数据时如实提示请先导入。会以可视面板形式展示。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示经营日报(默认)，hide=关闭面板', default: 'show' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['非经营数据场景（股票/台风等用各自面板）'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ShowReceivablePanel = LWC('ShowReceivablePanel', {
  description: '展示应收账款卡：逾期应收总额/笔数/按客户聚合的逾期明细（金额降序），用于"应收账款/回款/谁欠我钱"类请求。数据来自导入的经营报表（语义视图优先，自动回退）。无逾期时如实说明。会以可视卡片形式展示。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['非应收/回款场景（经营总览用 ShowBusinessReport 或 ShowBusinessBriefingPanel）', '库存/合同场景用各自卡片'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ShowContractExpiryPanel = LWC('ShowContractExpiryPanel', {
  description: '展示合同到期卡：指定窗口期内到期的合同列表（到期日升序/客户/金额/剩余天数），用于"合同到期/续约提醒"类请求。数据来自导入的经营报表（语义视图优先，自动回退）。会以可视卡片形式展示。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' }, windowDays: { type: 'number', description: '到期窗口天数（默认 30）' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['非合同场景（应收/经营总览用各自卡片）'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ShowBusinessBriefingPanel = LWC('ShowBusinessBriefingPanel', {
  description: '展示经营简报卡：本月/上月/昨日营收 + 环比 + 应收逾期与合同临期风险摘要，用于"经营简报/今天经营怎么样/营收概况"类请求。数据来自导入的经营报表（语义视图优先，自动回退）。会以可视卡片形式展示。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['查看数据表清单用 ShowBusinessReport', '单笔明细查询用 DatabaseQuery/NL2SQL'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ShowApprovalsPanel = LWC('ShowApprovalsPanel', {
  description: '展示审批待办卡：当前待审批事项列表（流程/事项说明/创建时间）。用户点卡片上的批准/驳回按钮后，意图会在下一轮进入你的上下文，此时用 ResolveApproval 工具落地。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['非审批场景'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ResolveApproval = LWC('ResolveApproval', {
  description: '落地一个审批决定（批准/驳回）。审批待办卡上的用户点击会以意图进入对话上下文，你据此调用本工具；approvalId 必须来自 ShowApprovalsPanel 列出的待办，不要凭空编造。',
  schema: { type: 'object', properties: { approvalId: { type: 'string', description: '审批单 ID（来自审批待办卡/ShowApprovalsPanel）' }, approved: { type: 'boolean', description: 'true=批准，false=驳回' }, result: { type: 'string', description: '审批备注（可选）' } }, required: ['approvalId', 'approved'], additionalProperties: false },
  whenNotToUse: ['approvalId 不在待审批列表中时', '用户未明确表达批准/驳回意愿时（先确认）'],
  riskLevel: 'medium',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ShowStockAlertPanel = LWC('ShowStockAlertPanel', {
  description: '展示库存预警卡：当前库存低于安全库存的商品列表（缺口降序，含当前量/安全线/缺口）。要求导入的库存表含"安全库存"列。会以可视卡片形式展示。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['非库存场景', '导入表无安全库存列时如实说明并提示补列'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ShowSupplierPanel = LWC('ShowSupplierPanel', {
  description: '展示供应商档案卡：按供应商聚合的采购总额/单数/最近采购日（数据来自导入的采购报表，语义视图优先）；指定 supplier 且 withEnterprise=true 时另发企业工商信息卡（网络查询较慢）；appToken/tableId 提供时附带 Lark Bitable 联系人区块。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' }, supplier: { type: 'string', description: '供应商名称（可选；缺省展示采购汇总榜）' }, withEnterprise: { type: 'boolean', description: '是否联网查该供应商工商信息（较慢，默认 false）' }, appToken: { type: 'string', description: 'Lark Bitable app token（可选，联系人区块）' }, tableId: { type: 'string', description: 'Lark Bitable table id（可选，联系人区块）' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['非供应商/采购场景', '仅查工商信息可直接用 EnterpriseQuery'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.ShowCustomerPanel = LWC('ShowCustomerPanel', {
  description: '展示客户跟进卡（过渡版）：按客户聚合的累计销售额/最近成交日/当前应收，用于"客户情况/客户排名/老客户分析"类请求。数据来自导入的经营报表（语义视图优先）。会以可视卡片形式展示。',
  schema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' } }, required: ['action'], additionalProperties: false },
  whenNotToUse: ['单客户的详细流水查询用 DatabaseQuery/NL2SQL'],
  riskLevel: 'low',
  maxTimeout: 30000,
});
TOOL_CONTRACTS.VisionModelsList = LWC("List vision models", { schema: { type: "object", properties: { provider: { type: "string" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.ImageProvidersList = LWC("List image providers", { schema: { type: "object", properties: {}, required: [], additionalProperties: false } });
TOOL_CONTRACTS.ImageGenStats = LWC("Get image gen stats", { schema: { type: "object", properties: { period: { type: "string" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.VideoGenerateFromImage = LWC("Generate video from images", { schema: { type: "object", properties: { image_path: { type: "string" }, prompt: { type: "string" } }, required: ["image_path"], additionalProperties: false } });
TOOL_CONTRACTS.VideoProvidersList = LWC("List video providers", { schema: { type: "object", properties: { provider: { type: "string" } }, required: [], additionalProperties: false } });
TOOL_CONTRACTS.VideoStats = LWC("Get video stats", { schema: { type: "object", properties: { period: { type: "string" } }, required: [], additionalProperties: false } });
// ── 文档生成工具契约 ─────────────────────────────────────────
TOOL_CONTRACTS.DocxGenerate = {
  description: "Generate Word documents (.docx) from structured content",
  whenNotToUse: ["Don't use for simple text output"],
  schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, output_path: { type: "string" }, template: { type: "string" } }, required: ["content"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
// 2026-08-23 双端漂移修复（deepseek 实机: PptxGenerate 传 colorScheme 被契约拒 ×3 → 模型改走
// MarkdownToPPT 又因 markdownContent 被拒）: 契约 properties 对齐 registry document-tools.js
// （style/colorScheme/outputPath + xlsx sheets 等），required 以 registry 为准。
// 生成类内容工具: 不放 additionalProperties: false——deepseek 参数名自由发挥
// （实机已见 colorScheme/coverTemplate/tableData/columns 等）每次不同, 收紧只会
// 连环拒（PptxGenerate 拒 3 次 → 模型改走 MarkdownToPPT 又拒 → 无产物）。内容
// 工具顶层额外字段无害, required 仍是硬约束。
TOOL_CONTRACTS.XlsxGenerate = {
  description: "Generate Excel spreadsheets (.xlsx) from structured data",
  whenNotToUse: ["Don't use for simple text output"],
  // 2026-08-23: anyOf 放行 data 嵌套——deepseek 实机曾传 {"data":{"sheets":[...]}},
  // 旧 required:["sheets"] 拒绝 → 首轮失败再重试(日志实锤 2026-08-22 18:45:47)
  schema: { type: "object", properties: { sheets: {}, data: {}, sheet_name: { type: "string" }, colorScheme: { type: "string", enum: ["corporate", "green", "blue", "red", "purple", "dark"] }, title: { type: "string" }, outputPath: { type: "string" }, output_path: { type: "string" } }, anyOf: [{ required: ["sheets"] }, { required: ["data"] }] },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.PptxGenerate = {
  description: "Generate PowerPoint presentations (.pptx) from structured content",
  whenNotToUse: ["Don't use for simple text output"],
  schema: { type: "object", properties: { title: { type: "string" }, slides: {}, style: { type: "string" }, colorScheme: { type: "string" }, outputPath: { type: "string" }, output_path: { type: "string" }, template: { type: "string" } }, required: ["slides"] },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.PdfGenerate = {
  description: "Generate PDF documents from content",
  whenNotToUse: ["Don't use for simple text output"],
  schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, style: { type: "string" }, author: { type: "string" }, outputPath: { type: "string" }, output_path: { type: "string" } }, required: ["content"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.HtmlGenerate = {
  description: "Generate standalone HTML pages",
  whenNotToUse: ["Don't use for simple text output"],
  schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, output_path: { type: "string" }, css: { type: "string" } }, required: ["content"], additionalProperties: false },
  maxTimeout: 60000, riskLevel: "low", validate: null
};
// ── 文档分析工具契约（2026-08-19，schema 与 registry src/tools/document-analyze-tools.js 双写一致）──
TOOL_CONTRACTS.DocumentAnalyze = {
  description: "Analyze a document (Word/PDF/Excel/text): extract summary, key points, numbers, risks and entities; generate a report card (left reading panel) and save to knowledge base by default",
  whenNotToUse: ["Don't use for simply reading a file — use DocRead", "Don't use for document generation — use DocxGenerate etc.", "Don't use for spreadsheet visualization — use DashboardGenerate"],
  schema: { type: "object", properties: { filePath: { type: "string" }, title: { type: "string" }, focus: { type: "string" }, saveToKnowledgeBase: { type: "boolean" }, maxChars: { type: "number" } }, required: ["filePath"], additionalProperties: false },
  maxTimeout: 180000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DashboardGenerate = {
  description: "Generate an HTML dashboard from a spreadsheet (xlsx/csv): server-side stats aggregation, AI analysis, charts (bar/line/pie) with dark/light themes",
  whenNotToUse: ["Don't use for Word/PDF analysis — use DocumentAnalyze", "Don't use for presentations — use presentation-builder", "Don't use for querying spreadsheet subsets — use XlsxQuery"],
  schema: { type: "object", properties: { filePath: { type: "string" }, title: { type: "string" }, focus: { type: "string" }, saveToKnowledgeBase: { type: "boolean" }, maxRows: { type: "number" } }, required: ["filePath"], additionalProperties: false },
  maxTimeout: 180000, riskLevel: "low", validate: null
};
// ── 知识库检索工具契约（2026-08-20，DeepTutor 精华落地：读取链路闭环；schema 与 registry src/tools/knowledge-tools.js 双写一致）──
TOOL_CONTRACTS.KbSearch = {
  description: "Search the local knowledge base (hybrid retrieval: FTS + vector + entity graph RRF fusion). Contains documents previously analyzed via DocumentAnalyze. Returns snippets with provenance (document/file path). Use to answer questions about previously analyzed documents",
  whenNotToUse: ["Don't use for web search — use WebSearch", "Don't use for local file content search — use Grep", "Don't use just to see which documents exist — use KbList", "When knowledge base is empty, return empty honestly — never fabricate results"],
  schema: { type: "object", properties: { query: { type: "string", minLength: 1 }, limit: { type: "number", minimum: 1, maximum: 10 }, namespace: { type: "string" } }, required: ["query"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.KbList = {
  description: "List knowledge base documents (title/source/updated). For 'what documents exist' and coverage checks before retrieval. Manifest ≠ retrieval evidence: listing only answers 'what exists'; cite content only after KbSearch",
  whenNotToUse: ["Need document content — use KbSearch (manifest has no content)", "Empty knowledge base — return empty list honestly"],
  schema: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 100 }, titleContains: { type: "string" }, namespace: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DecisionTrace = {
  description: "Query the provenance chain of past decisions: by topic keywords or runId, returns the decision record (intent/conclusion/tool digest), evidence edges and cited sources. Use to answer 'how was this decided before / what was this based on'",
  whenNotToUse: ["Don't use for current-turn decisions — trace reads the persisted decision history of previous runs", "Don't use unless the question is about what the assistant previously did/decided (provenance check)", "Don't use for knowledge-base content questions — use KbSearch"],
  schema: { type: "object", properties: { query: { type: "string", minLength: 1 }, runId: { type: "string" } }, required: ["query"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DecisionVerify = {
  description: "Verify integrity of the decision hash chain (SHA-256 chained): returns chainIntegrity/brokenAt/total, detects tampered decision records",
  whenNotToUse: ["Don't use in every conversation — integrity verification is a full-chain scan; use only when audit/tamper suspicion exists"],
  schema: { type: "object", properties: { runId: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SkillGenerate = {
  description: "Generate new skills from natural language description",
  whenNotToUse: ["Don't use for existing skills", "Don't use for simple queries"],
  schema: { type: "object", properties: { description: { type: "string", minLength: 10 }, name: { type: "string" }, category: { type: "string" } }, required: ["description"], additionalProperties: false },
  maxTimeout: 120000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.LarkStreamCard = {
  description: "Feishu streaming card — create, update, finalize an interactive card with real-time progress",
  whenNotToUse: ["Don't use for simple text replies"],
  schema: { type: "object", properties: { action: { type: "string", enum: ["create","update","finalize"] }, receiveId: { type: "string" }, messageId: { type: "string" }, title: { type: "string" }, content: { type: "string" }, status: { type: "string" }, buttonText: { type: "string" }, buttonUrl: { type: "string" } }, required: ["action"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.WeComUpdateCard = {
  description: "Update a previously sent WeCom textcard with new progress/status",
  whenNotToUse: ["Don't use for new conversations without a prior card"],
  schema: { type: "object", properties: { chatId: { type: "string", minLength: 1 }, title: { type: "string" }, description: { type: "string" }, url: { type: "string" }, btntxt: { type: "string" }, statusEmoji: { type: "string" } }, required: ["chatId","title","description"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SpawnSubagent = {
  description: "Delegate a subtask to a specialized sub-agent — planner (task decomposition), researcher (search), code_executor (write/run code), critic (review), summarizer (compress), tools_agent (general tools)",
  whenNotToUse: ["Don't use for simple single-step tasks", "Don't spawn sub-agents that just call one tool"],
  schema: { type: "object", properties: { archetype: { type: "string", enum: ["planner","researcher","code_executor","critic","summarizer","tools_agent","archivist"] }, task: { type: "string", minLength: 10 } }, required: ["archetype","task"], additionalProperties: false },
  maxTimeout: 180000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.ToolEvolution = {
  description: "Runtime tool self-healing — generate contract templates for missing tools and register agent-authored tools at runtime",
  whenNotToUse: ["Don't use for tools that already exist", "Don't use without confirming the tool is truly missing"],
  schema: { type: "object", properties: { action: { type: "string", enum: ["generateTemplate", "registerTool", "listAuthoredTools"] }, name: { type: "string" }, description: { type: "string" }, schema: { type: "object" }, contract: { type: "object" }, sessionId: { type: "string" }, taskDescription: { type: "string" } }, required: ["action"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "low", validate: null
};

// ── 2026-08-01 补充：高价值工具契约（此前 94 个注册工具无契约，校验被跳过）──
TOOL_CONTRACTS.Memory = {
  description: "读写 CrabPaw 的记忆系统 — write 保存新记忆，read/search 搜索，list 查看，stats 统计",
  whenNotToUse: ["Don't use for simple conversation context", "Don't use to search session history — use SessionSearch"],
  schema: { type: "object", properties: {
    action: { type: "string", enum: ["read", "write", "list", "stats"] },
    query: { type: "string" }, content: { type: "string", minLength: 1 }, title: { type: "string" },
    type: { type: "string" }, tags: { type: "array", items: { type: "string" } },
  }, required: ["action"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.MemoryRecall = {
  description: "从记忆库检索相关记忆条目（概念指纹 + 关键词 + 重要性 + 时间四维评分）",
  whenNotToUse: ["Don't use for session history search", "Don't use when memory system unavailable"],
  schema: { type: "object", properties: { query: { type: "string", minLength: 1 }, type: { type: "string" }, tag: { type: "string" }, minImportance: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MemoryExtract = {
  description: "从对话/文本中提取可入记忆的实体与事实，自动分类并估算重要性",
  whenNotToUse: ["Don't use for simple string splitting", "Don't use when no lasting facts present"],
  schema: { type: "object", properties: { text: { type: "string", minLength: 1 }, limit: { type: "integer" } }, required: ["text"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MemoryAudit = {
  description: "审计记忆库健康度 — 重复、冲突、孤岛、覆盖率",
  whenNotToUse: ["Don't use for single memory lookup"],
  schema: { type: "object", properties: { scope: { type: "string" }, limit: { type: "integer" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MemorySummarize = {
  description: "生成人类可读的记忆库摘要报告",
  whenNotToUse: ["Don't use for single memory lookup"],
  schema: { type: "object", properties: { format: { type: "string", enum: ["text", "json"] }, limit: { type: "integer" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShellExec = {
  description: "在持久化 shell 中执行命令（跨调用保留 cwd 与历史）",
  whenNotToUse: ["Don't use for one-off commands — prefer Bash", "Don't use when command is destructive without approval"],
  schema: { type: "object", properties: { command: { type: "string", minLength: 1 }, profile: { type: "string" } }, required: ["command"], additionalProperties: false },
  maxTimeout: 30000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.ShellState = {
  description: "查询持久化 shell 的当前状态（cwd、历史条数、最后退出码）",
  whenNotToUse: ["Don't use to execute commands"],
  schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShellReset = {
  description: "重置持久化 shell 会话（清空 cwd 与历史）",
  whenNotToUse: ["Don't use when shell state is needed"],
  schema: { type: "object", properties: { reason: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 5000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.SceneSet = {
  description: "Set (create or update) a UI surface in the scene — 向用户展示可视化卡片（progress/selfcheck/text 等）；data 传 null 移除该 surface",
  whenNotToUse: ["Don't use for plain text replies", "Don't use when no visual card is needed"],
  // 2026-08-15 对齐 registry(scene-tools.js)——此前契约 required:["kind","data"] 且
  // data 仅 object, 拦截了 scene-tools.js 文档承诺的 "SceneSet(id, null) 移除卡片"
  // 删除语义(实机日志 07:54:33 "关闭股票面板" → SceneSet {id,data:null} 契约三连败之一)。
  schema: { type: "object", properties: { id: { type: "string" }, data: { oneOf: [{ type: "object", properties: { kind: { type: "string" }, data: { type: "object" }, intent: { type: "string", enum: ["ambient", "inform", "confront"] }, focus: { type: "boolean" }, order: { type: "number" } } }, { type: "null" }] } }, required: ["id", "data"], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SceneGet = {
  description: "Get the current scene manifest — 所有 surface 的紧凑概览",
  whenNotToUse: ["Don't use to create surfaces"],
  schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SceneClear = {
  description: "Clear surfaces from the scene",
  whenNotToUse: ["Don't use when surfaces should persist"],
  schema: { type: "object", properties: { id: { type: "string" } }, required: [], additionalProperties: false },
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MusicSearch = {
  description: "搜索并播放音乐",
  whenNotToUse: ["Don't use for general web search", "Don't use for audio generation"],
  schema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ClipboardRead = {
  description: "读取系统剪贴板内容",
  whenNotToUse: ["Don't use to write clipboard"],
  schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ClipboardWrite = {
  description: "写入系统剪贴板",
  whenNotToUse: ["Don't use to read clipboard"],
  schema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false },
  maxTimeout: 5000, riskLevel: "low", validate: null
};

// ── 2026-08-01 批量生成：无契约工具补齐（81 个）─────────────
TOOL_CONTRACTS.ShowWeather = {
  description: "展示指定城市的实时天气和未来5天预报。数据来自 wttr.in（无需 API Key）。使用终端友好的彩色表格格式显示。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"city":{"type":"string","description":"城市名称，支持中文（如\"北京\"）或英文（如\"Shanghai\"）。默认: 北京"},"format":{"type":"string","enum":["terminal","compact"],"description":"输出格式。terminal=彩色表格，compact=单行摘要。默认: terminal","default":"terminal"},"action":{"type":"string","enum":["show","hide"],"description":"show=展示天气面板(默认)，hide=关闭面板","default":"show"}},"required":[],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
// 2026-08-14: 台风追踪面板契约（ShowTyphoon 工具）
TOOL_CONTRACTS.ShowTyphoon = {
  description: "展示台风追踪面板：台风编号/等级/中心气压/风速、历史路径轨迹地图、7级/10级风圈、登陆点与防御提示。数据来自浙江水利厅台风路径实时发布系统，失败自动降级备源；两源均失败时如实告知用户数据暂不可用（绝不虚构台风数据）。当用户询问台风、台风路径、台风预警时调用。",
  whenNotToUse: ["用户只问普通天气（非台风）时用 ShowWeather"],
  schema: {"type":"object","properties":{"action":{"type":"string","enum":["show","hide"],"description":"show=展示台风面板(默认)，hide=关闭面板","default":"show"}},"required":[],"additionalProperties":false},
  maxTimeout: 25000, riskLevel: "low", validate: null
};
// 2026-08-14: 股票行情面板契约（ShowStock 工具, 基于 StockQuery 数据面）
// 2026-08-15: 补 action=hide 关闭语义——此前无关闭路径, AI 只能试 SceneSet/ControlUI
// (契约均拒, 实机日志 07:54:33-47 三连败 + 工具熔断, "关闭股票面板"无法实现)。
// 2026-08-16: 补 period——registry 有 day/week 枚举而契约表缺失（此前靠
// registerIntoRegistry 启动期自动对齐打补丁），双源同步消除运行时依赖。
TOOL_CONTRACTS.ShowStock = {
  description: "展示股票行情面板：实时行情列表（中文名或代码，逗号分隔多只，默认上证指数）+ 首只股票K线 + 大盘指数。数据来自东方财富公开行情源（四源冗余自动降级）。用户要求关闭股票面板时调用 action=\"hide\"。需要深度多因子分析时用 StockQuery。",
  whenNotToUse: ["用户要求深度多因子分析（动量/风险/宏观/量化评分）时用 StockQuery"],
  // 2026-08-17: 补 query 单数别名——实机(11:31:25)模型传 {"query":"贵州茅台"} 被拒
  // ("should NOT have additional properties")，deepseek-v4-flash 对 queries 参数名跟随差。
  // 与 panel-tools.js 工具 schema + handler 三端同步（双端都要放行 query）。
  // 2026-08-21: 补 symbols 别名——实机(10:49:18) 模型传 {"symbols":"688836"} 被拒
  // ("should NOT have additional properties") → handler 未执行 → 面板不弹。
  // 与 panel-tools.js 工具 schema + handler 三端同步（三端都要放行 symbols）。
  schema: {"type":"object","properties":{"queries":{"type":"string","description":"股票名称或代码，逗号分隔多只，留空默认上证指数"},"query":{"type":"string","description":"股票名称或代码（queries 的单数别名，任选其一）"},"symbols":{"type":"string","description":"股票名称或代码（queries 的复数别名，任选其一）。如\"688836\"或\"宇树科技\""},"period":{"type":"string","enum":["day","week"],"description":"K线周期（day=日K, week=周K, 周K由日线聚合）。默认 day","default":"day"},"action":{"type":"string","enum":["show","hide"],"description":"show=展示股票面板(默认)，hide=关闭面板","default":"show"}},"required":[],"additionalProperties":false},
  maxTimeout: 25000, riskLevel: "low", validate: null
};
// 2026-08-18 清理: HotspotMode 契约随 v1 工具(hotspot_mode)注销而删除——
// v2 ShowHotspot(panels-v2-tool.js)为事实标准, 见 task-6 面板新旧双入口。
TOOL_CONTRACTS.MeetingMode = {
  description: "控制会议录音转写面板的显示、隐藏与历史查看。记录会议 → show（开面板并录音）；「结束记录/会议结束」等停止词 → hide（自动生成纪要）；查看历史纪要 → history（仅打开列表，绝不新建会议）。",
  whenNotToUse: ["用户要求查看历史纪要/历史会议时（用 action=history，show 会新建一场空会议）", "用户只是提到「会议」一词但无记录/查看意图时"],
  schema: {"type":"object","properties":{"action":{"type":"string","enum":["show","open","hide","close","toggle","history"],"description":"show/open 打开会议录音面板并开始录音; hide/close 关闭并停止录音; toggle 切换状态; history 打开历史纪要列表"},"reason":{"type":"string","description":"打开或关闭面板的原因"}},"required":["action"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShowSystemStatus = {
  description: "展示 CrabPaw 系统的实时运行状态，包括：运行时间、内存占用、记忆系统节点数、TTS 引擎状态、已注册工具数、定时任务数等。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"format":{"type":"string","enum":["terminal","compact"],"description":"输出格式。terminal=完整状态，compact=精简摘要。默认: terminal","default":"terminal"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.QueryActivity = {
  description: "查看 AI 的当前活动状态（idle/thinking/tooling/speaking/error）和最近活动历史。帮助用户了解 AI 刚才做了什么、现在在干什么。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"recentCount":{"type":"number","description":"最近活动条数（默认: 10）","default":10}},"required":[],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShowMemoryGraph = {
  description: "展示 CrabPaw 记忆实体关系图谱。显示记忆系统中的节点（实体/话题）和关系连线（关联/包含关系）。支持查看图谱统计摘要。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"format":{"type":"string","enum":["compact","full"],"description":"compact=精简统计，full=节点和关系数据。默认: compact","default":"compact"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
// 2026-08-18 清理: PersonCardMode/WorldcupMode/FocusBanner 契约随 v1 工具
// (person_card_mode/worldcup_mode/focus_banner)注销而删除——
// v2 ShowPersonCard/ShowWorldCup/PushFocusBanner(panels-v2-tool.js)为事实标准。
// 2026-08-19: 业务面板退役——enum 删 open/close_business_panel（专家/数据迁管理舱 data tab）。
TOOL_CONTRACTS.ControlUI = {
  description: '控制 CrabPaw 界面元素(打开/关闭面板、切换 tab、新对话)。当用户明确要求打开/关闭界面时调用,不要在普通问答中主动打开任何界面。',
  whenNotToUse: ['普通问答中不得主动开关界面', '用户未提及界面操作时'],
  schema: {"type":"object","properties":{"command":{"type":"string","enum":["open_cockpit","close_cockpit","open_search","open_doc","open_music","close_music","open_hotspot","close_hotspot","open_weather","close_weather","open_task_panel","close_task_panel","close_scene_card","new_conversation"],"description":"界面操作"},"tab":{"type":"string","description":"面板目标 tab"},"query":{"type":"string","description":"open_search 搜索词"},"reason":{"type":"string"}},"required":["command"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
// 2026-08-18 清理: VoiceRetire 契约随 v1 工具(voice_retire)注销而删除——
// v2 ShowVoiceRetire(panels-v2-tool.js)为事实标准。
TOOL_CONTRACTS.ShowHotspot = {
  description: "展示热点/热搜榜单。支持 weibo/zhihu/baidu/douyin/bilibili 平台。format=text 终端表格，compact 单行摘要，scene 推 UI 卡片。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"platform":{"type":"string","enum":["weibo","zhihu","baidu","douyin","bilibili"],"default":"weibo"},"format":{"type":"string","enum":["text","compact","scene"],"default":"text"},"action":{"type":"string","enum":["show","hide"],"description":"show=展示热点榜单(默认)，hide=关闭热点面板","default":"show"}},"required":[],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShowWorldCup = {
  description: "展示体育赛事面板：赛程/比分/积分榜。sport=football/basketball/tennis/esports。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"sport":{"type":"string","enum":["football","basketball","tennis","esports"],"default":"football"},"format":{"type":"string","enum":["text","scene"],"default":"text"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShowPersonCard = {
  description: "展示人物卡片：基础信息 + 关联记忆 + 联系方式。从记忆系统中查找 name 的所有关联。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"name":{"type":"string","description":"人物姓名（必填）"},"title":{"type":"string"},"role":{"type":"string"},"company":{"type":"string"},"format":{"type":"string","enum":["text","scene"],"default":"text"}},"required":["name"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShowDocPanel = {
  description: "展示文档面板：标题 + 摘要 + 章节。直接传入 docId 和可选的 title/summary/sections。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"docId":{"type":"string"},"title":{"type":"string"},"summary":{"type":"string"},"sections":{"type":"array","items":{"type":"object"}},"author":{"type":"string"},"wordCount":{"type":"number"},"format":{"type":"string","enum":["text","scene"],"default":"text"}},"required":["docId"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.PushFocusBanner = {
  description: "推送焦点横幅（重要通知/告警/进度）。level=info/success/warning/error/alert。ttlMs 后自动消失（0 表示不自动消失）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"level":{"type":"string","enum":["info","success","warning","error","alert"],"default":"info"},"title":{"type":"string"},"message":{"type":"string"},"actions":{"type":"array","items":{"type":"object"}},"ttlMs":{"type":"number","default":0}},"required":["title","message"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.PushTerminalStream = {
  description: "向终端流面板推送一行实时日志（用于工具执行进度、后台任务、调试等）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"line":{"type":"string","description":"日志内容"},"level":{"type":"string","enum":["info","warn","error","debug"],"default":"info"},"stream":{"type":"string","enum":["stdout","stderr","system"],"default":"stdout"}},"required":["line"],"additionalProperties":false},
  maxTimeout: 2000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ShowVoiceRetire = {
  description: "展示语音会话退休总结：时长/回合/ASR/TTS/重连/提示。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"sessionId":{"type":"string"},"duration":{"type":"number"},"turns":{"type":"number"},"asrChars":{"type":"number"},"ttsChars":{"type":"number"},"reconnects":{"type":"number"},"errors":{"type":"number"},"format":{"type":"string","enum":["text","scene"],"default":"text"}},"required":["sessionId"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
// 2026-08-30 Task 11: 主名 PascalCase 化（原 kebab-case 主键是仅有的两个命名违例）。
// kebab 旧名通过 LEGACY_KEBAB_ALIASES 别名兜底——registry 注册名/LLM 调用名不变。
TOOL_CONTRACTS.HtmlPresentation = {
  description: "Generate HTML presentation: 36 themes, 31 layouts, 47 animations, Chart.js.",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"topic":{"type":"string","description":"Presentation topic"},"slides":{"type":"array","description":"Slides array [{type, title, bullets, ...}]"},"style":{"type":"string","description":"Theme name (36 options)"}},"required":["slides"],"additionalProperties":false},
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.PresentationBuilder = {
  description: "Analyze presentation topic, infer style/cover, generate outline, route to pptx_generate or html-presentation. Call this first when user asks to make a presentation.",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"topic":{"type":"string","description":"Presentation topic"},"style":{"type":"string","description":"Color scheme (auto-detected if omitted)"},"slideCount":{"type":"number","description":"Desired slide count (auto-detected)"}},"required":["topic"],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.PlayMusic = {
  description: "播放指定歌曲。可以通过歌曲ID或直接提供播放URL。如果提供ID，会自动获取歌词。",
  whenNotToUse: [],
  // 2026-08-03 修复: 空 properties 导致任何参数被拒（同 Music）
  // 2026-08-06: 补 query/artist/album——模型常传歌名(query)而非 id，此前被
  // additionalProperties:false 拒绝(should NOT have additional properties)，连续失败。
  schema: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, title: { type: "string" }, artist: { type: "string" }, query: { type: "string", description: "歌曲名/歌手搜索词(无 id 时用)" } }, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.MusicControl = {
  description: "控制音乐播放器。支持播放、暂停、下一首、上一首、停止、调整音量、跳转进度。",
  whenNotToUse: [],
  // 2026-08-03 修复: 空 properties 导致任何参数被拒（同 Music）
  schema: { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "next", "prev", "stop", "set_volume", "seek"] }, volume: { type: "number" }, position: { type: "number" } }, required: ["action"], additionalProperties: false },
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.Music = {
  description: "统一的音乐操作工具。通过 action 参数区分操作：search 搜索歌曲、play 播放指定歌曲、stop 停止并关闭面板、pause 暂停/恢复、next 下一首、prev 上一首、set_volume 调节音量、seek 跳转进度。替代 MusicSearch/PlayMusic/MusicControl 三个独立工具。",
  whenNotToUse: [],
  // 2026-08-03 修复: 空 properties + additionalProperties:false → 任何参数被拒
  // （'should NOT have additional properties'）→ Music 工具永远无法调用。
  // 补全与 music-tools.js 注册一致的参数 schema。
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "play", "stop", "pause", "next", "prev", "set_volume", "seek"], description: "操作类型" },
      query: { type: "string", description: "搜索关键词（search 时用）" },
      id: { type: "string", description: "歌曲 ID（play 时用）" },
      title: { type: "string", description: "歌曲名称" },
      url: { type: "string", description: "播放 URL" },
      volume: { type: "number", description: "音量 0-100" },
      position: { type: "number", description: "跳转位置（秒）" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ListKnownAgents = {
  description: "列出本机已安装的其他 Agent CLI（Claude Code / Codex / Gemini / Hermes / Aider），返回每个 agent 的 ID、名称、版本和可用状态。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"forceRescan":{"type":"boolean","description":"强制重新扫描（默认 false 用缓存）","default":false}},"required":[],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GrantAgentDelegation = {
  description: "授权/取消授权 CrabPaw 指挥某个本地 Agent CLI。必须先调用此工具并获得用户明确同意，才能调用 DelegateToAgent。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"agentId":{"type":"string","description":"Agent ID，如 claude_code / codex / gemini / aider / hermes"},"grant":{"type":"boolean","description":"true=授权, false=取消授权","default":true}},"required":["agentId"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.DelegateToAgent = {
  description: "把子任务委托给本机已授权的另一个 Agent CLI 执行。\n典型场景:\n - \"让 Claude Code 帮我重构这个文件\"\n - \"让 Codex 写一个 Python 脚本\"\n - \"让 Gemini 分析这个代码\"\n\n要求:\n 1. 目标 agent 必须已通过 ListKnownAgents 扫描\n 2. 必须先调用 GrantAgentDelegation 获得用户授权\n 3. 工作目录可选，默认当前目录\n\n返回: agent 的输出文本 + 耗时",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"agentId":{"type":"string","description":"目标 agent ID","enum":["claude_code","codex","gemini","hermes","aider"]},"task":{"type":"string","minLength":5,"description":"任务描述（自然语言）"},"workdir":{"type":"string","description":"工作目录（可选）"}},"required":["agentId","task"],"additionalProperties":false},
  maxTimeout: 130000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.InstallSoftware = {
  description: "后台静默安装 Windows 软件（基于 winget/choco/scoop）。\n【强审批】必须传 confirmation=\"YES_INSTALL\" 才执行，否则返回 needsConfirmation。\n【流程】\n 1. 先调用 SearchSoftware(query) 找到 packageId\n 2. 向用户说明：包名、来源、用途\n 3. 等待用户回复\"确认安装\"\n 4. 再次调用本工具，confirmation=\"YES_INSTALL\" 真正执行\n【后台执行】安装任务以 job 形式入队，AI 调用立即返回；进度通过 SceneSet 卡片展示给用户。\n【支持的 manager】winget (Windows 默认) / choco / scoop。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"packageId":{"type":"string","description":"软件包 ID（winget Id / choco name / scoop bucket）"},"packageName":{"type":"string","description":"软件显示名（可选，用于 UI 展示）"},"manager":{"type":"string","enum":["winget","choco","scoop"],"default":"winget","description":"包管理器"},"confirmation":{"type":"string","enum":["YES_INSTALL"],"description":"必须传 \"YES_INSTALL\" 确认执行"}},"required":["packageId","confirmation"],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.UninstallSoftware = {
  description: "后台卸载已安装的软件。需要传 confirmation=\"YES_UNINSTALL\" 才执行。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"packageId":{"type":"string"},"packageName":{"type":"string"},"manager":{"type":"string","enum":["winget","choco","scoop"],"default":"winget"},"confirmation":{"type":"string","enum":["YES_UNINSTALL"]}},"required":["packageId","confirmation"],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.SearchSoftware = {
  description: "在 winget 仓库中搜索软件。返回 id/name/version 列表。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"query":{"type":"string","description":"搜索关键词（中文/英文/拼音均可）"},"limit":{"type":"number","default":10,"description":"最多返回条数"}},"required":["query"],"additionalProperties":false},
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetInstallJob = {
  description: "查询一个安装/卸载 job 的当前状态、进度和输出。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"jobId":{"type":"string","description":"job ID（InstallSoftware 返回的 jobId）"}},"required":["jobId"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.CancelInstallJob = {
  description: "取消一个安装/卸载 job。排队中的 job 可直接取消；运行中的 job 会尝试终止子进程。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"jobId":{"type":"string"}},"required":["jobId"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.ListInstallJobs = {
  description: "列出当前用户的所有安装/卸载 jobs，可按 status/manager 过滤。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"userId":{"type":"string"},"status":{"type":"string","enum":["queued","running","succeeded","failed","cancelled"]},"manager":{"type":"string","enum":["winget","choco","scoop"]}},"required":[],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.DetectSoftwareManagers = {
  description: "探测本机可用的包管理器（winget/choco/scoop）。在尝试安装前调用，确认环境是否就绪。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetAwakeningStatus = {
  description: "查询当前觉醒状态。返回 status (idle/scan_env/load_user/preload_memory/greeting/done/failed), phases (各阶段耗时), environment (OS/工具探测结果), userName, memory (记忆预热统计)。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.TriggerAwakening = {
  description: "触发一次觉醒。force=true 忽略缓存重新扫描。返回最新状态。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"force":{"type":"boolean","description":"忽略缓存强制重新觉醒"},"skipSceneCard":{"type":"boolean","description":"不推送 scene 卡片"},"timeoutMs":{"type":"number","description":"超时毫秒 (默认 5000)"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.InvalidateAwakening = {
  description: "失效觉醒缓存。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetSystemEnvironment = {
  description: "获取完整本机环境信息（OS/CPU/内存/工具/路径/环境变量）。force=true 忽略缓存。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"force":{"type":"boolean","description":"强制重新扫描，忽略缓存"}},"required":[],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetEnvironmentSummary = {
  description: "获取注入到 system prompt 的紧凑环境摘要（<system_environment>...</system_environment> 标签）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"maxLength":{"type":"number","description":"最大字符数（默认 600）"}},"required":[],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DetectTool = {
  description: "探测单个命令行工具是否可用，返回 version 或 error。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"bin":{"type":"string","description":"可执行文件名（如 node.exe）"},"args":{"type":"array","items":{"type":"string"},"description":"参数（默认 [\"--version\"]）"}},"required":["bin"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.InvalidateEnvironment = {
  description: "失效环境缓存，下次 GetSystemEnvironment 将重新扫描。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetSelfProfile = {
  description: "获取完整自我画像：knowledge (身份/版本/能力/限制) + perception (当前可用资源) + evolution (学习轨迹)。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"force":{"type":"boolean","description":"强制重新感知"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetSelfSummary = {
  description: "获取自我画像的紧凑文本（<self_awareness>...</self_awareness>），适合注入 prompt。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"force":{"type":"boolean"}},"required":[],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.RefreshSelf = {
  description: "失效自我画像缓存，下次 Get* 时重新感知。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
  maxTimeout: 2000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.HttpRequest = {
  description: "发起 HTTP 请求到外部 API。支持 GET/POST/PUT/PATCH/DELETE，JSON/form/raw body，自定义 headers。适合：调用 REST API、查询开放数据接口、Webhook 回调。安全限制：禁止内网地址（SSRF 防护），默认 15 秒超时。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"url":{"type":"string","description":"完整的请求 URL（必须）"},"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"],"default":"GET","description":"HTTP 方法"},"headers":{"type":"object","default":{},"description":"自定义请求头（选填），如 {\"Authorization\": \"Bearer xxx\"}"},"body":{"description":"请求体。JSON 对象自动转为 JSON（自动加 Content-Type），字符串为 raw body"},"timeout":{"type":"number","default":15000,"description":"超时时间（毫秒），默认 15000"},"followRedirect":{"type":"boolean","default":true,"description":"是否跟随重定向"}},"required":["url"],"additionalProperties":false},
  maxTimeout: 60000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DatabaseQuery = {
  description: "查询数据库。支持 SQLite（文件路径）、MySQL/PostgreSQL（host/user/password）。安全限制：只允许 SELECT 类只读操作，SQLite 文件必须在工作目录内。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"type":{"type":"string","enum":["sqlite","mysql","postgresql"],"description":"数据库类型","default":"sqlite"},"database":{"type":"string","description":"数据库名（SQLite：文件路径；MySQL/PostgreSQL：数据库名）"},"query":{"type":"string","description":"SQL 查询语句。只允许 SELECT/PRAGMA/EXPLAIN/ANALYZE/WITH 查询"},"question":{"type":"string","description":"自然语言问句（NL 路径，自动转 SQL）。与 query 二选一"},"host":{"type":"string","description":"数据库主机地址（MySQL/PostgreSQL 需要）"},"port":{"type":"number","description":"数据库端口"},"user":{"type":"string","description":"数据库用户名"},"password":{"type":"string","description":"数据库密码"}},"anyOf":[{"required":["query"]},{"required":["question"]}],"additionalProperties":false},
  maxTimeout: 60000, riskLevel: "low", validate: null
};

// 2026-08-07: NL2SQL 工具契约（nl2sql eval 套件依赖；此前缺失导致启动探针 98.4% 自杀）
TOOL_CONTRACTS.ListTables = {
  description: "列出数据库中的表",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"type":{"type":"string","enum":["sqlite","mysql","postgresql"],"description":"数据库类型"},"database":{"type":"string","description":"数据库名（SQLite：文件路径）"}},"required":["type","database"],"additionalProperties":false},
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DescribeTable = {
  description: "查看表结构（拒绝危险表名）",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"type":{"type":"string","enum":["sqlite","mysql","postgresql"],"description":"数据库类型"},"database":{"type":"string","description":"数据库名（SQLite：文件路径）"},"table":{"type":"string","pattern":"^[A-Za-z_][A-Za-z0-9_]*$","description":"表名（仅字母数字下划线，防注入）"}},"required":["type","database","table"],"additionalProperties":false},
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ArchiveCompress = {
  description: "将文件或目录压缩为存档。支持 zip、tar、tar.gz、7z 格式。使用系统 7z/tar 命令。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"source":{"type":"string","description":"要被压缩的文件或目录路径"},"output":{"type":"string","description":"输出的压缩包路径"},"format":{"type":"string","enum":["zip","tar","tar.gz","7z"],"default":"zip","description":"压缩格式"}},"required":["source","output"],"additionalProperties":false},
  maxTimeout: 120000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.ArchiveExtract = {
  description: "解压存档文件到指定目录。支持 zip、tar、tar.gz、7z 格式。自动检测格式。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"source":{"type":"string","description":"压缩包路径"},"outputDir":{"type":"string","description":"解压输出目录（选填，默认在压缩包同级创建 *_extracted 目录）"},"format":{"type":"string","enum":["zip","tar","tar.gz","7z"],"description":"压缩格式（选填，自动检测）"}},"required":["source"],"additionalProperties":false},
  maxTimeout: 120000, riskLevel: "high", validate: null
};
TOOL_CONTRACTS.ArchiveList = {
  description: "列出压缩包内的文件清单（不解压）。支持 zip、tar、tar.gz、7z。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"source":{"type":"string","description":"压缩包路径"}},"required":["source"],"additionalProperties":false},
  maxTimeout: 30000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SessionSearch = {
  description: "搜索对话历史。三种模式：1) 传 query → FTS5 全文搜索对话内容，返回匹配消息及其上下文窗口；2) 传 session_id → 查看某个会话的完整消息列表；3) 不传参数 → 浏览近期会话摘要。零 LLM 成本。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"query":{"type":"string","description":"搜索关键词（模式1：全文搜索）。支持中文和英文"},"session_id":{"type":"string","description":"会话 ID（模式2：查看某会话的完整消息）"},"limit":{"type":"number","default":10,"description":"返回条数上限"},"offset":{"type":"number","default":0,"description":"分页偏移量"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DirectoryQuery = {
  description: "用自然语言查询 CrabPaw 项目结构：问某个功能在哪里、某个类在哪、某个工具怎么调用。返回 top 命中条目（含路径、描述、相关工具/类）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"question":{"type":"string","description":"查询问题（自然语言）"},"query":{"type":"string","description":"查询问题(兼容 query 字段)"},"limit":{"type":"number","description":"返回条数（默认 5）","default":5},"category":{"type":"string","description":"限定类目（memory/voice/tools/...）"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DirectoryList = {
  description: "列出指定类目下的所有目录条目。可选类目：core/memory/voice/tools/channel/agent/evolution/security/observability/...",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"category":{"type":"string","description":"类目名称（不传则返回所有类目统计）"},"limit":{"type":"number","description":"返回条数上限","default":50}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DirectoryCard = {
  description: "生成 prompt 友好的目录摘要卡片，适合注入 system prompt。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"scope":{"type":"string","description":"限定 scope (core/tools/channels/...)，不传则概览"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DirectoryTools = {
  description: "列出所有在 CrabPaw 项目源码中注册过的工具（含工具名和所在文件路径）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"pattern":{"type":"string","description":"按名称过滤（子串匹配）"}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ConfigAsk = {
  description: "询问 CrabPaw 配置相关问题（\"如何切换 LLM provider？\" / \"TTS 默认使用什么？\" / \"数据存放在哪里？\"）。返回最佳答案、相关问题、相关配置路径。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"question":{"type":"string","description":"配置相关问题"}},"required":["question"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ConfigSearch = {
  description: "按关键词搜索配置 FAQ 条目（问题/关键词/配置路径匹配）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"keyword":{"type":"string","description":"搜索关键词"},"query":{"type":"string","description":"搜索关键词(兼容 query 字段)"}},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ConfigList = {
  description: "列出所有配置 FAQ 条目，可按 category 过滤（startup/storage/llm/voice/channel/security/performance/tools/memory/testing）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"category":{"type":"string","description":"分类（不传返回所有）"}},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.AgentsList = {
  description: "列出所有可用的智能体角色。内置 7 个通用角色（planner/researcher/code_executor/critic/summarizer/tools_agent/archivist），以及通过能力和领域自动合成的专业角色（如 \"finance_researcher\" = 财务调研员）。传 filter 参数按名称/描述筛选。传 help=true 查看使用说明。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"filter":{"type":"string","description":"按名称/ID/描述/层级筛选（选填）"},"help":{"type":"boolean","description":"设为 true 返回使用说明"}},"required":[],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.AgentView = {
  description: "查看某个智能体的详细信息，包括可用工具、禁止工具、System Prompt 和适用场景。需要 agentId 参数，可以从 AgentsList 获取。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"agentId":{"type":"string","description":"智能体 ID（必填），如 \"planner\"、\"finance_researcher\"、\"code_executor\""}},"required":["agentId"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.FindTool = {
  description: "工具自发现 — 当你需要某个工具但当前不在列表中时调用。\n返回匹配的 tool 列表（含 name 和 description）。\n下一轮该工具的完整 schema 会被自动注入到你的视野中。\n\n用法示例:\n - \"我需要一个翻译工具\" → FindTool(query=\"翻译\")\n - \"怎么压缩文件\" → FindTool(query=\"压缩 archive\")\n - \"查 PDF 工具\" → FindTool(query=\"pdf\")\n\n返回结果示例:\n[\n { \"name\": \"Bash\", \"description\": \"...\", \"toolset\": \"system\" },\n { \"name\": \"Read\", \"description\": \"...\", \"toolset\": \"file\" }\n]",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"query":{"type":"string","description":"工具搜索关键词（中文或英文），可用空格分隔多词"},"limit":{"type":"number","description":"返回结果数量上限，默认 5","default":5}},"required":["query"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.BilibiliSearch = {
  description: "搜索 B站（bilibili）视频。支持中文关键词搜索，返回视频标题、作者、播放量、时长等信息。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"keyword":{"type":"string","description":"搜索关键词"},"query":{"type":"string","description":"搜索关键词(兼容)"},"limit":{"type":"number","description":"返回条数"}},"required":[],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.BilibiliPlay = {
  description: "获取 B站视频信息，返回视频播放页链接供用户观看。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
  maxTimeout: 15000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.StartTurnTrace = {
  description: "开启一个回合轨迹。返回 turnId，后续工具调用和响应都挂到该 turn 上，便于事后回放、调试、统计。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"sessionId":{"type":"string"},"userId":{"type":"string"},"userInput":{"type":"string","description":"本回合用户输入"}},"required":["userInput"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.RecordToolCall = {
  description: "记录一次工具调用到当前回合。如果不指定 turnId，自动取该 session 上一个 StartTurnTrace。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"sessionId":{"type":"string"},"turnId":{"type":"string"},"tool":{"type":"string"},"params":{"type":"object"},"result":{},"status":{"type":"string","enum":["pending","running","success","failed","blocked","timeout"],"default":"success"},"error":{"type":"string"}},"required":["tool"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.RecordResponse = {
  description: "记录一次响应片段（中间 / 最终）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"sessionId":{"type":"string"},"turnId":{"type":"string"},"text":{"type":"string"},"kind":{"type":"string","enum":["intermediate","final","tool-summary","error"],"default":"final"}},"required":["text"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.CompleteTurn = {
  description: "结束当前回合。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"sessionId":{"type":"string"},"turnId":{"type":"string"},"response":{"type":"string"},"error":{"type":"string"},"aborted":{"type":"boolean"}},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.GetTurnTrace = {
  description: "查询历史回合轨迹。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"turnId":{"type":"string"},"sessionId":{"type":"string"},"limit":{"type":"number","default":5}},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetTraceStats = {
  description: "回合级统计：总数/状态分布/工具调用数/平均耗时/错误数。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"sessionId":{"type":"string"},"since":{"type":"number","description":"起始时间（Unix ms）"}},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.RegisterCapability = {
  description: "注册一个能力实现到指定槽位。槽位如 tts/stt/llm/image-gen/search 等。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"slot":{"type":"string"},"name":{"type":"string"},"version":{"type":"string"},"metadata":{"type":"object"},"tags":{"type":"array","items":{"type":"string"}},"dependencies":{"type":"array","items":{"type":"string"}},"enabled":{"type":"boolean","default":false},"priority":{"type":"number","default":100}},"required":["slot","name"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.EnableCapability = {
  description: "启用指定槽位下的某个实现。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"slot":{"type":"string"},"name":{"type":"string"}},"required":["slot","name"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.DisableCapability = {
  description: "禁用某个能力。会自动切换到下一个可用的实现。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"slot":{"type":"string"},"name":{"type":"string"}},"required":["slot","name"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.SetActiveCapability = {
  description: "主动切换槽位的 active 实现。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"slot":{"type":"string"},"name":{"type":"string"}},"required":["slot","name"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.ListCapabilities = {
  description: "列出能力（可按 slot 过滤）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"slot":{"type":"string"},"tag":{"type":"string"}},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.GetActiveCapability = {
  description: "查询指定槽位的 active 实现。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"slot":{"type":"string"}},"required":["slot"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.CapabilityHealthCheck = {
  description: "异步执行能力健康检查。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"slot":{"type":"string"},"enabledOnly":{"type":"boolean","default":true}},"required":[],"additionalProperties":false},
  maxTimeout: 10000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.SetSecret = {
  description: "安全地存储一个密钥。value 会被加密后写入 ~/.crabpaw/secrets/。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"key":{"type":"string"},"value":{"type":"string"},"metadata":{"type":"object"},"ttlMs":{"type":"number","description":"过期时间（毫秒）"}},"required":["key","value"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.GetSecret = {
  description: "读取密钥明文。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"key":{"type":"string"}},"required":["key"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.DeleteSecret = {
  description: "删除密钥。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"key":{"type":"string"}},"required":["key"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.ListSecrets = {
  description: "列出所有密钥（仅元数据，不含明文）。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ExtractConcepts = {
  description: "从一段文本中提取关键概念：高频关键词、命名实体（URL/邮箱/IP/时间/数字/引文/姓名）、技术工具、概念指纹 hash。用于记忆索引、相似度检索、上下文去重。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"text":{"type":"string","description":"要分析的文本"},"topN":{"type":"number","description":"返回关键词数量（默认 10）","default":10},"includeFingerprint":{"type":"boolean","description":"是否返回概念指纹 hash","default":true},"format":{"type":"string","enum":["json","prompt","compact"],"default":"json"}},"required":["text"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.ParseTime = {
  description: "解析自然语言时间表达式为结构化时间戳。支持相对（\"今天\"/\"3天后\"/\"下周\"）、绝对（\"2026-07-12 14:30\"/\"7月15日\"）、区间（\"今天到明天\"）。返回 ISO 字符串和人类可读时间。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"expression":{"type":"string","description":"时间表达式（如 \"3天后\" / \"2026-07-15\"）"},"timezone":{"type":"string","description":"时区（默认 Asia/Shanghai）"}},"required":["expression"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "medium", validate: null
};
TOOL_CONTRACTS.TimeDelta = {
  description: "计算两个时间点之间的差值，返回 \"X 秒前\"/\"X 小时前\" 形式的相对标签。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"target":{"type":"string","description":"目标时间（ISO 字符串或自然语言）"},"reference":{"type":"string","description":"参考时间（默认 now）"}},"required":["target"],"additionalProperties":false},
  maxTimeout: 3000, riskLevel: "low", validate: null
};
TOOL_CONTRACTS.TrainQuery = {
  description: '查询 12306 火车/高铁余票。输入中文站名与日期，返回车次/时刻/座位余票。',
  whenNotToUse: ['站名为英文或拼音时（请用中文站名）', '需要订票/支付时（本工具只查询）', '查询航班时（无航班数据）'],
  schema: { type: 'object', properties: { from: { type: 'string', description: '出发站中文名（如：北京）' }, to: { type: 'string', description: '到达站中文名（如：上海）' }, date: { type: 'string', description: '乘车日期 YYYY-MM-DD' } }, required: ['from', 'to', 'date'], additionalProperties: false },
  maxTimeout: 30000, riskLevel: 'low', validate: null
};

// ── 2026-08-15 P1-4: 补齐 6 个无契约工具（与 registry 注册对齐）──────────
TOOL_CONTRACTS.HoldingAdd = {
  description: '添加/更新老板股票持仓（代码/名称/股数/成本价），用于"今天持仓怎么样"批量播报与开盘早报。',
  whenNotToUse: ['查询行情时（用 StockQuery）', '删除持仓时（用 HoldingRemove）'],
  schema: { type: 'object', properties: { code: { type: 'string', description: '股票代码（如 600519）' }, name: { type: 'string', description: '股票名称（如 贵州茅台）' }, shares: { type: 'number', description: '持股数量（正数）' }, cost: { type: 'number', description: '成本价（正数）' } }, required: ['code', 'shares', 'cost'], additionalProperties: false },
  maxTimeout: 10000, riskLevel: 'medium', validate: null
};
TOOL_CONTRACTS.HoldingList = {
  description: '列出老板全部持仓。',
  whenNotToUse: ['添加持仓时（用 HoldingAdd）'],
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  maxTimeout: 10000, riskLevel: 'low', validate: null
};
TOOL_CONTRACTS.HoldingRemove = {
  description: '删除一笔持仓。',
  whenNotToUse: ['添加持仓时（用 HoldingAdd）'],
  schema: { type: 'object', properties: { code: { type: 'string', description: '股票代码' } }, required: ['code'], additionalProperties: false },
  maxTimeout: 10000, riskLevel: 'medium', validate: null
};
// ── 2026-08-17 fix(Task 6 Red-2): WatchlistAdd/Remove 已注册(registry, stock-watchlist.js)
// 但契约表缺失 → wiring_001 覆盖率缺口(99.0%→100%)。字段与注册一致。
TOOL_CONTRACTS.WatchlistAdd = {
  description: '收藏一只股票到自选列表（用于"收藏海康威视"）。面板查询过的股票会自动收藏，一般无需手动调用。',
  whenNotToUse: ['查询行情时（用 StockQuery）', '移除收藏时（用 WatchlistRemove）'],
  schema: { type: 'object', properties: { code: { type: 'string', description: '股票代码（如 600519）' }, name: { type: 'string', description: '股票名称（如 贵州茅台）' } }, required: ['code'], additionalProperties: false },
  maxTimeout: 10000, riskLevel: 'low', validate: null
};
TOOL_CONTRACTS.WatchlistRemove = {
  description: '取消收藏一只股票（用于"取消收藏海康威视"）。',
  whenNotToUse: ['添加收藏时（用 WatchlistAdd）'],
  schema: { type: 'object', properties: { code: { type: 'string', description: '股票代码' } }, required: ['code'], additionalProperties: false },
  maxTimeout: 10000, riskLevel: 'low', validate: null
};
TOOL_CONTRACTS.ImportDataFile = {
  description: '导入 CSV/XLSX 报表文件到本地业务数据库并自动建表（类型推断+业务角色识别）。导入后即可用自然语言查询（如"这个月营收多少"）。',
  whenNotToUse: ['导入文件不在工作目录或数据目录内时', '需要修改已有表结构时（先换名导入）', '文件超过 100MB 时'],
  schema: { type: 'object', properties: { filePath: { type: 'string', description: 'CSV/XLSX 文件绝对路径（必须在工作目录或数据目录内）' }, tableName: { type: 'string', description: '目标表名（默认取文件名，自动规范化）' }, mode: { type: 'string', enum: ['create', 'replace', 'append'], description: 'create=新建(已存在则报错), replace=覆盖, append=追加', default: 'create' }, dbPath: { type: 'string', description: '业务库路径（默认 data/.crabpaw/business/business.db）' } }, required: ['filePath'], additionalProperties: false },
  maxTimeout: 60000, riskLevel: 'medium', validate: null
};
TOOL_CONTRACTS.ProactiveSpeak = {
  description: 'CrabPaw 主动发声：在用户未下达新指令时，主动向老板播报重要事项（会议提醒、任务到期、文档到达、重要进展）。会经过打扰抑制（静默时段 22-8 / 30 分钟去重），可能只入面板不发声。返回 state 说明实际状态：broadcast=已发声 / queued_silent=静默期已排队稍后补播 / suppressed=被抑制（去重或静默）。',
  whenNotToUse: ['用户正在对话中请勿调用（此时用正常回复通道回答）', '用户明确要求静音/勿扰时请勿调用', '信息价值低于打扰成本（琐碎状态、进度播报）时请勿调用', '用户几分钟内已被告知过相同事项时请勿重复调用'],
  schema: { type: 'object', properties: { text: { type: 'string', description: '播报内容：一句话、口语化、直接对老板说话' }, trigger: { type: 'string', description: '触发场景标识（reminder/task_due/document_ready/workflow_progress/agent）', default: 'agent' }, intent: { type: 'string', enum: ['confront', 'inform', 'ambient', 'silent'], description: '打扰强度：confront=紧急必须打扰 / inform=正常通知 / ambient=纯背景 / silent=只入面板不发声', default: 'inform' }, surface: { type: 'object', description: '可选面板数据 { kind: "text", data: { title, body } }，随事件广播供前端渲染' } }, required: ['text'], additionalProperties: false },
  maxTimeout: 10000, riskLevel: 'low', validate: null
};
TOOL_CONTRACTS.TyphoonQuery = {
  description: '查询当前活跃台风及其路径、强度、预警信息。当用户提到"台风"、"台风路径"、"台风最新动态"、"有台风吗"等话题时，必须调用此工具。参数 query 可传台风中文名/英文名/编号（如"202617"），留空则列出全部活跃台风。数据源为政府公益发布系统，失败自动降级备用数据源。',
  whenNotToUse: ['查询普通天气预报时（用天气工具）', '需要台风路径可视化地图时（可建议查看官方发布系统）'],
  schema: { type: 'object', properties: { query: { type: 'string', description: '台风中文名/英文名或编号（如"浪卡"、"NANGKA"、"202617"），留空则列出全部活跃台风' } }, required: [], additionalProperties: false },
  maxTimeout: 20000, riskLevel: 'low', validate: null
};
TOOL_CONTRACTS.FormatContext = {
  description: "将概念提取 + 时间解析 + 自我感知整合为统一的 <context> 块，适合注入 system prompt 或作为 turn trace。",
  whenNotToUse: [],
  schema: {"type":"object","properties":{"text":{"type":"string","description":"要分析的文本"},"includeAwareness":{"type":"boolean","default":true,"description":"是否包含自我感知块"}},"required":["text"],"additionalProperties":false},
  maxTimeout: 5000, riskLevel: "low", validate: null
};

// ── snake_case 历史名别名（向后兼容）─────────────
// 2026-08-15 T7: HARNESS.md v2.4.0 契约主名统一 PascalCase。
// 以下 snake_case 原名保留为别名指向同一契约对象，确保旧引用
// （getToolContract('skill_manage') 等）与历史 LLM 工具调用不中断。
const LEGACY_SNAKE_ALIASES = {
  skill_manage: 'SkillManage',
  skill_generate: 'SkillGenerate',
  doc_read: 'DocRead',
  doc_to_markdown: 'DocToMarkdown',
  pdf_extract: 'PdfExtract',
  xlsx_query: 'XlsxQuery',
  email_list: 'EmailList',
  email_read: 'EmailRead',
  email_search: 'EmailSearch',
  email_send: 'EmailSend',
  taskflow: 'Taskflow',
  todo: 'Todo',
  hot_search: 'HotSearch',
  platform_keys_status: 'PlatformKeysStatus',
  wechat_mp_draft: 'WechatMpDraft',
  wechat_mp_publish: 'WechatMpPublish',
  docx_generate: 'DocxGenerate',
  xlsx_generate: 'XlsxGenerate',
  pptx_generate: 'PptxGenerate',
  pdf_generate: 'PdfGenerate',
  html_generate: 'HtmlGenerate',
  // 2026-08-18 清理: hotspot_mode/person_card_mode/worldcup_mode/focus_banner/
  // voice_retire 别名随 v1 工具注销而删除（v2 Show* 为事实标准, 见 task-6）。
  meeting_mode: 'MeetingMode',
};
for (const [snakeName, pascalName] of Object.entries(LEGACY_SNAKE_ALIASES)) {
  if (TOOL_CONTRACTS[pascalName] && !TOOL_CONTRACTS[snakeName]) {
    TOOL_CONTRACTS[snakeName] = TOOL_CONTRACTS[pascalName];
  }
}

// ── kebab-case 历史名别名（向后兼容）─────────────
// 2026-08-30 Task 11: 契约主名统一 PascalCase（同 snake 别名机制）。
// html-presentation/presentation-builder 为技能工具（registry 注册名即 kebab，
// 见 document-tools.js），kebab 原名保留为别名指向同一契约对象——registry
// 执行名/LLM 调用名/契约校验链（validateToolInput('html-presentation', ...)）
// 均不中断。
const LEGACY_KEBAB_ALIASES = {
  'html-presentation': 'HtmlPresentation',
  'presentation-builder': 'PresentationBuilder',
};
for (const [kebabName, pascalName] of Object.entries(LEGACY_KEBAB_ALIASES)) {
  if (TOOL_CONTRACTS[pascalName] && !TOOL_CONTRACTS[kebabName]) {
    TOOL_CONTRACTS[kebabName] = TOOL_CONTRACTS[pascalName];
  }
}

for (const [name, contract] of Object.entries(TOOL_CONTRACTS)) {
  try { contract.validate = ajv.compile(contract.schema); } catch(e) {
    // 2026-08-01: 编译失败此前静默替换为 () => true（所有输入放行且无任何日志）。
    // 改为显式告警暴露 schema 缺陷。
    console.error(`[tool-contract] 契约 ${name} 的 schema 编译失败，将跳过其校验: ${e.message}`);
    contract.validate = () => true;
  }
}

function getToolContract(n){return TOOL_CONTRACTS[n] || null}
function validateToolInput(n,i){const c=TOOL_CONTRACTS[n];if(!c)return{valid:true,errors:[],warning:"No contract: "+n};const v=c.validate(i);return{valid:v,errors:c.validate.errors?c.validate.errors.map(e=>(e.instancePath||"/")+" "+e.message):[]}}
function getAllContracts(){return TOOL_CONTRACTS}
function registerToolContract(n,c){try{c.validate=ajv.compile(c.schema)}catch(e){console.error(`[tool-contract] 契约 ${n} 的 schema 编译失败,已标记 invalid(校验放行): ${e?.message || e}`);c.validate=()=>true;c.invalid=true;c.invalidReason=e?.message||String(e)}TOOL_CONTRACTS[n]=c}
function registerIntoRegistry(r){
  if(!r||typeof r.addPreExecuteHook!="function")return;
  // 2026-08-04 P0 修复:契约单源化——以 registry(LLM 视野/真实实现)为唯一事实源。
  // 契约手写 schema 与 registry 参数不一致(审计发现 84 个,additionalProperties:false
  // 导致合法调用被拒 → 连续失败降级)。加载时自动合并 registry 独有属性进契约。
  let autoAligned = 0;
  for (const [name, contract] of Object.entries(TOOL_CONTRACTS)) {
    if (!contract?.schema || contract.schema.additionalProperties !== false) continue;
    let tool = null;
    try { tool = typeof r.get === 'function' ? r.get(name) : null; } catch (e) { console.warn(`[tool-contract] 读取工具 ${name} 失败:`, e?.message); }
    // 兼容两种 registry schema 形态: {parameters:{properties}} 与扁平 {properties}
    const regSchema = tool?.schema;
    const regProps = regSchema?.parameters?.properties || regSchema?.properties;
    if (!regProps || typeof regProps !== 'object') continue;
    const conProps = contract.schema.properties || {};
    const missing = Object.keys(regProps).filter(p => !(p in conProps));
    if (missing.length > 0) {
      const merged = { ...conProps };
      for (const p of missing) merged[p] = regProps[p];
      contract.schema = { ...contract.schema, properties: merged };
      try { contract.validate = ajv.compile(contract.schema); } catch (e) { console.error(`[tool-contract] 契约 ${name} 对齐后 schema 编译失败,已标记 invalid(校验放行): ${e?.message || e}`); contract.validate = () => true; contract.invalid = true; contract.invalidReason = e?.message || String(e); }
      autoAligned++;
      if (autoAligned <= 15) console.warn(`[tool-contract] 契约自动对齐 ${name}: 补 ${missing.length} 参数(${missing.join(',')})`);
    }
  }
  if (autoAligned > 0) console.warn(`[tool-contract] 共自动对齐 ${autoAligned} 个契约(registry 单源化)`);
  r.addPreExecuteHook(async(n,p)=>{const vr=validateToolInput(n,p);if(!vr.valid)return{blocked:true,reason:"[Tool Contract] "+n+": "+vr.errors.join("; "),errorCode:"TOOL_CONTRACT_VIOLATION"};return{blocked:false}});console.log("[tool-contract] Registered "+Object.keys(TOOL_CONTRACTS).length+" contracts")}
function generateCoverageReport(tools){const c=Object.keys(TOOL_CONTRACTS);const cov=tools.filter(n=>c.includes(n));const unc=tools.filter(n=>!c.includes(n));return{covered:cov,uncovered:unc,contractCount:c.length,registeredCount:tools.length,coverage:tools.length>0?(cov.length/tools.length*100).toFixed(1)+"%":"0%"}}
function getContractsByRiskLevel(){const g={high:{},medium:{},low:{}};for(const[n,c]of Object.entries(TOOL_CONTRACTS))g[c.riskLevel||"low"][n]=c;return g}

module.exports={TOOL_CONTRACTS,getToolContract,validateToolInput,getAllContracts,registerToolContract,registerIntoRegistry,generateCoverageReport,getContractsByRiskLevel,LEGACY_SNAKE_ALIASES,LEGACY_KEBAB_ALIASES,ajv};
