(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.LacanNavSearchCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var KIND_PRIORITY = {
    segment: 0,
    seminar: 1,
    "knowledge-index": 2,
    knowledge: 3,
    lesson: 4,
    glossary: 5,
    "notes-index": 6,
    note: 7,
    home: 8,
    page: 9,
  };

  function normalize(value) {
    return String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{M}+/gu, "")
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function queryTerms(value) {
    return String(value || "")
      .trim()
      .split(/\s+/)
      .map(normalize)
      .filter(Boolean);
  }

  function canonicalSegmentId(value) {
    var clean = String(value || "")
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[‐‑‒–—−]/g, "-")
      .replace(/\s+/g, "");
    var match = /^s(\d+[a-z]?)-(\d+)-(\d+)$/.exec(clean);
    if (!match) return "";
    return "s" + match[1] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(4, "0");
  }

  function canonicalLessonKey(value) {
    var clean = String(value || "")
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[‐‑‒–—−]/g, "-");
    var match = /^s(\d+[a-z]?)\s*-\s*(\d+)$/.exec(clean) ||
      /^s(\d+[a-z]?)\s*第\s*(\d+)\s*课$/.exec(clean);
    if (!match) return "";
    return "s" + match[1] + "-" + match[2].padStart(2, "0");
  }

  function directSegmentResult(index, query) {
    var segmentId = canonicalSegmentId(query);
    if (!segmentId) return null;

    var parts = segmentId.split("-");
    var seminarCode = parts[0];
    var lesson = parts[1];
    var slug = index && index.seminars && index.seminars[seminarCode];
    if (!slug) return null;

    return {
      title: "段落 " + segmentId,
      href: slug + "/Leçon-" + lesson + ".html#" + segmentId,
      kind: "segment",
      context: "直接定位到第 " + lesson + " 课",
      aliases: [],
      tags: [],
      direct: true,
    };
  }

  function normalizedList(values) {
    return (values || []).map(normalize).filter(Boolean);
  }

  function scoreEntry(entry, normalizedQuery, terms) {
    var title = normalize(entry.title);
    var aliases = normalizedList(entry.aliases);
    var tags = normalizedList(entry.tags);
    var context = normalize(entry.context);
    var fields = [title, context].concat(aliases, tags).filter(Boolean);
    var searchable = fields.join(" ");
    var sameFieldMatch = fields.some(function (field) {
      return terms.every(function (term) { return field.includes(term); });
    });
    var distributedMatch = terms.every(function (term) {
      return searchable.includes(term);
    });
    var allowDistributedMatch = terms.every(function (term) {
      return term.length >= 2;
    });

    if (!sameFieldMatch && !(allowDistributedMatch && distributedMatch)) {
      return 0;
    }

    var score = 10;
    if (title === normalizedQuery) score += 220;
    else if (title.startsWith(normalizedQuery)) score += 150;
    else if (title.includes(normalizedQuery)) score += 120;

    aliases.forEach(function (alias) {
      if (alias === normalizedQuery) score = Math.max(score, 110);
      else if (alias.includes(normalizedQuery)) score = Math.max(score, 75);
    });
    tags.forEach(function (tag) {
      if (tag === normalizedQuery) score = Math.max(score, 70);
      else if (tag.includes(normalizedQuery)) score = Math.max(score, 55);
    });
    if (context === normalizedQuery) score = Math.max(score, 50);
    else if (context.includes(normalizedQuery)) score = Math.max(score, 35);

    return score;
  }

  function searchEntries(index, query, limit) {
    var direct = directSegmentResult(index, query);
    if (direct) return [direct];

    var lessonKey = canonicalLessonKey(query);
    if (lessonKey) {
      var normalizedLessonKey = normalize(lessonKey);
      var lessonMatches = ((index && index.entries) || []).filter(function (entry) {
        return entry.kind === "lesson" && normalizedList(entry.aliases).includes(normalizedLessonKey);
      });
      if (lessonMatches.length) {
        return lessonMatches.slice(0, Math.max(1, Number(limit) || 20));
      }
    }

    var normalizedQuery = normalize(query);
    var terms = queryTerms(query);
    if (!normalizedQuery || !terms.length) return [];

    return ((index && index.entries) || [])
      .map(function (entry) {
        return { entry: entry, score: scoreEntry(entry, normalizedQuery, terms) };
      })
      .filter(function (item) { return item.score > 0; })
      .sort(function (left, right) {
        var scoreDifference = right.score - left.score;
        if (scoreDifference) return scoreDifference;
        var leftPriority = KIND_PRIORITY[left.entry.kind] === undefined ? 99 : KIND_PRIORITY[left.entry.kind];
        var rightPriority = KIND_PRIORITY[right.entry.kind] === undefined ? 99 : KIND_PRIORITY[right.entry.kind];
        return leftPriority - rightPriority ||
          String(left.entry.title).localeCompare(String(right.entry.title), "zh-CN");
      })
      .slice(0, Math.max(1, Number(limit) || 20))
      .map(function (item) { return item.entry; });
  }

  return {
    normalize: normalize,
    canonicalSegmentId: canonicalSegmentId,
    canonicalLessonKey: canonicalLessonKey,
    directSegmentResult: directSegmentResult,
    searchEntries: searchEntries,
  };
});
