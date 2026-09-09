/**
 * 文档工具契约-参数单源化对齐测试（2026-08-20）
 *
 * 实机 bug："上传文件让智能体分析总结出错"。
 * 根因链（日志 17:26:41-17:27:20 实锤）：
 *   - document-tools.js 注册 schema 用 filePath 必需，而 tool-contract.js 契约
 *     (DocRead/DocToMarkdown/PdfExtract/XlsxQuery) 要求 path 必需 +
 *     additionalProperties:false → 模型按注册 schema 传 {"filePath":...} 被契约拒
 *     ("should have required property 'path'")。DocRead×3 + DocToMarkdown×4 连续
 *     失败后兜底 Bash+python 手工解析 docx；第 8 次模型从报错信息猜出 path 才成功。
 *   - 与 2026-08-17 StockQuery symbol/query 错位同型：契约与 registry 双端漂移。
 *
 * 修复：document-tools.js 四工具 schema 参数名统一 path（契约权威），handler
 *       双兼容 params.path ?? params.filePath；上传引导文案改指 DocRead(path)。
 * 本测试守契约与 registry 单源一致，防再错位。
 */

const { validateToolInput, getToolContract } = require('../core/tool-contract');
const { registry } = require('../tools/registry');

process.env.NODE_ENV = 'test';
require('../tools');

const DOC_TOOLS = {
  DocRead: { regName: 'doc_read', file: '/tmp/test.docx' },
  DocToMarkdown: { regName: 'doc_to_markdown', file: '/tmp/test.pdf' },
  PdfExtract: { regName: 'pdf_extract', file: '/tmp/test.pdf' },
  XlsxQuery: { regName: 'xlsx_query', file: '/tmp/test.xlsx' },
};

describe('文档工具契约对齐（registry 单源化）', () => {
  for (const [contractName, cfg] of Object.entries(DOC_TOOLS)) {
    describe(contractName, () => {
      test('契约放行 path 参数（工具 schema 的必需参数）', () => {
        const r = validateToolInput(contractName, { path: cfg.file });
        expect(r.valid).toBe(true);
      });

      test('契约 required 与 registry 工具 schema 完全一致（防双端漂移）', () => {
        const contract = getToolContract(contractName);
        const tool = registry.get(cfg.regName);
        expect(tool).toBeTruthy();
        const regSchema = tool.schema.parameters || tool.schema;
        // 2026-08-22: 契约用 anyOf 放行 path/filePath 别名时无 required 字段（同
        // CreateCalendarEvent 先例），断言放行面覆盖注册必填组合 + 别名组合。
        if (contract.schema.anyOf) {
          expect(contract.schema.anyOf).toContainEqual({ required: regSchema.required });
          expect(contract.schema.anyOf).toContainEqual({ required: ['filePath'] });
        } else {
          expect(contract.schema.required).toEqual(regSchema.required);
        }
        // 契约 properties 必须覆盖注册 schema 的全部属性（不得收窄）
        for (const p of Object.keys(regSchema.properties)) {
          expect(contract.schema.properties[p]).toBeTruthy();
        }
      });

      test('注册 schema 的 filePath 仅为可选别名（required 不含 filePath）', () => {
        const tool = registry.get(cfg.regName);
        const regSchema = tool.schema.parameters || tool.schema;
        expect(regSchema.properties.filePath).toBeTruthy(); // 2026-08-22: 别名可见,AI 按旧惯传也能命中
        expect(regSchema.required).not.toContain('filePath');
        expect(regSchema.required).toContain('path');
      });

      test('契约放行 filePath 别名参数（deepseek-v4-flash 参数名跟随差兜底）', () => {
        const r = validateToolInput(contractName, { filePath: cfg.file });
        expect(r.valid).toBe(true);
      });

      test('契约放行 path + filePath 同时传入', () => {
        const r = validateToolInput(contractName, { path: cfg.file, filePath: cfg.file });
        expect(r.valid).toBe(true);
      });
    });
  }
});

