/**
 * 自定义角色：模板 / 解析 / 导出（纯模块，不碰酒馆，方便单测）
 * ------------------------------------------------------------------
 * 支持的导入格式（自动识别，不用用户选）：
 *   ① JSON 数组                  [ {...}, {...} ]
 *   ② JSON 对象包一层            { "characters": [ {...} ] }
 *   ③ 单个 JSON 对象             { "zh": "…", "identity": "…" }（只加一个）
 *   ④ Markdown 代码块里的 JSON   ```json … ``` （AI 最爱这么输出）
 *   ⑤ CSV / TSV                  第一行是字段名（中英字段名都认）
 *   ⑥ 「键: 值」段落             每段一个角色，空行分隔（AI 输出纯文本时兜底）
 *
 * 字段名同时认中文与英文（例：中文名/名字/name/zh、外观提示词/外观/identity/appearance）
 */

/** 字段别名表：把各种写法归一到内部字段 */
const FIELD_ALIASES = {
    zh: ['zh', '中文名', '名字', '名称', '角色名', '角色', 'name', 'char', 'character'],
    en: ['en', '英文名', '英文', 'english', 'romanized'],
    jp: ['jp', '日文名', '日文', 'japanese'],
    series: ['series', '作品', '出处', '所属作品', '阵营', '游戏', '动画'],
    seriesTag: ['seriestag', '作品tag', '作品英文', '作品标签'],
    booru: ['booru', 'boorutag', '角色tag', '角色标签', 'booru角色tag', 'tag'],
    rating: ['rating', '尺度', '分级', 'r18', 'nsfw'],
    aliases: ['aliases', '别名', '外号', '昵称', '别称'],
    identity: ['identity', '外观', '外观提示词', '外貌', '外形', '特征', 'appearance', 'look', 'identitytags'],
    outfit: ['outfit', '服装', '服装提示词', '穿着', '衣服', 'clothes', 'clothing'],
    outfitName: ['outfitname', '服装名', '服装名称', '套装名'],
    note: ['note', '说明', '备注', '辨识点', '描述', '简介'],
    minor: ['minor', '未成年', '幼态', '小孩'],
};

const normKey = k => String(k ?? '').trim().toLowerCase().replace(/[\s_\-（）()【】\[\]]/g, '');
const KEYMAP = (() => {
    const m = new Map();
    for (const [field, list] of Object.entries(FIELD_ALIASES)) for (const a of list) m.set(normKey(a), field);
    return m;
})();

const isBlank = v => v === undefined || v === null || String(v).trim() === '';
const asList = v => (Array.isArray(v) ? v : String(v ?? '').split(/[,，、|]/)).map(x => String(x).trim()).filter(Boolean);

/** 把任意一条原始对象规整成角色记录；缺必填就返回错误。 */
export function normalizeEntry(raw, index = 0) {
    const src = {};
    for (const [k, v] of Object.entries(raw || {})) {
        if (k.startsWith('_')) continue;                       // 跳过 _说明 之类
        const field = KEYMAP.get(normKey(k));
        if (field && !isBlank(v)) src[field] = v;
    }

    const errors = [];
    const zh = String(src.zh ?? '').trim();
    if (!zh) errors.push('缺中文名（zh / 中文名）');
    const identity = String(src.identity ?? '').trim();
    if (!identity) errors.push('缺外观提示词（identity / 外观）');
    if (errors.length) return { error: `第 ${index + 1} 条：${errors.join('；')}` };

    const en = String(src.en ?? '').trim() || zh;
    const booru = String(src.booru ?? '').trim() || en.toLowerCase();
    let rating = String(src.rating ?? 'sfw').trim().toLowerCase();
    if (/^(r18|18|nsfw|adult|explicit)$/.test(rating)) rating = 'nsfw';
    else if (/galgame|eroge/.test(rating)) rating = 'galgame';
    else if (!/^(sfw|nsfw|galgame)$/.test(rating)) rating = 'sfw';
    const minorRaw = src.minor;
    const minor = minorRaw === true || /^(true|1|yes|是|y)$/i.test(String(minorRaw ?? ''));

    const entry = {
        id: makeId(zh, booru),
        zh,
        en,
        jp: String(src.jp ?? '').trim(),
        series: String(src.series ?? '').trim() || '自定义',
        seriesTag: String(src.seriesTag ?? '').trim(),
        booru,
        rating,
        aliases: [...new Set([zh, en, ...asList(src.aliases)])].filter(Boolean),
        identity,
        outfitName: String(src.outfitName ?? '').trim() || `标志性服装·${zh}`,
        outfit: String(src.outfit ?? '').trim(),
        note: String(src.note ?? '').trim(),
        custom: true,
    };
    if (minor) entry.minor = true;
    return { entry };
}

