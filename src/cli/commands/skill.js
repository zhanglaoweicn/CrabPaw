/**
 * CLI 命令 - 技能管理
 *
 * 子命令:
 *   skill import <source>  从 GitHub/URL/压缩包/目录导入技能
 *   skill list             列出所有已安装技能及来源标签
 *   skill info <name>      显示技能详细信息
 *   skill search <query>   搜索在线技能市场
 *   skill updates          检查已安装技能的更新
 */

const path = require("path");
const fs = require("fs");

const BASE_DIR = path.join(__dirname, "..", "..", "..");
const GLOBAL_SKILLS_DIR = path.join(BASE_DIR, "data", "skills");

async function handleSkillCommand(args) {
  const subCommand = args[0];

  switch (subCommand) {
    case "import":
      await handleSkillImport(args.slice(1));
      break;
    case "list":
      await handleSkillList(args.slice(1));
      break;
    case "info":
      await handleSkillInfo(args.slice(1));
      break;
    case "search":
      await handleSkillSearch(args.slice(1));
      break;
    case "updates":
      await handleSkillUpdates(args.slice(1));
      break;

    case "fuse":
      await handleSkillFuse(args.slice(1));
      break;
    case "suggest-fusions":
      await handleSkillSuggestFusions(args.slice(1));
      break;
    case "fusion-history":
      await handleSkillFusionHistory(args.slice(1));
      break;
    default:
      printSkillHelp();
  }
}

/**
 * crabpaw skill import <source>
 */
async function handleSkillImport(args) {
  if (!args || args.length === 0) {
    console.log("Usage: crabpaw skill import <source>");
    console.log("");
    console.log("Sources:");
    console.log("  gh:user/repo/path        GitHub repository path");
    console.log("  https://...              Direct download URL");
    console.log("  path/to/skill.zip        Local .zip archive");
    console.log("  path/to/skill.tar.gz     Local .tar.gz archive");
    console.log("  path/to/skill/dir        Local directory");
    return;
  }

  const source = args[0];
  const { importFromGitHub, importFromUrl, importFromArchive, importFromDirectory, detectSourceType } =
    require("../../core/skill/skill-importer");

  const sourceType = detectSourceType(source);

  if (!sourceType) {
    console.log(`Error: Cannot determine source type for: ${source}`);
    console.log("Supported: gh:..., https://..., .zip, .tar.gz, directory");
    return;
  }

  console.log(`Importing from ${sourceType}: ${source}...`);

  let result;
  switch (sourceType) {
    case "github":
      result = await importFromGitHub(source);
      break;
    case "url":
      result = await importFromUrl(source);
      break;
    case "archive":
      result = await importFromArchive(source);
      break;
    case "directory":
      result = await importFromDirectory(source);
      break;
  }

  if (result.success) {
    console.log(`\n[OK] ${result.message}`);
  } else {
    console.log(`\n[FAIL] ${result.message}`);
  }

  if (result.warnings && result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of result.warnings) {
      console.log(`  - ${w}`);
    }
  }
}

/**
 * crabpaw skill list
 */