// ─── 2026-08-22 实机修复: Read/Edit path 别名（checkFn 曾只认 file_path 拒绝 path）───
// 用户 GUI 18:43 实测: deepseek 传 {"path":...} → 「工具参数检查失败: Read」×2 →
// 模型被迫换 ShellExec Get-Content 中文路径卡死 24min。与 DocRead 同型契约漂移。
describe('Read/Edit path 别名（checkFn 双兼容）', () => {
  test('Read 注册 schema 含 path 可选别名', () => {
    const tool = registry.get('Read');
    expect(tool).toBeTruthy();
    const regSchema = tool.schema.parameters || tool.schema;
    expect(regSchema.properties.path).toBeTruthy();
    expect(regSchema.required).toContain('file_path');
    expect(regSchema.required).not.toContain('path');
  });

  test('Read checkFn 放行 path 参数（不抛「工具参数检查失败」）', async () => {
    const tool = registry.get('Read');
    // 直接调 checkFn——模型传 {"path":...} 时不得为 falsy（checkFn 语义: 返回值
    // 真假均可——原实现 file_path && ... 即返回字符串值, 此处只断言非假）
    expect(tool.checkFn({ path: 'D:/x/a.md' })).toBeTruthy();
    expect(tool.checkFn({ file_path: 'D:/x/a.md' })).toBeTruthy();
    expect(tool.checkFn({})).toBeFalsy();
    // execute 层: 带 path 不再落 checkFn 拒绝——失败应来自 handler 后续
    // （路径防护/文件不存在）, 而非「工具参数检查失败」
    const r = await registry.execute('Read', { path: 'D:/x/a.md' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error || '')).not.toContain('工具参数检查失败');
  });

  test('Edit checkFn 放行 path 参数', () => {
    const tool = registry.get('Edit');
    expect(tool.checkFn({ path: 'D:/x/a.md', old_string: 'a', new_string: 'b' })).toBeTruthy();
    expect(tool.checkFn({ file_path: 'D:/x/a.md', old_string: 'a', new_string: 'b' })).toBeTruthy();
    expect(tool.checkFn({ path: 'D:/x/a.md' })).toBeFalsy(); // 缺 old_string 仍拒
  });

  // ─── 2026-08-22 第二轮实机（19:20 日志实锤）: Write 被拒——模型传驼峰 filePath ───
  // DocRead 别名用驼峰 filePath → 模型学会后套用到 Write → Write checkFn 只认
  // 下划线 file_path/path → 「工具参数检查失败: Write」。三工具改三兼容。
  test('Write/Read/Edit checkFn 放行驼峰 filePath（19:20 实测被拒形式）', () => {
    for (const name of ['Read', 'Write', 'Edit']) {
      const tool = registry.get(name);
      expect(tool).toBeTruthy();
      const base = name === 'Write'
        ? { content: '# x' }
        : name === 'Edit' ? { old_string: 'a', new_string: 'b' } : {};
      expect(tool.checkFn({ filePath: 'D:/x/a.md', ...base })).toBeTruthy();
      // schema 暴露驼峰别名（toClaudeFormat 透传 properties）
      const regSchema = tool.schema.parameters || tool.schema;
      expect(regSchema.properties.filePath).toBeTruthy();
    }
  });

  test('Write 注册 schema 同时含 path/filePath/file_path 三别名', () => {
    const tool = registry.get('Write');
    const regSchema = tool.schema.parameters || tool.schema;
    expect(regSchema.properties.file_path).toBeTruthy();
    expect(regSchema.properties.path).toBeTruthy();
    expect(regSchema.properties.filePath).toBeTruthy();
  });

  test('Read handler 双兼容（path/file_path 均能进入读取流程）', async () => {
    // handler 无法直接 require（模块顶层注册副作用），通过 execute 端到端:
    // path 传参不再因 checkFn 拒绝——失败落在 handler（路径防护/不存在）而非
    // 「工具参数检查失败」
    const r = await registry.execute('Read', { path: 'D:/x/definitely-not-exists-0822.md' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error || '')).not.toContain('工具参数检查失败');
  });
});

