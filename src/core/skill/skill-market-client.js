/**
 * Skill Market Client — 在线技能市场客户端
 *
 * 支持从多个注册中心发现和下载远程技能：
 *   - GitHub 仓库 (通过 GitHub API)
 *   - ClawHub (clawhub.io)
 *   - 自定义注册中心
 *
 * 注册中心配置从 config.yaml 读取:
 *   skillRegistries:
 *     - name: clawhub
 *       url: https://clawhub.io/api/v1
 *     - name: github-org
 *       url: gh:my-org/crabpaw-skills
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");



const BASE_DIR = path.join(__dirname, "..", "..", "..");

/**
 * 加载注册中心配置
 */
function _loadRegistryConfig() {
  const configs = [];

  // 尝试从 config.yaml 加载
  try {
    const yaml = require("yaml");
    const yamlPath = path.join(BASE_DIR, "config.yaml");
    if (fs.existsSync(yamlPath)) {
      const content = fs.readFileSync(yamlPath, "utf-8");
      const parsed = yaml.parse(content);
      if (parsed && parsed.skillRegistries && Array.isArray(parsed.skillRegistries)) {
        for (const reg of parsed.skillRegistries) {
          configs.push({
            name: reg.name || "unknown",
            url: reg.url || "",
            type: reg.type || (reg.url && reg.url.startsWith("gh:") ? "github" : reg.path ? "local" : "http"),
            path: reg.path || "",
            enabled: reg.enabled !== false,
          });
        }
      }
    }
  } catch (err) {

    // config.yaml 可能不可用

    console.warn('[skill-market-client.js] 空 catch 补日志:', err && err.message);
  }


  // 尝试从 config.json 加载
  try {
    const configPath = path.join(require('../config').DATA_DIR, "config.json"); // 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.skills && config.skills.registries && Array.isArray(config.skills.registries)) {
        for (const reg of config.skills.registries) {
          if (!configs.find((c) => c.name === reg.name)) {
            configs.push({
              name: reg.name || "unknown",
              url: reg.url || "",
              type: reg.type || (reg.url && reg.url.startsWith("gh:") ? "github" : reg.path ? "local" : "http"),
              path: reg.path || "",
              enabled: reg.enabled !== false,
            });
          }
        }
      }
    }
  } catch (err) {

    // config.json 可能不可用

    console.warn('[skill-market-client.js] 空 catch 补日志:', err && err.message);
  }


  // 默认注册中心
  if (configs.length === 0) {
    configs.push({
      name: "clawhub",
      url: "https://clawhub.io/api/v1",
      type: "http",
    });
    configs.push({
      name: "github-community",
      url: "gh:crabpaw-community/skills",
      type: "github",
    });
  }

  return configs;
}

/**
 * HTTP(S) GET 请求
 */
function _httpGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const protocol = url.protocol === "https:" ? https : http;

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "User-Agent": "crabpaw-skill-market-client",
        Accept: "application/json",
        ...headers,
      },
    };

    const req = protocol.request(options, (res) => {
      let body = "";

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _httpGet(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }

      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ raw: body });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`Request timeout: ${urlStr}`));
    });
    req.end();
  });
}

/**
 * 通过 GitHub 搜索注册中心搜索技能
 */