/** 生成一个稳定、不重复的 id */
export function makeId(zh, booru) {
    const base = String(booru || zh || 'char')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    return `custom_${base || 'char'}`;
}

/** 从文本里"猜"出 JSON：支持 ```json 代码块、前后有解释文字的情况。 */
export function extractJson(text) {
    const t = String(text ?? '');
    const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    const body = fence ? fence[1] : t;
    const start = body.search(/[[{]/);
    if (start < 0) return null;
    // 从左括号开始做括号配对，容忍后面的解释文字
    const open = body[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < body.length; i++) {
        const ch = body[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}

/** CSV / TSV：第一行字段名，支持引号包裹 */
export function parseDelimited(text) {
    const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return null;
    const sep = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ',';
    const split = line => {
        const out = [];
        let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQ) {
                if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (ch === '"') inQ = false;
                else cur += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === sep) { out.push(cur); cur = ''; }
            else cur += ch;
        }
        out.push(cur);
        return out.map(x => x.trim());
    };
    const head = split(lines[0]);
    if (!head.some(h => KEYMAP.has(normKey(h)))) return null;
    return lines.slice(1).map(l => {
        const cells = split(l);
        const obj = {};
        head.forEach((h, i) => { if (cells[i]) obj[h] = cells[i]; });
        return obj;
    });
}

/** 「键: 值」段落（AI 输出纯文本时的兜底） */
export function parseKeyValueBlocks(text) {
    const blocks = String(text ?? '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    const out = [];
    for (const b of blocks) {
        const obj = {};
        let hit = 0;
        for (const line of b.split(/\r?\n/)) {
            const m = line.match(/^\s*[-*•]?\s*([^:：]{1,12})\s*[:：]\s*(.+?)\s*$/);
            if (!m) continue;
            if (!KEYMAP.has(normKey(m[1]))) continue;
            obj[m[1]] = m[2].replace(/^["'「]|["'」]$/g, '');
            hit++;
        }
        if (hit >= 2) out.push(obj);
    }
    return out.length ? out : null;
}

/**
 * 主入口：把用户给的文本（或已解析对象）变成角色记录列表。
 * @returns {{ entries: Array, errors: string[] }}
 */
export function parseCustomChars(input) {
    const errors = [];
    let raw = null;
    if (Array.isArray(input) || (input && typeof input === 'object')) raw = input;
    else {
        const text = String(input ?? '');
        raw = extractJson(text) ?? parseDelimited(text) ?? parseKeyValueBlocks(text);
        if (!raw) return { entries: [], errors: ['没认出任何角色 —— 支持：JSON（可放在 ```json 代码块里）、CSV/TSV、或「中文名: …　外观: …」这样的段落。'] };
    }

    let list;
    if (Array.isArray(raw)) list = raw;
    else if (Array.isArray(raw.characters)) list = raw.characters;
    else if (Array.isArray(raw.chars)) list = raw.chars;
    else if (Array.isArray(raw.角色)) list = raw.角色;
    else if (Array.isArray(raw.roles)) list = raw.roles;
    else if (raw.zh || raw.中文名 || raw.name || raw.identity || raw.外观) list = [raw];
    else return { entries: [], errors: ['JSON 结构不认识 —— 请用数组、或 { "characters": [ … ] } 包一层。'] };

    const entries = [];
    list.forEach((item, i) => {
        if (!item || typeof item !== 'object') { errors.push(`第 ${i + 1} 条不是对象，已跳过`); return; }
        const { entry, error } = normalizeEntry(item, i);
        if (error) errors.push(error);
        else entries.push(entry);
    });
    return { entries, errors };
}

/** 合并进已有自定义库：同名/同 tag 视为同一个（更新），并返回统计 */
export function mergeCustomChars(existing, incoming) {
    const list = Array.isArray(existing) ? [...existing] : [];
    let added = 0, updated = 0;
    const keyOf = e => (e.booru || e.zh || '').toLowerCase();
    for (const en of incoming || []) {
        const i = list.findIndex(x => keyOf(x) === keyOf(en));
        if (i >= 0) { list[i] = { ...en, id: list[i].id || en.id }; updated++; }
        else { list.push(en); added++; }
    }
    return { list, added, updated };
}

/** 导出成 JSON 文本（给别的 AI 看、或备份） */
export function toExportText(entries) {
    return JSON.stringify({ _说明: '同人角色库导出 —— 可直接再导入，也可以丢给别的 AI 照这个格式继续加', characters: entries }, null, 2);
}

/** 下载用的模板（含字段说明） */
export const TEMPLATE_OBJECT = {
    _说明: '把这个文件丢给别的 AI，让它按 characters 里的格式给你造角色；也可以自己照抄一条改。填完保存成 .json，回插件「同人角色 → 导入角色」里选文件即可。',
    _必填: ['zh（中文名）', 'identity（外观提示词）'],
    _可选: ['en', 'jp', 'series', 'seriesTag', 'booru', 'rating(sfw|nsfw|galgame)', 'aliases', 'outfitName', 'outfit', 'note', 'minor(true 表示原作就是小孩)'],
    _booru怎么写: '去 booru 站搜角色名，抄那条角色 tag（例：hu tao (genshin impact)、shiroko (blue archive)）。写对了模型才真的还原原作；不写就只能靠外观提示词。',
    characters: [
        {
            zh: '示例角色',
            en: 'Example Character',
            jp: '',
            series: '示例作品',
            seriesTag: 'example series',
            booru: 'example character (example series)',
            rating: 'sfw',
            aliases: ['示例', 'example', '小示'],
            identity: 'long silver hair, twintails, blue eyes, hair between eyes, pale skin, slender build',
            outfitName: '标志性服装·示例角色',
            outfit: 'white dress, blue ribbon, detached sleeves, thighhighs, brown boots',
            note: '一句话写她最好认的地方（发色/瞳色/标志物/服装要点）',
            minor: false,
        },
    ],
};

/** 给别的 AI 用的指令文本（复制走直接粘到 ChatGPT/Claude/DeepSeek 里） */
export const AI_PROMPT_TEXT = `你是一个动漫角色资料整理助手。请按下面的 JSON 格式，为我列出【这里填你要的角色，例如：原神里的甘雨、雷电将军】的资料。

输出要求：
1. 只输出一个 JSON 代码块，不要解释。
2. 顶层是 {"characters": [ ... ]}，数组里每个角色一个对象。
3. 字段与含义：
   - zh：中文名（必填）
   - en：英文名/罗马字
   - jp：日文名（没有就留空字符串）
   - series：作品中文名
   - seriesTag：作品的 booru tag（小写英文，例：genshin impact）
   - booru：该角色的 booru 角色 tag，形如 "名字 (作品名)"（例：ganyu (genshin impact)）。这是最关键的字段，请尽量写准。
   - rating：sfw / nsfw / galgame
   - aliases：别名、外号、简称数组（中文外号一定要写全，用于正文认人）
   - identity：外观提示词（英文 danbooru 风格 tag，逗号分隔）。**只写身体特征**：发色发型、瞳色、体型、标志物（角/耳/纹身/痣等），**不要写服装**。
   - outfitName：标志性服装的名字（中文，形如 "标志性服装·甘雨"）
   - outfit：标志性服装的英文 tag（逗号分隔）：上衣/裙裤/袜/鞋/配饰
   - note：一句话中文说明（辨识点）
   - minor：布尔值，原作里就是小孩的角色填 true，其它填 false

4. 不确定的字段留空字符串，不要编造；
5. tag 一律小写英文、用逗号+空格分隔，不要写权重括号。`;
