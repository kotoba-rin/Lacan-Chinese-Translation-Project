const assert = require("assert");
const path = require("path");

const {
  CodexSkillCatalog,
  CustomSkillService,
  normalizeSkillProfiles,
  skillSnapshotsEqual,
  skillProfileSignature,
} = require(path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai",
  "skill-catalog.js"
));

const run = async () => {
  const listCalls = [];
  const catalog = new CodexSkillCatalog({
    vaultRoot: "/vault",
    readSkillText: async () => "skill version one",
    runtime: {
      async listSkills(options) {
        listCalls.push(options);
        return [
          {
            name: "translate-lacan-seminars",
            description: "Close reading.",
            path: "/vault/.agents/skills/translate-lacan-seminars/SKILL.md",
            scope: "repo",
            enabled: true,
          },
          {
            name: "humanizer-zh",
            description: "Rewrite.",
            path: "/Users/reader/.agents/skills/humanizer-zh/SKILL.md",
            scope: "user",
            enabled: true,
          },
          {
            name: "broken",
            description: "",
            path: "/vault/.agents/skills/broken/SKILL.md",
            scope: "repo",
            enabled: false,
          },
          {
            name: "needs-mcp",
            description: "Requires a disabled MCP server.",
            path: "/Users/reader/.codex/skills/needs-mcp/SKILL.md",
            scope: "user",
            enabled: true,
            dependencies: {
              tools: [{
                type: "mcp",
                value: "example",
                url: "https://example.com/mcp",
              }],
            },
          },
          {
            name: "duplicate",
            description: "First.",
            path: "/Users/reader/.agents/skills/duplicate/SKILL.md",
            scope: "user",
            enabled: true,
          },
          {
            name: "duplicate",
            description: "Second.",
            path: "/Users/reader/.claude/skills/duplicate/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ];
      },
    },
  });
  const skills = await catalog.refresh();
  assert.strictEqual(skills.length, 6);
  assert.deepStrictEqual(listCalls, [{ forceReload: true }]);

  const profile = {
    id: "profile-close-reading",
    title: "研讨班细读",
    mode: "standard-with-skills",
    primarySkill: {
      name: "translate-lacan-seminars",
      scope: "repo",
    },
    supportingSkills: [{
      name: "humanizer-zh",
      scope: "user",
    }],
    additionalInstruction: "先解释术语，再说明段落位置。",
  };
  const resolved = await catalog.resolveProfile(profile);
  assert.deepStrictEqual(resolved.skillInputs, [
    {
      type: "skill",
      name: "translate-lacan-seminars",
      path: "/vault/.agents/skills/translate-lacan-seminars/SKILL.md",
    },
    {
      type: "skill",
      name: "humanizer-zh",
      path: "/Users/reader/.agents/skills/humanizer-zh/SKILL.md",
    },
  ]);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      resolved.profile,
      "additionalInstruction"
    ),
    "Skill profiles should not carry a second prompt"
  );
  assert.strictEqual(
    skillProfileSignature(profile),
    skillProfileSignature({
      ...profile,
      additionalInstruction: "另一套旧提示词也不应影响 Skill 方案。",
    }),
    "legacy per-profile prompts should not create separate prompt variants"
  );
  assert.deepStrictEqual(
    normalizeSkillProfiles([{
      id: "prompt-only",
      title: "旧提示词方案",
      mode: "standard-with-skills",
      primarySkill: null,
      supportingSkills: [],
      additionalInstruction: "旧的补充提示词。",
    }]),
    [],
    "prompt-only legacy profiles should disappear after their text is migrated globally"
  );
  assert.strictEqual(
    skillProfileSignature({
      id: "prompt-only",
      title: "旧提示词方案",
      additionalInstruction: "旧的补充提示词。",
    }),
    "standard",
    "legacy prompt-only profiles should normalize to the no-Skill signature"
  );
  assert.ok(
    resolved.resolvedSkills[0].fingerprint,
    "repo Skills should carry a content fingerprint for later turn checks"
  );
  assert.strictEqual(
    skillSnapshotsEqual(
      resolved.resolvedSkills,
      resolved.resolvedSkills.map((skill) => ({ ...skill }))
    ),
    true
  );
  assert.strictEqual(
    skillSnapshotsEqual(
      resolved.resolvedSkills,
      resolved.resolvedSkills.map((skill, index) => (
        index === 0 ? { ...skill, fingerprint: "changed" } : skill
      ))
    ),
    false
  );

  await assert.rejects(
    catalog.resolveProfile({
      ...profile,
      primarySkill: { name: "missing", scope: "repo" },
    }),
    (error) => error.code === "SkillUnavailable"
  );
  await assert.rejects(
    catalog.resolveProfile({
      ...profile,
      primarySkill: { name: "needs-mcp", scope: "user" },
    }),
    (error) => error.code === "SkillDependencyUnavailable"
  );
  await assert.rejects(
    catalog.resolveProfile({
      ...profile,
      primarySkill: { name: "duplicate", scope: "user" },
    }),
    (error) => error.code === "SkillAmbiguous"
  );
  const exactDuplicate = await catalog.resolveProfile({
    ...profile,
    primarySkill: {
      name: "duplicate",
      scope: "user",
      pathHint: "/Users/reader/.claude/skills/duplicate/SKILL.md",
    },
  });
  assert.strictEqual(
    exactDuplicate.skillInputs[0].path,
    "/Users/reader/.claude/skills/duplicate/SKILL.md"
  );
  await assert.rejects(
    catalog.resolveProfile({
      ...profile,
      primarySkill: { name: "broken", scope: "repo" },
    }),
    (error) => error.code === "SkillUnavailable"
  );

  const normalizedProfiles = normalizeSkillProfiles([
    profile,
    {
      id: "too-many",
      title: "组合",
      mode: "skill-led",
      supportingSkills: [
        { name: "one", scope: "repo" },
        { name: "two", scope: "repo" },
        { name: "three", scope: "repo" },
      ],
    },
  ]);
  assert.strictEqual(normalizedProfiles[0].supportingSkills.length, 1);
  assert.strictEqual(normalizedProfiles[1].supportingSkills.length, 2);
  assert.strictEqual(
    skillProfileSignature(profile),
    skillProfileSignature({ ...profile, title: "另一个显示名称" }),
    "display-only profile changes must not split a conversation identity"
  );

  const folders = new Set();
  const files = new Map();
  const customSkills = new CustomSkillService({
    vaultRoot: "/vault",
    adapter: {
      async exists(relativePath) {
        return folders.has(relativePath) || files.has(relativePath);
      },
      async mkdir(relativePath) {
        folders.add(relativePath);
      },
      async write(relativePath, content) {
        files.set(relativePath, content);
      },
    },
  });
  const created = await customSkills.create({
    name: "lacan-close-reading",
    description: "围绕分段证据进行拉康研讨班细读。",
    instructions: "先定位原文，再解释概念，最后说明前后文关系。",
    root: ".agents/skills",
  });
  assert.strictEqual(
    created.path,
    ".agents/skills/lacan-close-reading/SKILL.md"
  );
  assert.match(files.get(created.path), /^---\nname: lacan-close-reading\n/m);
  assert.match(files.get(created.path), /围绕分段证据/);
  assert.match(files.get(created.path), /先定位原文/);
  await assert.rejects(
    customSkills.create({
      name: "../escape",
      description: "bad",
      instructions: "bad",
    }),
    (error) => error.code === "InvalidSkillName"
  );
  await assert.rejects(
    customSkills.create({
      name: "lacan-close-reading",
      description: "duplicate",
      instructions: "duplicate",
    }),
    (error) => error.code === "SkillAlreadyExists"
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