// ─── 2026-08-23 实机: 生成类工具契约双端漂移（deepseek 传 colorScheme/tableData/markdownContent 被拒）───
// 日志实锤: PptxGenerate 「/ should NOT have additional properties」×3 → 模型改走
// MarkdownToPPT 又因「工具参数检查失败」→ 无产物无 done。契约 tool-contract.js 与
// registry document-tools.js/file-tools.js 参数名不对齐。修复后此段守防再漂移。
describe('生成类工具契约对齐（PptxGenerate/XlsxGenerate/PdfGenerate/MarkdownToPPT）', () => {
  test('契约放行 PptxGenerate 的 style/colorScheme/outputPath 别名（模型实传形式）', () => {
    // 实机被拒形态: 顶层 colorScheme + table 类型 tableData
    const r = validateToolInput('PptxGenerate', {
      slides: [
        { type: 'title', title: 'T' },
        { type: 'table', title: '表', tableData: { headers: ['a'], rows: [['1']] } },
      ],
      colorScheme: 'business_blue',
      title: '报告',
      outputPath: 'D:/x/a.pptx',
    });
    expect(r.valid).toBe(true);
    // 契约 properties 必须覆盖 registry 全部（style/outputPath 不得收窄）
    const contract = getToolContract('PptxGenerate');
    expect(contract.schema.properties.style).toBeTruthy();
    expect(contract.schema.properties.colorScheme).toBeTruthy();
    expect(contract.schema.properties.outputPath).toBeTruthy();
    // 2026-08-23 二轮实机: coverTemplate 顶层额外字段被拒 → 生成类内容工具不卡
    // additionalProperties（deepseek 参数名自由发挥, 每次不同）
    expect(contract.schema.additionalProperties).not.toBe(false);
    expect(validateToolInput('PptxGenerate', {
      slides: [{ type: 'title', title: 'T' }],
      coverTemplate: 'gradient', // 实机被拒字段
    }).valid).toBe(true);
  });

  test('契约放行 XlsxGenerate 的 sheets/colorScheme/outputPath（registry 权威参数）', () => {
    const r = validateToolInput('XlsxGenerate', {
      sheets: [{ title: '营收', columns: [{ header: '季度' }], rows: [['Q1']] }],
      colorScheme: 'blue',
      title: '报表',
      outputPath: 'D:/x/a.xlsx',
    });
    expect(r.valid).toBe(true);
    const contract = getToolContract('XlsxGenerate');
    expect(contract.schema.properties.sheets).toBeTruthy();
    expect(contract.schema.properties.colorScheme).toBeTruthy();
  });

  test('契约放行 XlsxGenerate 的 data.sheets 嵌套（deepseek 实机被拒形态 2026-08-22 18:45）', () => {
    // 实机形态: {"data":{"sheets":[...]}} — 旧 required:["sheets"] 拒绝 → 首轮失败
    const r = validateToolInput('XlsxGenerate', {
      data: { sheets: [{ name: '客户管理', columns: [{ header: '客户名称' }], rows: [['A公司']] }] },
      title: '销售CRM管理表',
      filename: '销售CRM管理表.xlsx',
    });
    expect(r.valid).toBe(true);
    const contract = getToolContract('XlsxGenerate');
    // anyOf(sheets|data) 双入口——两个方向都不能被 required 卡死
    expect(contract.schema.anyOf).toBeTruthy();
    expect(validateToolInput('XlsxGenerate', {}).valid).toBe(false);
  });

  test('契约放行 PdfGenerate 的 style/author/outputPath（registry 权威参数）', () => {
    const r = validateToolInput('PdfGenerate', {
      content: '# 标题\n正文',
      style: '商务报告',
      author: 'CrabPaw',
      title: '报告',
      outputPath: 'D:/x/a.pdf',
    });
    expect(r.valid).toBe(true);
    const contract = getToolContract('PdfGenerate');
    expect(contract.schema.properties.style).toBeTruthy();
    expect(contract.schema.properties.author).toBeTruthy();
    expect(contract.schema.properties.outputPath).toBeTruthy();
  });

  test('契约放行 MarkdownToPPT 的 markdownContent 内联文本（无 input_path）', () => {
    const r = validateToolInput('MarkdownToPPT', {
      markdownContent: '# 封面\n\n## 内容页\n\n- 要点',
      title: '演示',
    });
    expect(r.valid).toBe(true);
    // input_path 路径模式仍放行
    expect(validateToolInput('MarkdownToPPT', { input_path: 'D:/x/a.md' }).valid).toBe(true);
  });

  test('registry checkFn 放行 markdownContent（execute 层不再「工具参数检查失败」）', async () => {
    const tool = registry.get('MarkdownToPPT');
    expect(tool.checkFn({ markdownContent: '# a' })).toBeTruthy();
    expect(tool.checkFn({ input_path: 'D:/x/a.md' })).toBeTruthy();
    expect(tool.checkFn({})).toBeFalsy();
  });
});
