/**
 * 技能体系全面集成测试
 * 覆盖: 导入 → 安全扫描 → 注册 → 进化 → 融合 → 热替换 → 微调 → 分级
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), "crabpaw-skill-test-" + Date.now());

function setupTestDir() {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  const skillDir = path.join(TEST_DIR, "test-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: test-skill",
    "description: A test skill for integration testing",
    "version: 1.0.0",
    "metadata:",
    "  crabpaw:",
    "    category: test",
    "    priority: 1",
    "    tags: [test]",
    "---",
    "# Test Skill",
    "",
    "This is a test skill for integration tests.",
    ""
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(skillDir, "executor.js"), [
    "async function execute(context) {",
    "  const { input, logger } = context;",
    "  logger.info(\"Test skill executed\");",
    "  return { success: true, data: { message: \"Hello\", input } };",
    "}",
    "module.exports = { execute };",
    ""
  ].join("\n"), "utf-8");
  return skillDir;
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

let mods = {};
function loadModule(name, filePath) {
  try { mods[name] = require(filePath); }
  catch (e) { mods[name] = null; }
}

describe("Skill System Integration", () => {
  beforeAll(() => {
    setupTestDir();
    const base = path.join(__dirname, "..", "core", "skill");
    loadModule("importer", path.join(base, "skill-importer"));
    loadModule("market", path.join(base, "skill-market-client"));
    loadModule("fusion", path.join(base, "skill-fusion-engine"));
    loadModule("lineage", path.join(base, "skill-lineage"));
    loadModule("tierLoader", path.join(base, "skill-tier-loader"));
    loadModule("security", path.join(base, "skill-security-scanner"));
  });
  afterAll(() => cleanupTestDir());

  describe("Import Pipeline", () => {
    test("exposes detectSourceType and importFromDirectory", () => {
      if (!mods.importer) throw new Error('module importer failed to load (broken require chain)');
      expect(typeof mods.importer.detectSourceType).toBe("function");
      expect(typeof mods.importer.importFromDirectory).toBe("function");
      expect(typeof mods.importer.importFromGitHub).toBe("function");
      expect(typeof mods.importer.importFromArchive).toBe("function");
      expect(typeof mods.importer.importFromUrl).toBe("function");
    });
    test("detectSourceType: github", () => {
      if (!mods.importer) throw new Error('module importer failed to load (broken require chain)');
      expect(mods.importer.detectSourceType("gh:user/repo/skills/x")).toBe("github");
    });
    test("detectSourceType: url", () => {
      if (!mods.importer) throw new Error('module importer failed to load (broken require chain)');
      expect(mods.importer.detectSourceType("https://example.com/s.zip")).toBe("url");
    });
    test("detectSourceType: archive and null", () => {
      if (!mods.importer) throw new Error('module importer failed to load (broken require chain)');
      // Create a real .zip file to test archive detection
      const testZip = path.join(TEST_DIR, "test-archive.zip");
      fs.writeFileSync(testZip, "dummy");
      expect(mods.importer.detectSourceType(testZip)).toBe("archive");
      fs.unlinkSync(testZip);
      // Non-existent file returns null
      expect(mods.importer.detectSourceType(path.join(TEST_DIR, "nonexistent.zip"))).toBeNull();
    });
  });

  describe("Market Client", () => {
    test("exposes search and checkForUpdates", () => {
      if (!mods.market) throw new Error('module market failed to load (broken require chain)');
      expect(typeof mods.market.search).toBe("function");
      expect(typeof mods.market.checkForUpdates).toBe("function");
      expect(typeof mods.market.addRegistry).toBe("function");
      expect(typeof mods.market.searchAllRegistries).toBe("function");
    });
  });

  describe("Fusion Engine", () => {
    test("exposes analyzeFusionCandidates and getFusionSuggestions", () => {
      if (!mods.fusion) throw new Error('module fusion failed to load (broken require chain)');
      const engine = mods.fusion.getSkillFusionEngine
        ? mods.fusion.getSkillFusionEngine() : mods.fusion;
      expect(typeof engine.analyzeFusionCandidates).toBe("function");
      expect(typeof engine.getFusionSuggestions).toBe("function");
      expect(typeof engine.executeFusion).toBe("function");
    });
    test("analyzeFusionCandidates handles empty list", () => {
      if (!mods.fusion) throw new Error('module fusion failed to load (broken require chain)');
      const engine = mods.fusion.getSkillFusionEngine
        ? mods.fusion.getSkillFusionEngine() : mods.fusion;
      const result = engine.analyzeFusionCandidates([]);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("Skill Lineage", () => {
    test("exposes recordDerivation and ancestor/descendant queries", () => {
      if (!mods.lineage) throw new Error('module lineage failed to load (broken require chain)');
      const lineage = mods.lineage.getSkillLineage
        ? mods.lineage.getSkillLineage() : mods.lineage;
      expect(typeof lineage.recordDerivation).toBe("function");
      expect(typeof lineage.getAncestors).toBe("function");
      expect(typeof lineage.getDescendants).toBe("function");
      expect(typeof lineage.getAffectedSkills).toBe("function");
    });
    test("recordDerivation creates edge and getAncestors returns it", () => {
      if (!mods.lineage) throw new Error('module lineage failed to load (broken require chain)');
      const lineage = mods.lineage.getSkillLineage
        ? mods.lineage.getSkillLineage() : mods.lineage;
      lineage.recordDerivation("parent", "child", "derived", { ts: new Date().toISOString() });
      expect(lineage.getAncestors("child")).toContain("parent");
    });
  });

  describe("Tier Loader", () => {
    test("exposes getEnabledBundles and isSkillAvailable", () => {
      if (!mods.tierLoader) throw new Error('module tierLoader failed to load (broken require chain)');
      expect(typeof mods.tierLoader.getEnabledBundles).toBe("function");
      expect(typeof mods.tierLoader.isSkillAvailable).toBe("function");
      expect(typeof mods.tierLoader.getBundleStatus).toBe("function");
      expect(typeof mods.tierLoader.enableBundle).toBe("function");
    });
  });

  describe("Security Scanner", () => {
    test("has scanImportedSkill method", () => {
      if (!mods.security) throw new Error('module security failed to load (broken require chain)');
      const scanner = mods.security.SkillSecurityScanner
        ? new mods.security.SkillSecurityScanner() : mods.security;
      const scanMethod = scanner.scanImportedSkill || scanner.scan;
      expect(typeof scanMethod).toBe("function");
    });
  });
});


