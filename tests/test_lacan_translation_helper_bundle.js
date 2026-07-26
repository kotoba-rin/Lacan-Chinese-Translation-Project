const assert = require("assert");
const fs = require("fs");
const path = require("path");

const pluginDir = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper"
);
const mainPath = path.join(pluginDir, "main.js");
const sourcePath = path.join(pluginDir, "src", "main.js");
const stylesPath = path.join(pluginDir, "styles.css");

assert.ok(fs.existsSync(sourcePath), "plugin source entry should be kept under src/");

const main = fs.readFileSync(mainPath, "utf8");
const source = fs.readFileSync(sourcePath, "utf8");
const styles = fs.readFileSync(stylesPath, "utf8");

assert.ok(
  !/require\(\s*["']\.{1,2}\/segment-ai\//.test(main),
  "released main.js must bundle segment-ai modules for Obsidian's plugin loader"
);
assert.ok(
  source.includes('require("../segment-ai/domain")'),
  "source entry should keep the segment-ai module boundary"
);
assert.ok(
  main.includes("lacan-segment-interpretation"),
  "released bundle should contain the integrated AI interpretation view"
);
assert.match(
  source,
  /setName\("Agent 模型"\)[\s\S]{0,800}\.addDropdown\(/,
  "Agent model setting should use a model/list-backed dropdown"
);
assert.ok(
  main.includes('"model/list"'),
  "released bundle should discover models through Codex App Server"
);
assert.ok(
  main.includes('web_search: "live"')
    && main.includes("'web_search=\"live\"'"),
  "released runtime should require live Web Search"
);
assert.ok(
  source.includes("内置 Web Search")
    && source.includes("法语、德语或英语"),
  "AI settings should disclose the required web search and source-language boundary"
);
assert.match(
  source,
  /segmentAiReasoningEffort:\s*""/,
  "plugin settings should persist a reasoning effort override"
);
assert.match(
  source,
  /setName\("推理强度"\)[\s\S]{0,1200}\.addDropdown\(/,
  "settings should expose a model-aware reasoning effort dropdown"
);
assert.ok(
  main.includes("effectiveReasoningEffort") && main.includes("effort: effectiveReasoningEffort"),
  "released runtime should send the selected effort through turn/start"
);
assert.match(
  source,
  /segmentAiMaxOpenSessions:\s*3/,
  "plugin settings should persist the configurable multi-session limit"
);
assert.ok(
  main.includes('"skills/list"') && main.includes('type: "skill"'),
  "released bundle should discover and invoke Codex Skills structurally"
);
assert.ok(
  /activeTurns\s*=\s*(?:\/\*[^*]*\*\/\s*)?new Map\(\)/.test(main),
  "released runtime should route multiple simultaneous turns"
);
assert.match(
  source,
  /setName\("会话上限"\)[\s\S]{0,900}\.addDropdown\(/,
  "settings should expose the 1-5 open-session limit"
);
assert.match(
  source,
  /setName\("默认 Skill 方案"\)[\s\S]{0,900}\.addDropdown\(/,
  "AI function settings should expose the default Skill profile"
);
assert.match(
  source,
  /button\.textContent\s*=\s*includeSegmentId[\s\S]{0,100}`【\$\{segmentId\}】 Ф`[\s\S]{0,50}"Ф"/,
  "reading mode should add the segment ID while editor mode keeps the compact Phi symbol"
);
assert.match(
  source,
  /renderSettingsTabs\(containerEl\);[\s\S]{0,500}activeSettingsTab\s*===\s*"ai"[\s\S]{0,300}renderSegmentAiSettings\(containerEl\)[\s\S]{0,100}return;/,
  "plugin settings should isolate AI functions in their own tab"
);
assert.match(
  styles,
  /\.lacan-settings-tabs\s*\{[\s\S]{0,500}\}/,
  "settings tabs should have an integrated Obsidian-native layout"
);
assert.match(
  styles,
  /\.lacan-ai-global-prompt\s*\{[^}]*min-height:\s*220px;[^}]*width:\s*100%;/s,
  "the single global prompt should be comfortable to edit"
);
assert.match(
  styles,
  /\.lacan-ai-answer-content\s*\{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;[^}]*cursor:\s*text;/s,
  "generated answers should override Obsidian UI selection blocking and remain copyable"
);
assert.ok(
  !styles.includes("var(--color-red"),
  "interactive plugin highlights must not force Obsidian's red palette"
);
for (const selector of [
  ".lacan-segment-ai-button",
  ".lacan-segment-ai-profile-button",
  ".lacan-ai-view",
]) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    styles,
    new RegExp(
      `${escapedSelector}\\s*\\{[^}]*--lacan-ai-ink:\\s*var\\(--interactive-accent\\);`,
      "s"
    ),
    `${selector} should inherit the active Obsidian theme accent`
  );
}
assert.match(
  source,
  /segmentAiPrompt:\s*DEFAULT_INTERPRETATION_PROMPT/,
  "plugin settings should persist one global interpretation prompt"
);
assert.match(
  source,
  /new InterpretationPromptBuilder\(\{\s*interpretationPrompt:\s*this\.settings\.segmentAiPrompt[\s\S]{0,80}\}\)/,
  "the runtime should build every conversation from the global prompt"
);
assert.match(
  source,
  /setName\("解读提示词"\)[\s\S]{0,1200}\.addTextArea\([\s\S]{0,600}\.setValue\(\s*this\.plugin\.settings\.segmentAiPrompt/,
  "AI settings should expose the complete global prompt in one editable field"
);
assert.ok(
  source.includes(
    "默认功能：术语与符号对照 + 语境性解读。术语表只读，缺项或不一致只提示，由用户判断是否修改。"
  ),
  "AI settings should state the feature's translation-analysis position and read-only glossary boundary"
);
assert.ok(
  !source.includes('setName("补充提示词")'),
  "Skill profiles must not expose a second prompt field"
);
assert.ok(
  !source.includes("additionalInstruction: profileDraft.instruction"),
  "new Skill profiles must not persist per-profile prompts"
);
assert.match(
  source,
  /!profileDraft\.title\s*\|\|\s*!\(profileDraft\.primary\s*\|\|\s*profileDraft\.supporting\)/,
  "a Skill profile should require at least one Skill instead of a prompt"
);
assert.ok(
  main.includes("shouldSubmitFollowUpOnKeydown"),
  "released bundle should use the shared Enter/IME submission guard"
);
assert.match(
  styles,
  /\.lacan-ai-view\s*\{[^}]*overflow:\s*hidden;/s,
  "AI view should prevent the Obsidian content root from scrolling behind the composer"
);
assert.match(
  styles,
  /\.lacan-ai-view-scroll\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s,
  "AI answer should own the remaining height above the follow-up composer"
);
assert.match(
  styles,
  /\.workspace-leaf-content\[data-type="lacan-segment-interpretation"\]\s+\.view-content\.lacan-ai-view\s*\{[^}]*overflow:\s*hidden;/s,
  "AI view should override Obsidian's higher-specificity view-content scrolling"
);
assert.match(
  styles,
  /\.lacan-ai-follow-up\s*\{[^}]*padding-bottom:\s*calc\(14px \+ var\(--lacan-ai-status-bar-clearance,\s*0px\)\);/s,
  "follow-up composer should remain above Obsidian's fixed status bar"
);
assert.match(
  styles,
  /\.lacan-ai-tabs\s*\{[^}]*overflow-x:\s*auto;/s,
  "conversation tabs should remain usable when several sessions are open"
);
assert.match(
  styles,
  /\.lacan-ai-history\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s,
  "history should be a bounded drawer instead of competing with the answer scroller"
);
assert.match(
  styles,
  /\.lacan-ai-history-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
  "history rows should use their own scroll container"
);
assert.match(
  styles,
  /\.lacan-ai-workspace-actions \.lacan-ai-quiet-button\s*\{[^}]*appearance:\s*none;[^}]*height:\s*auto;/s,
  "the history toggle should not inherit Obsidian's oversized default button chrome"
);
assert.match(
  styles,
  /\.lacan-ai-navigator\s*\{[^}]*position:\s*sticky;/s,
  "the five conversation jump controls should stay reachable while reading"
);

console.log("lacan translation helper bundle tests passed");
