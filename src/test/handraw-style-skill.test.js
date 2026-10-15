/**
 * handraw-style-skill.test.js — handraw-style 内置技能包完整性（2026-10-09 安装锁定）
 *
 * 来源 https://github.com/yang0/handraw-style（v1.8.5，宽松许可要求保留作者与仓库地址）。
 * 本包为 CrabPaw 适配版：入口 SKILL.md 重写（出图直连/参考表按需读/无参考图库降级），
 * 上游参考表与子技能文档逐字保留。本测试锁定"装得进、加载得到、契约字符串没走样"。
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../core/skill/frontmatter-parser');

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'handraw-style');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

describe('handraw-style 技能包（CrabPaw 适配版）', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  test('前置元数据符合 CrabPaw 约定', () => {
    expect(frontmatter.name).toBe('handdraw-style-prompter');
    expect(frontmatter.version).toBe('1.8.5');
    expect(String(frontmatter.description).length).toBeGreaterThan(50);
    expect(frontmatter.metadata.crabpaw.emoji).toBe('🎨');
    // 原始 frontmatter 值均为字符串；数值化由 loader 的 parseMetadata 负责
    expect(String(frontmatter.metadata.crabpaw.priority)).toBe('3');
  });

  test('路由索引指向的子技能文档全部真实存在', () => {
    const targets = [...body.matchAll(/`subskills\/([a-z-]+)\/SKILL.md`/g)].map(m => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(9);
    for (const t of targets) {
      expect(fs.existsSync(path.join(SKILL_DIR, 'subskills', t, 'SKILL.md'))).toBe(true);
    }
  });

  test('参考表/权威内容/许可随包且规模合理', () => {
    for (const f of ['STYLES.md', 'styles_200_reorganized.md', 'LAYOUTS.md', 'COLORS.md', 'TUTORIALS.md', 'LICENSE']) {
      expect(fs.existsSync(path.join(SKILL_DIR, f))).toBe(true);
    }
    const layoutsDir = path.join(SKILL_DIR, 'subskills', 'handdraw-style-prompter', 'references', 'layouts');
    const layouts = fs.readdirSync(layoutsDir).filter(f => f.endsWith('.md'));
    expect(layouts.length).toBeGreaterThanOrEqual(160);
    // 许可要求：作者署名与原仓库地址必须随技能保留
    expect(body).toContain('yang0');
    expect(body).toContain('https://github.com/yang0/handraw-style');
    // 53MB 参考图库与画廊不应混入仓库
    expect(fs.existsSync(path.join(SKILL_DIR, 'images'))).toBe(false);
    expect(fs.existsSync(path.join(SKILL_DIR, 'subskills', 'handdraw-style-prompter', 'gallery'))).toBe(false);
  });

  test('上游契约字符串逐字保留（图文后缀 / 转绘重绘指令）', () => {
    expect(body).toContain('【如果主题直白包含画面元素那就按主题出图，文案由你来升华，但是不要直接描述画面。 如果主题比较概念化，那么文案和主题尽量保持一致，如果文案较长由你提炼，由你先设计画面隐喻（人类和非人类都行）再出图   。    文字参与构图，图文一体】');
    expect(body).toContain('【请只提取人物的五官特征和姿态，场景轮廓，在画风上严格按 选择的风格 重新画，不要在原照片上加质感。】');
    expect(body).toContain('当前处于纯图模式，可切换为图文模式。');
  });

  test('CrabPaw 适配段齐备（默认出图直连/降级策略/路径换算）', () => {
    // 2026-10-09 行为翻转: 默认出图(直连本机图像模型),纯提示词降级为显式要求时的行为
    expect(body).toContain('## CrabPaw 出图直连');
    expect(body).toContain('默认直接调用本机配置的图像模型出图');
    expect(body).toContain('ImageGenerate');
    expect(body).toContain('enhance_prompt: false');
    expect(body).not.toContain('默认只创建提示词');
    expect(body).toContain('绝不虚构、替代或编造参考图路径');
    expect(body).toContain('subskills/handdraw-style-prompter/scripts/resolve_reference.py');
  });

  test('能力矩阵与全库索引 JSON 可解析', () => {
    const refDir = path.join(SKILL_DIR, 'subskills', 'handdraw-style-prompter', 'references');
    const cap = JSON.parse(fs.readFileSync(path.join(refDir, 'model_capabilities.json'), 'utf-8'));
    expect(JSON.stringify(cap)).toContain('gpt-image-2');
    const styles = JSON.parse(fs.readFileSync(path.join(refDir, 'styles.json'), 'utf-8'));
    const styleList = Array.isArray(styles) ? styles : (styles.styles || Object.values(styles).find(Array.isArray) || []);
    expect(styleList.length).toBeGreaterThanOrEqual(300);
    const layoutsIndex = JSON.parse(fs.readFileSync(path.join(refDir, 'layouts.json'), 'utf-8'));
    expect(JSON.stringify(layoutsIndex)).toContain('SC-021');
  });

  test('技能能被技能系统加载并注册到正确名字下', () => {
    const { loadSkillsFromDir } = require('../core/skills');
    const registry = loadSkillsFromDir('skills');
    const s = registry['handdraw-style-prompter'];
    expect(s).toBeTruthy();
    expect(s.version).toBe('1.8.5');
    expect(s.metadata?.crabpaw?.emoji).toBe('🎨');
    expect(s.metadata?.crabpaw?.tags).toContain('插画');
    expect(s.body).toContain('## CrabPaw 出图直连');
  });
});
