const assert = require("assert");
const path = require("path");

const core = require(path.join(__dirname, "..", "theme", "lacan-nav-search-core.js"));

const index = {
  version: 1,
  seminars: {
    s14: "s14-la-logique-du-fantasme",
    s19b: "s19b-le-savoir-du-psychanalyste",
  },
  entries: [
    {
      title: "S14：幻想的逻辑",
      href: "s14-la-logique-du-fantasme/index.html",
      kind: "seminar",
      context: "",
      aliases: ["s14", "s14-la-logique-du-fantasme"],
      tags: [],
    },
    {
      title: "Leçon 07 | 15 Février 1967",
      href: "s14-la-logique-du-fantasme/Leçon-07.html",
      kind: "lesson",
      context: "S14：幻想的逻辑",
      aliases: ["s14-07", "S14 第 7 课"],
      tags: [],
    },
    {
      title: "Leçon 04 | 07 Décembre 1966",
      href: "s14-la-logique-du-fantasme/Leçon-04.html",
      kind: "lesson",
      context: "S14：幻想的逻辑",
      aliases: ["s14-04", "S14 第 4 课"],
      tags: [],
    },
    {
      title: "欲望",
      href: "知识库/欲望.html",
      kind: "knowledge",
      context: "知识库",
      aliases: ["désir"],
      tags: ["概念/欲望"],
    },
    {
      title: "对象 a：欲望的原因",
      href: "知识库/对象a.html",
      kind: "knowledge",
      context: "知识库",
      aliases: ["objet a", "对象a"],
      tags: ["概念/对象a"],
    },
  ],
};

assert.strictEqual(core.normalize(" 对象 A：欲望 "), "对象a欲望");

const desireResults = core.searchEntries(index, "欲望", 10);
assert.strictEqual(desireResults[0].title, "欲望");
assert.ok(desireResults.some((entry) => entry.title === "对象 a：欲望的原因"));

const aliasResults = core.searchEntries(index, "objet a", 10);
assert.deepStrictEqual(aliasResults.map((entry) => entry.title), ["对象 a：欲望的原因"]);

const accentInsensitiveResults = core.searchEntries(index, "desir", 10);
assert.strictEqual(accentInsensitiveResults[0].title, "欲望");

const seminarResults = core.searchEntries(index, "s14", 10);
assert.strictEqual(seminarResults[0].kind, "seminar");
assert.ok(seminarResults.some((entry) => entry.kind === "lesson"));

assert.deepStrictEqual(
  core.searchEntries(index, "S14 第 7 课", 10).map((entry) => entry.title),
  ["Leçon 07 | 15 Février 1967"]
);

assert.deepStrictEqual(core.directSegmentResult(index, "S14-7-97"), {
  title: "段落 s14-07-0097",
  href: "s14-la-logique-du-fantasme/Leçon-07.html#s14-07-0097",
  kind: "segment",
  context: "直接定位到第 07 课",
  aliases: [],
  tags: [],
  direct: true,
});

assert.strictEqual(
  core.directSegmentResult(index, "s19b-02-0003").href,
  "s19b-le-savoir-du-psychanalyste/Leçon-02.html#s19b-02-0003"
);
assert.strictEqual(core.directSegmentResult(index, "s99-01-0001"), null);
assert.strictEqual(core.directSegmentResult(index, "欲望"), null);

const directFirst = core.searchEntries(index, "s14-07-0097", 10);
assert.strictEqual(directFirst[0].kind, "segment");
assert.strictEqual(directFirst.length, 1);

console.log("lacan navigation search core tests passed");
