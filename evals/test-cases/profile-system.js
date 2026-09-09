const { listProfiles, getActiveProfile, getApiProfilesDir, checkProfileConflict, PROFILES_DIR } = require("../../src/core/profile-manager");

module.exports = {
  name: "Profile System",
  cases: [
    {
      id: "ps_001",
      name: "PROFILES_DIR is a string path",
      category: "profile_system",
      run: () => {
        return typeof PROFILES_DIR === "string" && PROFILES_DIR.length > 0;
      },
    },
    {
      id: "ps_002",
      name: "getActiveProfile returns a string (default when no marker)",
      category: "profile_system",
      run: () => {
        const active = getActiveProfile();
        return typeof active === "string" && active.length > 0;
      },
    },
    {
      id: "ps_003",
      name: "getApiProfilesDir returns path ending with 'profiles'",
      category: "profile_system",
      run: () => {
        const dir = getApiProfilesDir("/tmp/test");
        return typeof dir === "string" && dir.endsWith("profiles");
      },
    },
    {
      id: "ps_004",
      name: "checkProfileConflict returns null when no conflict (no dirs exist)",
      category: "profile_system",
      run: () => {
        const result = checkProfileConflict("/nonexistent/path");
        return result === null;
      },
    },
    {
      id: "ps_005",
      name: "listProfiles always includes default profile",
      category: "profile_system",
      run: () => {
        const profiles = listProfiles();
        const hasDefault = profiles.some(p => p.name === "default");
        return hasDefault && profiles.length >= 1;
      },
    },
    {
      id: "ps_006",
      name: "getApiProfilesDir accepts no argument (uses default cwd)",
      category: "profile_system",
      run: () => {
        const dir = getApiProfilesDir();
        return typeof dir === "string" && dir.length > 0;
      },
    },
  ],
};
