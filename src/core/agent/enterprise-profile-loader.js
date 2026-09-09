/**
 * Enterprise Profile Loader - 企业级 Agent 配置档案加载器
 *
 * 从工作区目录加载企业级 agent profile 配置，
 * 并将其应用到 domain registry 中。
 */

const fs = require('fs');
const path = require('path');

class EnterpriseProfileLoader {
  constructor(config = {}) {
    this.workspaceDir = config.workspaceDir || process.cwd();
    this._profiles = [];
    this._loadProfiles();
  }

  _loadProfiles() {
    const profileDir = path.join(this.workspaceDir, '.crabpaw', 'profiles');
    if (!fs.existsSync(profileDir)) return;

    try {
      const files = fs.readdirSync(profileDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(profileDir, file), 'utf-8'));
        this._profiles.push(data);
      }
    } catch (e) {
      console.warn('[enterprise-profile-loader] profile dir read failed:', e.message);
    }
  }

  applyToDomainRegistry(domainRegistry) {
    if (!domainRegistry) return;

    for (const profile of this._profiles) {
      try {
        if (profile.domains && Array.isArray(profile.domains)) {
          for (const domain of profile.domains) {
            domainRegistry.registerDomain(domain);
          }
        }
        if (profile.constraints) {
          domainRegistry.setConstraints(profile.id, profile.constraints);
        }
      } catch (e) {
        console.warn('[enterprise-profile-loader] single profile apply failed:', e.message);
      }
    }
  }

  getProfiles() {
    return this._profiles.slice();
  }
}

module.exports = { EnterpriseProfileLoader };