async function _searchGitHubRegistry(registry, query, options = {}) {
  const ghUrl = registry.url;
  let owner, repo;

  if (ghUrl.startsWith("gh:")) {
    const parts = ghUrl.slice(3).split("/");
    owner = parts[0];
    repo = parts[1];
  } else {
    return [];
  }

  try {
    // 使用 GitHub API 搜索仓库内容
    const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}+filename:SKILL.md`;

    const data = await _httpGet(apiUrl, {
      Accept: "application/vnd.github.v3+json",
    });

    if (!data || !data.items) return [];

    const results = [];
    for (const item of data.items.slice(0, options.limit || 20)) {
      const skillDir = path.dirname(item.path);
      const skillName = skillDir === "." ? repo : skillDir;

      results.push({
        id: `gh:${owner}/${repo}/${skillDir}`,
        name: skillName,
        registry: registry.name,
        source: `gh:${owner}/${repo}/${skillDir}`,
        path: item.path,
        score: item.score || 0,
      });
    }

    return results;
  } catch (err) {
    return [];
  }
}

/**
 * 通过 HTTP 注册中心搜索技能 (ClawHub API)
 */
async function _searchHttpRegistry(registry, query, options = {}) {
  try {
    const url = `${registry.url}/skills/search?q=${encodeURIComponent(query)}&limit=${options.limit || 20}`;

    const data = await _httpGet(url);

    if (!data || !data.skills) return [];

    return data.skills.map((skill) => ({
      id: skill.id || skill.slug,
      name: skill.name || skill.slug,
      description: skill.description || "",
      version: skill.version || "latest",
      registry: registry.name,
      source: skill.source || `${registry.url}/skills/${skill.slug}/download`,
      downloads: skill.downloads || 0,
      rating: skill.rating || 0,
    }));
  } catch (err) {
    return [];
  }
}

/**
 * 搜索技能
 * @param {string} query - 搜索关键词
 * @param {object} options - 选项 { limit, registry }
 * @returns {Promise<Array>} 技能列表
 */
async function search(query, options = {}) {
  const registries = _getAllActiveRegistries();
  const targetRegistries = options.registry
    ? registries.filter((r) => r.name === options.registry)
    : registries;

  const allResults = [];

  for (const registry of targetRegistries) {
    try {
      let results;
      if (registry.type === "github") {
        results = await _searchGitHubRegistry(registry, query, options);
      } else if (registry.type === "local") {
        results = await _searchLocalRegistry(registry, query, options);
      } else {
        results = await _searchHttpRegistry(registry, query, options);
      }
      allResults.push(...results);
    } catch (err) {

      // 跳过失败的注册中心

      console.warn('[skill-market-client.js] 空 catch 补日志:', err && err.message);
    }

  }

  return allResults;
}

/**
 * 获取技能详细信息
 * @param {string} skillId - 技能 ID (如 gh:user/repo/path 或 slug)
 * @returns {Promise<object|null>}
 */
async function getSkillInfo(skillId) {
  const registries = _loadRegistryConfig();

  for (const registry of registries) {
    try {
      if (registry.type === "github") {
        if (skillId.startsWith("gh:")) {
          const parts = skillId.slice(3).split("/");
          const owner = parts[0];
          const repo = parts[1];
          const subPath = parts.slice(2).join("/");

          const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${subPath || ""}`;
          const files = await _httpGet(apiUrl, {
            Accept: "application/vnd.github.v3+json",
          });

          if (Array.isArray(files) && files.length > 0) {
            const skillMdFile = files.find(
              (f) => f.name.toUpperCase() === "SKILL.MD"
            );
            return {
              id: skillId,
              name: subPath ? subPath.split("/").pop() : repo,
              registry: registry.name,
              source: skillId,
              files: files.map((f) => f.name),
              hasSkillMd: !!skillMdFile,
              size: files.reduce((sum, f) => sum + (f.size || 0), 0),
              updatedAt: files[0]._links ? null : null,
            };
          }
        }
      } else {
        // HTTP 注册中心
        const skillSlug = skillId.includes("/") ? skillId.split("/").pop() : skillId;
        const url = `${registry.url}/skills/${skillSlug}`;
        const data = await _httpGet(url);

        if (data && data.skill) {
          return {
            id: skillId,
            name: data.skill.name || data.skill.slug,
            description: data.skill.description || "",
            registry: registry.name,
            source: data.skill.source || "",
            version: data.skill.version || "latest",
            downloads: data.skill.downloads || 0,
            rating: data.skill.rating || 0,
            author: data.skill.author || "",
          };
        }
      }
    } catch (err) {

      // 尝试下一个注册中心

      console.warn('[skill-market-client.js] 空 catch 补日志:', err && err.message);
    }

  }

  return null;
}

/**
 * 获取技能版本列表
 * @param {string} skillId - 技能 ID
 * @returns {Promise<Array>}
 */