async function handleSkillList(args) {
  if (!fs.existsSync(GLOBAL_SKILLS_DIR)) {
    console.log("No skills installed.");
    return;
  }

  const entries = fs.readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true });
  const skills = [];

  // 加载来源信息
  let provenance = null;
  try {
    provenance = require("../../core/skill/skill-provenance");
    const provenancePath = path.join(
      path.dirname(GLOBAL_SKILLS_DIR),
      ".crabpaw",
      "skill-provenance.json"
    );
    provenance.initialize(provenancePath);
  } catch (e) {

    // provenance 可能未初始化

    console.warn('[skill.js] 空 catch 补日志:', e && e.message);
  }


  const verbose = args.includes("--verbose") || args.includes("-v");

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(GLOBAL_SKILLS_DIR, entry.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const metaPath = path.join(skillDir, "_meta.json");
    let version = "?";
    let description = "";
    let sourceType = "local";
    let sourceUrl = "";
    let originTag = "";
    // 读取元数据
    if (fs.existsSync(metaPath)) {
    try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    version = meta.version || "?";
    sourceType = meta.sourceType || "local";
    sourceUrl = meta.sourceUrl || "";
    } catch (e) {
      /* ignore */
      console.warn('[skill.js] 空 catch 补日志:', e && e.message);
    }
  }

    // 读取 SKILL.md
    if (fs.existsSync(skillMdPath)) {
      try {
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fm) {
          const lines = fm[1].split("\n");
          for (const line of lines) {
            const ci = line.indexOf(":");
            if (ci > 0) {
              const key = line.slice(0, ci).trim();
              const val = line.slice(ci + 1).trim().replace(/^["']|["']$/g, "");
              if (key === "description") description = val.slice(0, 60);
              if (key === "version") version = val;
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    // 获取来源标签
    if (provenance) {
      const origin = provenance.getProvenance(entry.name);
      const tagMap = {
        foreground: "[user]",
        background_review: "[auto]",
        bundled: "[builtin]",
        hub_installed: "[market]",
      };
      originTag = tagMap[origin] || `[${origin}]`;
    }

    skills.push({
      name: entry.name,
      version,
      sourceType,
      sourceUrl,
      originTag,
      description,
    });
  }

  // 排序
  skills.sort((a, b) => a.name.localeCompare(b.name));

  if (skills.length === 0) {
    console.log("No skills installed.");
    return;
  }

  console.log(`\nInstalled Skills (${skills.length}):`);
  console.log("");

  if (verbose) {
    // 详细输出
    for (const skill of skills) {
      console.log(`  ${skill.name}`);
      console.log(`    Version:  ${skill.version}`);
      console.log(`    Source:   ${skill.originTag} ${skill.sourceType}`);
      if (skill.sourceUrl) console.log(`    URL:      ${skill.sourceUrl}`);
      if (skill.description) console.log(`    Desc:     ${skill.description}`);
      console.log("");
    }
  } else {
    // 紧凑表格输出
    const nameWidth = Math.max(...skills.map((s) => s.name.length), 8) + 2;
    const verWidth = 10;
    const tagWidth = 12;

    const header = `  ${"Name".padEnd(nameWidth)}${"Version".padEnd(verWidth)}${"Source".padEnd(tagWidth)}`;
    console.log(header);
    console.log(`  ${"-".repeat(nameWidth + verWidth + tagWidth)}`);

    for (const skill of skills) {
      const nameCol = skill.name.padEnd(nameWidth);
      const verCol = skill.version.padEnd(verWidth);
      const tagCol = skill.originTag.padEnd(tagWidth);
      console.log(`  ${nameCol}${verCol}${tagCol}`);
    }
  }

  console.log(`\nUse "crabpaw skill info <name>" for details.`);
}

/**
 * crabpaw skill info <name>
 */
async function handleSkillInfo(args) {
  if (!args || args.length === 0) {
    console.log("Usage: crabpaw skill info <name>");
    return;
  }

  const skillName = args[0];
  const skillDir = path.join(GLOBAL_SKILLS_DIR, skillName);

  if (!fs.existsSync(skillDir)) {
    console.log(`Skill not found: ${skillName}`);
    return;
  }

  console.log(`\nSkill: ${skillName}`);
  console.log(`${"─".repeat(50)}`);

  // SKILL.md 信息
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);

    if (fm) {
      console.log("Frontmatter:");
      const lines = fm[1].split("\n");
      for (const line of lines) {
        const ci = line.indexOf(":");
        if (ci > 0) {
          const key = line.slice(0, ci).trim();
          const val = line.slice(ci + 1).trim();
          console.log(`  ${key}: ${val}`);
        }
      }
    } else {
      console.log("Frontmatter: (none)");
    }
  } else {
    console.log("SKILL.md: NOT FOUND");
  }

  // _meta.json
  const metaPath = path.join(skillDir, "_meta.json");
  if (fs.existsSync(metaPath)) {
    console.log("\nMetadata (_meta.json):");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      for (const [key, value] of Object.entries(meta)) {
        console.log(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
      }
    } catch (e) {
      console.log("  (parse error)");
    }
  }

  // 来源
  try {
    const provenance = require("../../core/skill/skill-provenance");
    const origin = provenance.getProvenance(skillName);
    console.log(`\nProvenance: ${origin}`);
  } catch (e) {
    // ignore
  }

  // 文件列表
  console.log("\nFiles:");
  const listFiles = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(skillDir, fullPath);
      if (entry.isDirectory()) {
        console.log(`  ${prefix}${relPath}/`);
        listFiles(fullPath, prefix + "  ");
      } else {
        const stat = fs.statSync(fullPath);
        const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
        console.log(`  ${prefix}${relPath} (${size})`);
      }
    }
  };
  listFiles(skillDir, "");

  console.log("");
}

/**
 * crabpaw skill search <query>
 */
