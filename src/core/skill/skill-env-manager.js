const BLOCKED_EVERYWHERE_KEYS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYLIB',
  'RUBYOPT',
  'BASH_ENV',
  'ENV',
  'BROWSER',
  'GIT_EDITOR',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_EXEC_PATH',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_SEQUENCE_EDITOR',
  'GIT_TEMPLATE_DIR',
  'GIT_SSL_NO_VERIFY',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'CC',
  'CXX',
  'CARGO_BUILD_RUSTC',
  'CARGO_BUILD_RUSTC_WRAPPER',
  'RUSTC_WRAPPER',
  'CMAKE_C_COMPILER',
  'CMAKE_CXX_COMPILER',
  'SHELL',
  'SHELLOPTS',
  'PS4',
  'GCONV_PATH',
  'IFS',
  'SSLKEYLOGFILE',
  'JAVA_OPTS',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'PYTHONBREAKPOINT',
  'DOTNET_STARTUP_HOOKS',
  'DOTNET_ADDITIONAL_DEPS',
  'GLIBC_TUNABLES',
  'MAVEN_OPTS',
  'MAKEFLAGS',
  'MFLAGS',
  'SBT_OPTS',
  'GRADLE_OPTS',
  'ANT_OPTS',
  'HGRCPATH',
  'EXINIT',
  'VIMINIT',
  'MYVIMRC',
  'GVIMINIT',
  'LUA_INIT',
  'LUA_INIT_5_1',
  'LUA_INIT_5_2',
  'LUA_INIT_5_3',
  'LUA_INIT_5_4',
  'EMACSLOADPATH',
  'RUBYSHELL',
  'GIT_HOOK_PATH',
  'SVN_EDITOR',
  'SVN_SSH',
  'BZR_EDITOR',
  'BZR_SSH',
  'BZR_PLUGIN_PATH',
  'SUDO_ASKPASS',
  'JULIA_EDITOR',
  'CONFIG_SITE',
  'CONFIG_SHELL',
  'CMAKE_TOOLCHAIN_FILE',
  'CATALINA_OPTS',
  'CORECLR_PROFILER',
  'HELM_PLUGINS',
  'PACKER_PLUGIN_PATH',
  'VAGRANT_VAGRANTFILE',
  'ERL_AFLAGS',
  'ERL_FLAGS',
  'ERL_ZFLAGS',
  'ELIXIR_ERL_OPTIONS',
  'R_ENVIRON',
  'R_PROFILE',
  'R_ENVIRON_USER',
  'R_PROFILE_USER',
  'HOSTALIASES',
  'OPENSSL_CONF',
  'OPENSSL_ENGINES',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PSMODULEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'HOMEPATH',
  'HOMEDRIVE',
  'LOGONSERVER',
  'USERDOMAIN',
  'USERDNSDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'ALLUSERSPROFILE',
  'COMPUTERNAME',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'TEMP',
  'TMP',
  'SYSTEMDRIVE',
];

const BLOCKED_OVERRIDE_ONLY_KEYS = [
  'HOME',
  'GRADLE_USER_HOME',
  'ZDOTDIR',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_PROXY_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'LESSOPEN',
  'LESSCLOSE',
  'PAGER',
  'MANPAGER',
  'GIT_PAGER',
  'EDITOR',
  'VISUAL',
  'FCEDIT',
  'SUDO_EDITOR',
  'PROMPT_COMMAND',
  'HISTFILE',
  'PERL5DB',
  'PERL5DBCMD',
  'PYTHONSTARTUP',
  'WGETRC',
  'CURL_HOME',
  'CLASSPATH',
  'CFLAGS',
  'CGO_CFLAGS',
  'CGO_LDFLAGS',
  'GOFLAGS',
  'CORECLR_PROFILER_PATH',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'DENO_DIR',
  'BUN_CONFIG_REGISTRY',
  'YARN_RC_FILENAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'PIP_INDEX_URL',
  'PIP_PYPI_URL',
  'PIP_EXTRA_INDEX_URL',
  'PIP_CONFIG_FILE',
  'PIP_FIND_LINKS',
  'PIP_TRUSTED_HOST',
  'UV_INDEX',
  'UV_INDEX_URL',
  'UV_PYTHON',
  'UV_EXTRA_INDEX_URL',
  'UV_DEFAULT_INDEX',
  'DOCKER_CONTEXT',
  'LIBRARY_PATH',
  'LDFLAGS',
  'CPATH',
  'C_INCLUDE_PATH',
  'CPLUS_INCLUDE_PATH',
  'OBJC_INCLUDE_PATH',
  'GOPROXY',
  'GONOSUMCHECK',
  'GONOSUMDB',
  'GONOPROXY',
  'GOPRIVATE',
  'GOENV',
  'GOPATH',
  'PYTHONUSERBASE',
  'RUSTFLAGS',
  'CARGO_HOME',
  'VIRTUAL_ENV',
  'LUA_PATH',
  'LUA_CPATH',
  'GEM_HOME',
  'GEM_PATH',
  'BUNDLE_GEMFILE',
  'COMPOSER_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CONFIG_DIRS',
  'AWS_CONFIG_FILE',
  'KUBECONFIG',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AZURE_AUTH_LOCATION',
  'HELM_HOME',
  'ANSIBLE_CONFIG',
  'ANSIBLE_LIBRARY',
  'ANSIBLE_CALLBACK_PLUGINS',
  'ANSIBLE_COLLECTIONS_PATH',
  'ANSIBLE_CONNECTION_PLUGINS',
  'ANSIBLE_FILTER_PLUGINS',
  'ANSIBLE_INVENTORY_PLUGINS',
  'ANSIBLE_LOOKUP_PLUGINS',
  'ANSIBLE_MODULE_UTILS',
  'ANSIBLE_REMOTE_TEMP',
  'ANSIBLE_ROLES_PATH',
  'ANSIBLE_STRATEGY_PLUGINS',
  'R_LIBS_USER',
  'TF_CLI_CONFIG_FILE',
  'TF_PLUGIN_CACHE_DIR',
  'AMQP_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SECURITY_TOKEN',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'DATABASE_URL',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'MONGODB_URI',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'REDIS_URL',
  'SSH_AUTH_SOCK',
];

