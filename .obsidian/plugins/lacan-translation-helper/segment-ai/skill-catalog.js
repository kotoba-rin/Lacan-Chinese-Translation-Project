const path = require("path");
const crypto = require("crypto");
const fs = require("fs/promises");

const STANDARD_SKILL_PROFILE = Object.freeze({
  id: "standard",
  title: "不附加 Skill",
  primarySkill: null,
  supportingSkills: [],
});

const ALLOWED_CUSTOM_SKILL_ROOTS = new Set([
  ".agents/skills",
  ".codex/skills",
]);

class SegmentAiSkillError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SegmentAiSkillError";
    this.code = code;
    Object.assign(this, details);
  }
}

const normalizeSkillSelector = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const name = String(value.name || "").trim();
  const scope = String(value.scope || "").trim();
  if (!name || !scope) {
    return null;
  }
  const pathHint = String(value.pathHint || "").trim();
  return {
    name,
    scope,
    ...(pathHint ? { pathHint } : {}),
  };
};

const normalizeSkillProfile = (value, index = 0) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = String(value.id || `skill-profile-${index + 1}`).trim();
  const title = String(value.title || "").trim();
  if (!id || id === "standard" || !title) {
    return null;
  }
  const primarySkill = normalizeSkillSelector(value.primarySkill);
  const supportingSkills = (Array.isArray(value.supportingSkills)
    ? value.supportingSkills
    : [])
    .map(normalizeSkillSelector)
    .filter(Boolean)
    .filter((selector, selectorIndex, list) => (
      list.findIndex((candidate) => (
        candidate.name === selector.name
        && candidate.scope === selector.scope
        && String(candidate.pathHint || "") === String(selector.pathHint || "")
      )) === selectorIndex
      && !(
        primarySkill
        && primarySkill.name === selector.name
        && primarySkill.scope === selector.scope
        && String(primarySkill.pathHint || "") === String(selector.pathHint || "")
      )
    ))
    .slice(0, 2);
  if (!primarySkill && supportingSkills.length === 0) {
    return null;
  }
  return {
    id,
    title,
    primarySkill,
    supportingSkills,
  };
};

const normalizeSkillProfiles = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const profiles = [];
  const seen = new Set();
  value.forEach((entry, index) => {
    const profile = normalizeSkillProfile(entry, index);
    if (!profile || seen.has(profile.id)) {
      return;
    }
    seen.add(profile.id);
    profiles.push(profile);
  });
  return profiles;
};

const skillProfileSignature = (value) => {
  if (!value || value.id === "standard") {
    return "standard";
  }
  const profile = normalizeSkillProfile(value);
  if (!profile) {
    return "standard";
  }
  const selectorKey = (selector) => (
    selector
      ? `${selector.scope}:${selector.name}:${selector.pathHint || ""}`
      : ""
  );
  return JSON.stringify({
    id: profile.id,
    primary: selectorKey(profile.primarySkill),
    supporting: profile.supportingSkills.map(selectorKey),
  });
};

const normalizeSkillMetadata = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const name = String(value.name || "").trim();
  const skillPath = String(value.path || "").trim();
  const scope = String(value.scope || "").trim();
  if (!name || !skillPath || !scope) {
    return null;
  }
  return {
    name,
    description: String(value.description || "").trim(),
    path: skillPath,
    scope,
    enabled: value.enabled !== false,
    errors: Array.isArray(value.errors)
      ? value.errors.map((error) => String(error || "")).filter(Boolean)
      : [],
    dependencies: {
      tools: Array.isArray(value.dependencies?.tools)
        ? value.dependencies.tools.map((dependency) => ({ ...dependency }))
        : [],
    },
  };
};

class CodexSkillCatalog {
  constructor({
    vaultRoot,
    runtime,
    initialSkills = [],
    readSkillText = (skillPath) => fs.readFile(skillPath, "utf8"),
  } = {}) {
    if (!path.isAbsolute(String(vaultRoot || "")) || !runtime) {
      throw new TypeError("CodexSkillCatalog requires a Vault root and runtime.");
    }
    this.vaultRoot = path.resolve(vaultRoot);
    this.runtime = runtime;
    this.readSkillText = readSkillText;
    this.skills = (Array.isArray(initialSkills) ? initialSkills : [])
      .map(normalizeSkillMetadata)
      .filter(Boolean);
    this.loaded = this.skills.length > 0;
  }

  async refresh({ forceReload = true } = {}) {
    const listed = await this.runtime.listSkills({ forceReload });
    this.skills = (Array.isArray(listed) ? listed : [])
      .map(normalizeSkillMetadata)
      .filter(Boolean)
      .sort((left, right) => (
        left.name.localeCompare(right.name)
        || left.scope.localeCompare(right.scope)
      ));
    this.loaded = true;
    return this.list();
  }

  invalidate() {
    this.loaded = false;
  }

  list() {
    return this.skills.map((skill) => ({
      ...skill,
      errors: [...skill.errors],
      dependencies: {
        tools: skill.dependencies.tools.map(
          (dependency) => ({ ...dependency })
        ),
      },
    }));
  }