async function handleSkillSearch(args) {
  if (!args || args.length === 0) {
    console.log("Usage: crabpaw skill search <query> [--registry <name>] [--limit <n>]");
    return;
  }

  const query = args.filter((a) => !a.startsWith("--")).join(" ");
  const registryIdx = args.indexOf("--registry");
  const limitIdx = args.indexOf("--limit");

  const options = {};
  if (registryIdx >= 0 && registryIdx + 1 < args.length) {
    options.registry = args[registryIdx + 1];
  }
  if (limitIdx >= 0 && limitIdx + 1 < args.length) {
    options.limit = parseInt(args[limitIdx + 1], 10) || 20;
  }

  const { search } = require("../../core/skill/skill-market-client");

  console.log(`Searching for "${query}"...`);
  const results = await search(query, options);

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`\nResults (${results.length}):`);
  console.log("");

  for (const result of results) {
    console.log(`  ${result.name}`);
    console.log(`    Registry: ${result.registry}`);
    console.log(`    Source:   ${result.source}`);
    if (result.description) console.log(`    Desc:     ${result.description}`);
    if (result.version) console.log(`    Version:  ${result.version}`);
    if (result.rating) console.log(`    Rating:   ${"★".repeat(Math.round(result.rating))}`);
    console.log("");
  }

  console.log(`Use "crabpaw skill import ${results[0]?.source || '<source>'}" to install.`);
}

/**
 * crabpaw skill updates
 */
async function handleSkillUpdates(_args) {
  console.log("Checking for skill updates...");
  try {
    const { checkAllUpdates } = require("../../core/skill/skill-market-client");
    const results = await checkAllUpdates();
    if (!results || results.length === 0) {
      console.log("All skills are up to date.");
      return;
    }
    for (const r of results) {
      if (r.updateAvailable) {
        console.log(`  ${r.name}: ${r.currentVersion} → ${r.latestVersion}`);
      }
    }
  } catch (e) {
    console.log("Update check failed:", e.message);
  }
}

/**
 * crabpaw skill fuse <skillA> <skillB>
 */
async function handleSkillFuse(args) {
  if (!args || args.length < 2) {
    console.log("Usage: crabpaw skill fuse <skillA> <skillB>");
    console.log("");
    console.log("Options:");
    console.log("  --dry-run    Show fusion plan without executing");
    console.log("  --yes        Skip confirmation prompt");
    return;
  }

  const dryRun = args.includes("--dry-run");
  const skipConfirm = args.includes("--yes");
  const skillNames = args.filter(a => !a.startsWith("--"));

  if (skillNames.length < 2) {
    console.log("Usage: crabpaw skill fuse <skillA> <skillB>");
    return;
  }

  const skillA = skillNames[0];
  const skillB = skillNames[1];

  if (skillA === skillB) {
    console.log("Error: Cannot fuse a skill with itself.");
    return;
  }

  const { getSkillFusionEngine } = require("../../core/skill/skill-fusion-engine");
  const engine = getSkillFusionEngine();
  engine.initialize();

  console.log(`Analyzing fusion of "${skillA}" + "${skillB}"...`);

  const skillsList = engine._collectInstalledSkills();
  const skillAData = skillsList.find(s => s.name === skillA);
  const skillBData = skillsList.find(s => s.name === skillB);

  if (!skillAData) {
    console.log(`Error: Skill "${skillA}" not found.`);
    return;
  }
  if (!skillBData) {
    console.log(`Error: Skill "${skillB}" not found.`);
    return;
  }

  // 检查候选评分
  const candidates = engine.analyzeFusionCandidates(skillsList);
  const candidate = candidates.find(
    c => (c.skillA === skillA && c.skillB === skillB) ||
         (c.skillA === skillB && c.skillB === skillA)
  );

  if (candidate) {
    console.log(`\n  Fusion score: ${candidate.score}`);
    console.log(`  Co-occurrence: ${candidate.signals.cooccurrenceCount}x (strength: ${candidate.signals.cooccurrenceStrength})`);
    console.log(`  Jaccard similarity: ${candidate.signals.jaccardSimilarity}`);
    console.log(`  Reason: ${engine._buildReasonString(candidate.signals)}`);
  }

  // 生成融合计划
  console.log(`\nGenerating fusion plan...`);
  let llmClient = null;
  try {
    // 2026-09-03 P3 接缝收敛: llm-client.js stub 删除——其 chat() 与引擎要求的 complete()
    // 接口从不匹配, LLM 增强路径此前恒走 _generateBasicPlan 兜底。改走 auxiliary-client
    // 既有管线(TASK_TYPES.SKILL_MERGE 早已预置但从未接线); 未配置 provider 时保持 null。
    const { getAuxiliaryClient, TASK_TYPES } = require("../../core/auxiliary-client");
    const aux = getAuxiliaryClient();
    if (aux.resolveProvider(TASK_TYPES.SKILL_MERGE)) {
      llmClient = {
        complete: async (prompt) => {
          try {
            const result = await aux.callLlm({
              taskType: TASK_TYPES.SKILL_MERGE,
              messages: [{ role: "user", content: prompt }],
              maxTokens: 2000,
              temperature: 0.3,
            });
            return (result && result.content) || "";
          } catch (e) {
            console.warn("[skill] fusion LLM 调用失败, 回退基础计划:", e.message);
            return "";
          }
        },
      };
    }
  } catch (e) {
    // LLM not available
  }

  const plan = await engine.generateFusionPlan(skillAData, skillBData, llmClient);

  console.log(`\nFusion Plan:`);
  console.log(`  Combined name: ${plan.combinedName}`);
  console.log(`  Description:   ${plan.description}`);
  console.log(`  Synergy:       ${plan.synergy}`);

  if (dryRun) {
    console.log("\n[Dry run] Fusion plan shown above. Use without --dry-run to execute.");
    return;
  }

  if (!skipConfirm) {
    const readline = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise(resolve => {
      readline.question("\nExecute this fusion? Old skills will be archived. [y/N] ", resolve);
    });
    readline.close();
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Fusion cancelled.");
      return;
    }
  }

  const result = engine.executeFusion(plan);

  console.log(`\n[OK] Fusion complete!`);
  console.log(`  New skill:  ${result.newSkillName}`);
  console.log(`  Location:   ${result.newSkillPath}`);
  if (result.archivedPaths.length > 0) {
    console.log(`  Archived:   ${result.archivedPaths.join(", ")}`);
  }
}