const BLOCKED_PREFIXES = ['DYLD_', 'LD_', 'BASH_FUNC_'];
const BLOCKED_OVERRIDE_PREFIXES = ['GIT_CONFIG_', 'NPM_CONFIG_', 'CARGO_REGISTRIES_', 'TF_VAR_'];
const BLOCKED_NODE_PREFIXES = ['NODE_'];
const BLOCKED_NPM_PREFIXES = ['NPM_'];
const BLOCKED_PYTHON_PREFIXES = ['PYTHON'];
const BLOCKED_JAVA_PREFIXES = ['JAVA_'];
const BLOCKED_DOTNET_PREFIXES = ['DOTNET_'];
const BLOCKED_VSCODE_PREFIXES = ['VSCODE_'];

const DANGEROUS_HOST_ENV_VARS = new Set(
  [...BLOCKED_EVERYWHERE_KEYS, ...BLOCKED_OVERRIDE_ONLY_KEYS].map(k => k.toUpperCase())
);

function isDangerousHostEnvVarName(name) {
  if (!name || typeof name !== 'string') return true;
  const upper = name.toUpperCase();
  if (DANGEROUS_HOST_ENV_VARS.has(upper)) return true;
  for (const prefix of BLOCKED_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of BLOCKED_OVERRIDE_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of BLOCKED_NODE_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of BLOCKED_NPM_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of BLOCKED_PYTHON_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of BLOCKED_JAVA_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of BLOCKED_DOTNET_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of BLOCKED_VSCODE_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

function isDangerousHostEnvOverrideVarName(name) {
  if (!name || typeof name !== 'string') return true;
  if (isDangerousHostEnvVarName(name)) return true;
  const upper = name.toUpperCase();
  for (const prefix of BLOCKED_OVERRIDE_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

function validateEnvVarValue(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.includes('\0')) return 'Contains null bytes';
  if (value.length > 32768) return 'Value exceeds maximum length';
  return null;
}

function sanitizeEnvVars(env) {
  if (!env || typeof env !== 'object') return { allowed: {}, blocked: [], warnings: [] };
  const allowed = {};
  const blocked = [];
  const warnings = [];
  for (const [key, value] of Object.entries(env)) {
    const warning = validateEnvVarValue(value);
    if (warning) {
      if (warning === 'Contains null bytes') {
        blocked.push(key);
        continue;
      }
      warnings.push(`${key}: ${warning}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      blocked.push(key);
      continue;
    }
    if (isDangerousHostEnvVarName(key)) {
      blocked.push(key);
      continue;
    }
    allowed[key] = value;
  }
  return { allowed, blocked, warnings };
}

class SkillEnvManager {
  constructor() {
    this._refCounts = new Map();
    this._originalValues = new Map();
    this._activeOverrides = new Map();
  }

  activate(skillName, envSpec) {
    if (!envSpec || typeof envSpec !== 'object') return [];

    const envVars = [];
    const primaryEnv = envSpec.primaryEnv || [];
    const requires = envSpec.requires?.env || [];
    const allVars = [...new Set([...primaryEnv, ...requires])];

    for (const varName of allVars) {
      if (isDangerousHostEnvVarName(varName)) {
        continue;
      }

      const value = process.env[varName];
      if (value === undefined) continue;

      const key = varName.toUpperCase();
      const currentCount = this._refCounts.get(key) || 0;
      this._refCounts.set(key, currentCount + 1);

      if (currentCount === 0) {
        this._originalValues.set(key, process.env[key]);
        this._activeOverrides.set(key, { value, source: skillName });
        process.env[key] = value;
      }

      envVars.push({ name: varName, value });
    }

    return envVars;
  }

  deactivate(_skillName) {
    for (const [key, count] of this._refCounts.entries()) {
      if (count <= 1) {
        this._refCounts.delete(key);
        const original = this._originalValues.get(key);
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
        this._originalValues.delete(key);
        this._activeOverrides.delete(key);
      } else {
        this._refCounts.set(key, count - 1);
      }
    }
  }

  getActiveOverrides() {
    return new Map(this._activeOverrides);
  }

  sanitizeForSubprocess(env) {
    const clean = { ...env };
    for (const [key] of this._activeOverrides.entries()) {
      const original = this._originalValues.get(key);
      if (original === undefined) {
        delete clean[key];
      } else {
        clean[key] = original;
      }
    }
    return clean;
  }

  reset() {
    for (const [key] of this._originalValues.entries()) {
      if (key === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = this._originalValues.get(key);
      }
    }
    this._refCounts.clear();
    this._originalValues.clear();
    this._activeOverrides.clear();
  }
}

const globalSkillEnvManager = new SkillEnvManager();

module.exports = {
  SkillEnvManager,
  globalSkillEnvManager,
  isDangerousHostEnvVarName,
  isDangerousHostEnvOverrideVarName,
  validateEnvVarValue,
  sanitizeEnvVars,
  DANGEROUS_HOST_ENV_VARS,
  BLOCKED_EVERYWHERE_KEYS,
  BLOCKED_OVERRIDE_ONLY_KEYS,
  BLOCKED_PREFIXES,
  BLOCKED_OVERRIDE_PREFIXES,
};