  async resolveProfile(value) {
    const profile = value?.id === "standard"
      ? { ...STANDARD_SKILL_PROFILE }
      : normalizeSkillProfile(value);
    if (!profile) {
      throw new SegmentAiSkillError(
        "SkillProfileNotFound",
        "Skill 方案已经不存在或无法读取。"
      );
    }
    const selectors = [
      profile.primarySkill,
      ...profile.supportingSkills,
    ].filter(Boolean);
    if (selectors.length === 0) {
      return { profile, skillInputs: [], resolvedSkills: [] };
    }
    if (!this.loaded) {
      await this.refresh({ forceReload: false });
    }
    const resolvedSkills = await Promise.all(selectors.map(async (selector) => {
      const candidates = this.skills.filter((candidate) => (
        candidate.name === selector.name && candidate.scope === selector.scope
      ));
      const skill = selector.pathHint
        ? candidates.find((candidate) => candidate.path === selector.pathHint)
        : candidates.length === 1
          ? candidates[0]
          : null;
      if (!selector.pathHint && candidates.length > 1) {
        throw new SegmentAiSkillError(
          "SkillAmbiguous",
          `发现多个同名 Skill “${selector.name}”，请在 Skill 方案中重新选择具体来源。`,
          { skillName: selector.name, skillScope: selector.scope }
        );
      }
      if (!skill || !skill.enabled || skill.errors.length > 0) {
        throw new SegmentAiSkillError(
          "SkillUnavailable",
          `Skill 方案中的 Skill “${selector.name}”当前不可用，请刷新或改选方案。`,
          { skillName: selector.name, skillScope: selector.scope }
        );
      }
      const unavailableDependency = skill.dependencies.tools.find(
        (dependency) => {
          const type = String(dependency?.type || "").toLowerCase();
          return ["mcp", "app", "web", "network"].includes(type)
            || Boolean(dependency?.url);
        }
      );
      if (unavailableDependency) {
        throw new SegmentAiSkillError(
          "SkillDependencyUnavailable",
          `Skill “${selector.name}”依赖当前 AI 功能模式已禁用的外部能力。`,
          {
            skillName: selector.name,
            skillScope: selector.scope,
            dependencyType: unavailableDependency.type,
          }
        );
      }
      if (skill.scope !== "repo" || !isPathInside(this.vaultRoot, skill.path)) {
        return skill;
      }
      try {
        const content = await this.readSkillText(skill.path);
        return {
          ...skill,
          fingerprint: crypto
            .createHash("sha256")
            .update(String(content || ""), "utf8")
            .digest("hex"),
        };
      } catch (_error) {
        throw new SegmentAiSkillError(
          "SkillUnavailable",
          `无法读取随项目 Skill “${selector.name}”，请刷新后重试。`,
          { skillName: selector.name, skillScope: selector.scope }
        );
      }
    }));
    return {
      profile,
      resolvedSkills: resolvedSkills.map((skill) => ({ ...skill })),
      skillInputs: resolvedSkills.map((skill) => ({
        type: "skill",
        name: skill.name,
        path: skill.path,
      })),
    };
  }
}

const isPathInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

const skillSnapshotsEqual = (left, right) => {
  const normalize = (value) => (Array.isArray(value) ? value : []).map(
    (skill) => ({
      name: String(skill?.name || ""),
      scope: String(skill?.scope || ""),
      path: String(skill?.path || ""),
      fingerprint: String(skill?.fingerprint || ""),
    })
  );
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

class CustomSkillService {
  constructor({ vaultRoot, adapter } = {}) {
    if (!path.isAbsolute(String(vaultRoot || "")) || !adapter) {
      throw new TypeError("CustomSkillService requires a Vault root and adapter.");
    }
    this.vaultRoot = path.resolve(vaultRoot);
    this.adapter = adapter;
  }

  async create({
    name,
    description,
    instructions,
    root = ".agents/skills",
  } = {}) {
    const normalizedName = String(name || "").trim();
    const normalizedDescription = String(description || "").trim();
    const normalizedInstructions = String(instructions || "").trim();
    const normalizedRoot = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalizedName)) {
      throw new SegmentAiSkillError(
        "InvalidSkillName",
        "Skill 名称只能包含字母、数字、短横线和下划线。"
      );
    }
    if (!ALLOWED_CUSTOM_SKILL_ROOTS.has(normalizedRoot)) {
      throw new SegmentAiSkillError(
        "InvalidSkillRoot",
        "自定义 Skill 只能保存在当前 Vault 的 .agents/skills 或 .codex/skills。"
      );
    }
    if (!normalizedDescription || !normalizedInstructions) {
      throw new SegmentAiSkillError(
        "InvalidSkillContent",
        "Skill 说明和指令正文不能为空。"
      );
    }
    const directory = `${normalizedRoot}/${normalizedName}`;
    const skillPath = `${directory}/SKILL.md`;
    if (await this.adapter.exists(directory) || await this.adapter.exists(skillPath)) {
      throw new SegmentAiSkillError(
        "SkillAlreadyExists",
        `已经存在名为 “${normalizedName}” 的 Vault Skill。`
      );
    }
    await this.adapter.mkdir(normalizedRoot);
    await this.adapter.mkdir(directory);
    const content = [
      "---",
      `name: ${normalizedName}`,
      `description: ${JSON.stringify(normalizedDescription)}`,
      "---",
      "",
      `# ${normalizedName}`,
      "",
      normalizedInstructions,
      "",
    ].join("\n");
    await this.adapter.write(skillPath, content);
    return {
      name: normalizedName,
      description: normalizedDescription,
      path: skillPath,
      scope: "repo",
    };
  }
}

module.exports = {
  ALLOWED_CUSTOM_SKILL_ROOTS,
  CodexSkillCatalog,
  CustomSkillService,
  STANDARD_SKILL_PROFILE,
  SegmentAiSkillError,
  normalizeSkillMetadata,
  normalizeSkillProfile,
  normalizeSkillProfiles,
  skillSnapshotsEqual,
  skillProfileSignature,
};