/**
 * crabpaw skill suggest-fusions
 */
async function handleSkillSuggestFusions(args) {
  const limitIdx = args.indexOf("--limit");
  const limit = (limitIdx >= 0 && limitIdx + 1 < args.length) ? parseInt(args[limitIdx + 1], 10) || 10 : 10;

  const { getSkillFusionEngine } = require("../../core/skill/skill-fusion-engine");
  const engine = getSkillFusionEngine();
  engine.initialize();

  console.log("Analyzing skill fusion candidates...");
  const suggestions = engine.getFusionSuggestions(limit);

  if (suggestions.length === 0) {
    console.log("No fusion candidates found. Install more skills to enable fusion suggestions.");
    return;
  }

  console.log(`\nTop ${suggestions.length} Fusion Candidates:`);
  console.log("");

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    console.log(`  ${i + 1}. ${s.skillA} + ${s.skillB}`);
    console.log(`     Score:  ${s.score}  |  ${s.reason}`);
    console.log("");
  }

  console.log(`Use "crabpaw skill fuse <skillA> <skillB>" to execute a fusion.`);
}

/**
 * crabpaw skill fusion-history
 */
async function handleSkillFusionHistory(_args) {
  const { getSkillFusionEngine } = require("../../core/skill/skill-fusion-engine");
  const engine = getSkillFusionEngine();
  engine.initialize();

  const history = engine.getFusionHistory();

  if (history.length === 0) {
    console.log("No fusions have been performed yet.");
    return;
  }

  console.log(`\nFusion History (${history.length}):`);
  console.log("");

  for (const record of history) {
    console.log(`  ${record.id}`);
    console.log(`    Parents:   ${(record.parents || []).join(" + ")}`);
    console.log(`    Result:    ${record.combinedName}`);
    console.log(`    Date:      ${record.timestamp}`);
    if (record.description) console.log(`    Desc:      ${record.description}`);
    if (record.score != null) console.log(`    Score:     ${record.score}`);
    console.log("");
  }
}

  // eslint-disable-next-line no-unused-vars
  async function _handleSkillMarketCommand(args) {
  const { checkForUpdates, getInstalledSkills } = require("../../core/skill/skill-market-client");

  const installed = getInstalledSkills();
  if (installed.length === 0) {
    console.log("No skills installed.");
    return;
  }

  console.log("Checking for updates...");
  const updates = await checkForUpdates(installed);

  if (updates.length === 0) {
    console.log("All skills are up to date.");
  } else {
    console.log(`\nUpdates available (${updates.length}):`);
    for (const u of updates) {
      console.log(`  ${u.name}: ${u.currentVersion} → ${u.latestVersion} (${u.registry})`);
    }
  }
}

function printSkillHelp() {
  console.log(`
Skill Management Commands:

  skill import <source>    Import a skill from GitHub, URL, archive, or directory
  skill list [-v]          List all installed skills
  skill info <name>        Show detailed info for a skill
  skill search <query>     Search the online skill market
  skill updates            Check for skill updates
  skill fuse <A> <B>      Fuse two skills into one combined skill
  skill suggest-fusions   List top fusion candidates
  skill fusion-history    Show past fusion operations

Import Sources:
  gh:user/repo/path        GitHub repository
  https://url/to/skill     Direct download URL
  path/to/skill.zip        Local .zip archive
  path/to/skill.tar.gz     Local .tar.gz archive
  path/to/skill/dir        Local directory

Examples:
  crabpaw skill import gh:crabpaw-community/skills/data-analysis
  crabpaw skill import https://example.com/skill.zip
  crabpaw skill import ./my-skill/
  crabpaw skill list -v
  crabpaw skill info data-analysis
  crabpaw skill search "pdf converter"
`);
}

module.exports = {
  handleSkillCommand,
};

