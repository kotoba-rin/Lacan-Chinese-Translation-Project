#!/usr/bin/env python3
"""Controlled tag vocabulary and browse taxonomy for the knowledge base."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CategoryGroup:
    slug: str
    icon: str
    title: str
    fields: tuple[str, ...]


CATEGORY_GROUPS = (
    CategoryGroup(
        slug="category-psychoanalysis",
        icon="🧠",
        title="精神分析",
        fields=(
            "精神分析/无意识与主体",
            "精神分析/能指言说与书写",
            "精神分析/欲望驱力与客体",
            "精神分析/性爱与享乐",
            "精神分析/三界幻想与拓扑",
            "精神分析/临床结构与症状",
            "精神分析/分析实践与移情",
            "精神分析/话语社会与伦理",
            "精神分析/历史与学派",
        ),
    ),
    CategoryGroup(
        slug="category-philosophy",
        icon="🏛️",
        title="哲学与思想",
        fields=(
            "哲学/古代哲学",
            "哲学/近现代哲学",
            "哲学/伦理与政治",
            "哲学/认识论与心灵",
            "哲学/科学哲学",
            "哲学/思想史",
        ),
    ),
    CategoryGroup(
        slug="category-language-texts",
        icon="🔤",
        title="语言、符号与文献",
        fields=(
            "语言符号与文献/语言学与语法",
            "语言符号与文献/语源修辞与造词",
            "语言符号与文献/符号与语言哲学",
            "语言符号与文献/文献出版与期刊",
        ),
    ),
    CategoryGroup(
        slug="category-arts-culture",
        icon="🎭",
        title="文学、艺术与文化",
        fields=(
            "文学艺术与文化/文学",
            "文学艺术与文化/戏剧",
            "文学艺术与文化/视觉艺术",
            "文学艺术与文化/电影与音乐",
            "文学艺术与文化/文化游戏与民俗",
        ),
    ),
    CategoryGroup(
        slug="category-religion-myth",
        icon="⛪",
        title="宗教与神话",
        fields=(
            "宗教与神话/圣经与犹太传统",
            "宗教与神话/基督教与神学",
            "宗教与神话/宗教与仪式",
            "宗教与神话/神话",
        ),
    ),
    CategoryGroup(
        slug="category-history-society",
        icon="🌍",
        title="历史、社会与教育",
        fields=(
            "历史社会与教育/历史与政治史",
            "历史社会与教育/考古与古代史",
            "历史社会与教育/社会与政治",
            "历史社会与教育/人类学与民族志",
            "历史社会与教育/教育与制度",
        ),
    ),
    CategoryGroup(
        slug="category-psychology-medicine",
        icon="⚕️",
        title="心理学、精神病学与医学",
        fields=(
            "心理精神病学与医学/心理学",
            "心理精神病学与医学/精神病学与精神病理",
            "心理精神病学与医学/医学与神经科学",
            "心理精神病学与医学/心理学史",
            "心理精神病学与医学/精神病学史",
            "心理精神病学与医学/医学史",
        ),
    ),
    CategoryGroup(
        slug="category-formal-sciences",
        icon="∑",
        title="数学、逻辑与形式科学",
        fields=(
            "数学逻辑与形式科学/数学基础与集合论",
            "数学逻辑与形式科学/逻辑与数学哲学",
            "数学逻辑与形式科学/几何与拓扑",
            "数学逻辑与形式科学/信息与控制",
            "数学逻辑与形式科学/数学史",
        ),
    ),
    CategoryGroup(
        slug="category-natural-sciences",
        icon="🔬",
        title="自然科学",
        fields=(
            "自然科学/生命科学",
            "自然科学/物理与自然科学",
            "自然科学/科学史",
        ),
    ),
    CategoryGroup(
        slug="category-technology-computing",
        icon="🛠️",
        title="技术与计算",
        fields=(
            "技术与计算/计算机与软件",
            "技术与计算/技术与工程",
        ),
    ),
)

FIELD_TAGS = frozenset(
    f"领域/{field}"
    for category in CATEGORY_GROUPS
    for field in category.fields
)

ALLOWED_TAG_PREFIXES = frozenset(
    {
        "领域",
        "人物",
        "作品",
        "期刊",
        "机构",
        "团体",
        "事件",
        "概念",
        "传统",
        "体裁",
        "语言",
        "地区",
        "时期",
    }
)

# Only exact aliases that denote the same knowledge object are normalized here.
# Related but theoretically distinct terms deliberately remain separate tags.
DEPRECATED_TAG_ALIASES = {
    "人物/雅克-拉康": "人物/拉康",
    "人物/米歇尔-福柯": "人物/福柯",
    "人物/戈特洛布-弗雷格": "人物/弗雷格",
    "人物/阿普列尤斯": "人物/阿普列乌斯",
    "作品/会饮篇": "作品/会饮",
    "传统/斯多葛派": "传统/斯多葛主义",
    "语言/希腊语": "语言/古希腊语",
    "概念/词源": "概念/词源学",
    "概念/新造词": "概念/造词",
    "概念/移情": "概念/转移",
    "概念/礼物": "概念/赠礼",
}


def field_anchor(field_tag: str) -> str:
    """Return the stable Unicode HTML anchor used in the generated index."""

    return "tag-" + field_tag.replace("/", "-")


def field_label(field: str) -> str:
    """Return the leaf label shown below a category heading."""

    return field.rsplit("/", 1)[-1]