async function getVersions(skillId) {
      const registries = _loadRegistryConfig();
      for (const registry of registries) {
      try {
      if (registry.type === "github") {
      if (skillId.startsWith("gh:")) {
      const parts = skillId.slice(3).split("/");
      const owner = parts[0];
      const repo = parts[1];
      const subPath = parts.slice(2).join("/");
      // 获取 commits 作为版本历史
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(subPath || "")}&per_page=10`;
      const commits = await _httpGet(apiUrl, {
      Accept: "application/vnd.github.v3+json",
      });
      if (Array.isArray(commits)) {
      return commits.map((c) => ({
      version: c.sha ? c.sha.slice(0, 7) : "unknown",
      date: c.commit ? c.commit.author.date : null,
      message: c.commit ? c.commit.message.split("\n")[0] : "",
      author: c.commit ? c.commit.author.name : "",
      }));
      }
      }
      } else {
      const skillSlug = skillId.includes("/") ? skillId.split("/").pop() : skillId;
      const url = `${registry.url}/skills/${skillSlug}/versions`;
      const data = await _httpGet(url);
      if (data && data.versions) return data.versions;
      }
      } catch (err) {
        // 尝试下一个注册中心
        console.warn('[skill-market-client.js] 空 catch 补日志:', err && err.message);
      }
    }

  return [];
}

/**
 * 批量检查已安装技能的更新
 * @param {Array<{name: string, version: string}>} installedSkills
 * @returns {Promise<Array<{name: string, currentVersion: string, latestVersion: string, hasUpdate: boolean}>>}
 */
async function checkForUpdates(installedSkills) {
  const updates = [];

  for (const skill of installedSkills) {
    try {
      const info = await getSkillInfo(skill.name);
      if (info && info.version && info.version !== skill.version) {
        updates.push({
          name: skill.name,
          currentVersion: skill.version,
          latestVersion: info.version,
          hasUpdate: true,
          registry: info.registry,
        });
      }
    } catch (err) {

      // 跳过检查失败的技能

      console.warn('[skill-market-client.js] 空 catch 补日志:', err && err.message);
    }

  }

  return updates;
}

/**
 * 下载技能并返回路径
 * @param {string} skillId - 技能 ID
 * @param {string} version - 版本 (可选)
 * @returns {Promise<string|null>} 下载后的目录路径
 */
async function downloadSkill(skillId, _version) {
  const { importFromGitHub, importFromUrl, GLOBAL_SKILLS_DIR } = require("./skill-importer");

  if (skillId.startsWith("gh:")) {
    // GitHub 技能
    const result = await importFromGitHub(skillId);
    if (result.success) {
      return path.join(GLOBAL_SKILLS_DIR, result.skillName);
    }
    throw new Error(result.message);
  }

  // HTTP 注册中心下载
  const info = await getSkillInfo(skillId);
  if (info && info.source) {
    const result = await importFromUrl(info.source);
    if (result.success) {
      return path.join(GLOBAL_SKILLS_DIR, result.skillName);
    }
    throw new Error(result.message);
  }

  return null;
}

/**
 * 获取本地已安装技能列表及其版本信息
 */
function _getInstalledSkills() {
  const GLOBAL_SKILLS_DIR = path.join(BASE_DIR, "data", "skills");
  const skills = [];

  if (!fs.existsSync(GLOBAL_SKILLS_DIR)) return skills;

  try {
    const entries = fs.readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(GLOBAL_SKILLS_DIR, entry.name);
      const skillMdPath = path.join(skillDir, "SKILL.md");
      const metaPath = path.join(skillDir, "_meta.json");

      let version = "unknown";
      let sourceType = "local";

      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          version = meta.version || "unknown";
          sourceType = meta.sourceType || "local";
        } catch (e) {
          /* ignore */
          console.warn('[skill-market-client.js] 空 catch 补日志:', e && e.message);
        }

      }

      skills.push({
        name: entry.name,
        version,
        sourceType,
        hasSkillMd: fs.existsSync(skillMdPath),
      });
    }
  } catch (err) {

    // ignore

    console.warn('[skill-market-client.js] 空 catch 补日志:', err && err.message);
  }


  return skills;
}


// ============================================================
// Runtime registry management
// ============================================================

/** @type {Array<{name: string, type: string, url: string, path: string, enabled: boolean}>} */
let _runtimeRegistries = [];

/**
 * 添加运行时注册中心
 * @param {object} registryConfig - { name, type, url, path, enabled }
 */
function addRegistry(registryConfig) {
  if (!registryConfig || !registryConfig.name) {
    throw new Error("Registry config must have a 'name' field");
  }

  // 删除同名旧注册中心
  removeRegistry(registryConfig.name);

  const registry = {
    name: registryConfig.name,
    type: registryConfig.type || "http",
    url: registryConfig.url || "",
    path: registryConfig.path || "",
    enabled: registryConfig.enabled !== false,
  };

  _runtimeRegistries.push(registry);
  return registry;
}

/**
 * 移除运行时注册中心
 * @param {string} name
 * @returns {boolean} 是否移除成功
 */
function removeRegistry(name) {
  const idx = _runtimeRegistries.findIndex(r => r.name === name);
  if (idx >= 0) {
    _runtimeRegistries.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * 列出所有注册中心（配置 + 运行时）
 * @returns {Array<{name: string, type: string, url: string, path: string, source: string}>}
 */
function listRegistries() {
  const configRegistries = _loadRegistryConfig();
  const all = [];

  for (const r of configRegistries) {
    all.push({
      ...r,
      source: "config",
    });
  }

  for (const r of _runtimeRegistries) {
    if (!all.find(a => a.name === r.name)) {
      all.push({
        ...r,
        source: "runtime",
      });
    }
  }

  return all;
}

/**
 * 获取所有活跃的注册中心
 */
function _getAllActiveRegistries() {
  const configRegistries = _loadRegistryConfig().filter(r => r.enabled !== false);
  const all = [...configRegistries];

  for (const r of _runtimeRegistries) {
    if (r.enabled === false) continue;
    const idx = all.findIndex(a => a.name === r.name);
    if (idx >= 0) {
      all[idx] = r; // 运行时覆盖配置
    } else {
      all.push(r);
    }
  }

  return all;
}

/**
 * 跨所有注册中心并行搜索
 * @param {string} query
 * @param {object} options - { limit, dedupe }
 * @returns {Promise<Array>}
 */
async function searchAllRegistries(query, options = {}) {
  const registries = _getAllActiveRegistries();
  const limit = options.limit || 20;
  const dedupe = options.dedupe !== false; // 默认去重

  const searchTasks = registries.map(registry => {
    return (async () => {
      try {
        if (registry.type === "github") {
          return await _searchGitHubRegistry(registry, query, { limit });
        } else if (registry.type === "local") {
          return await _searchLocalRegistry(registry, query, { limit });
        } else {
          return await _searchHttpRegistry(registry, query, { limit });
        }
      } catch (err) {
        return [];
      }
    })();
  });

  const resultsArrays = await Promise.all(searchTasks);
  let allResults = resultsArrays.flat();

  // 去重（按名称合并）
  if (dedupe) {
    const seen = new Set();
    const deduped = [];
    for (const r of allResults) {
      const key = r.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }
    allResults = deduped;
  }

  return allResults.slice(0, limit);
}

/**
 * 搜索本地目录注册中心
 */
async function _searchLocalRegistry(registry, query, options = {}) {
  const results = [];
  const searchDir = registry.path;

  if (!searchDir || !fs.existsSync(searchDir)) return results;

  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const queryLower = query.toLowerCase();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(searchDir, entry.name);
      const skillMdPath = path.join(skillDir, "SKILL.md");

      let description = "";
      let version = "unknown";

      if (fs.existsSync(skillMdPath)) {
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fm) {
          const lines = fm[1].split("\n");
          for (const line of lines) {
            const ci = line.indexOf(":");
            if (ci > 0) {
              const key = line.slice(0, ci).trim();
              const val = line.slice(ci + 1).trim().replace(/^["']|["']$/g, "");
              if (key === "description") description = val;
              if (key === "version") version = val;
            }
          }
        }
      }

      // 模糊匹配名称和描述
      if (
        queryLower === "" ||
        entry.name.toLowerCase().includes(queryLower) ||
        description.toLowerCase().includes(queryLower)
      ) {
        results.push({
          id: `local:${registry.name}/${entry.name}`,
          name: entry.name,
          description,
          version,
          registry: registry.name,
          source: `local:${registry.name}/${entry.name}`,
          localPath: skillDir,
        });
      }

      if (results.length >= (options.limit || 20)) break;
    }
  } catch (err) {
    // 跳过失败的本地注册中心
  }

  return results;
}

module.exports = {
  search,
  getSkillInfo,
  getVersions,
  checkForUpdates,
  downloadSkill,
  getInstalledSkills: _getInstalledSkills,
  addRegistry,
  removeRegistry,
  listRegistries,
  searchAllRegistries,
  _loadRegistryConfig,
};



