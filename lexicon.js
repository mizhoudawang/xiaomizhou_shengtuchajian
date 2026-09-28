/**
 * CharImageGen · 词库模块（Lexicon）
 *
 * 目标：把「SD-WebUI 里那套词库」通用地接进酒馆生图，不改工作流、不加 API 调用。
 *
 * 吃什么（自动识别，喂哪个都行，可以多个叠加）：
 *   1) prompt-all-in-one 的分类词库   group_tags/zh_CN.yaml   → 中文分类 + 中英对照 + 「动作/表情/镜头」分组
 *   2) tagcomplete 的 danbooru 标签表  tags/danbooru.csv      → 10 万 tag + 热度 + 分类 + 别名
 *   3) tagcomplete 的中文对照表        tags/danbooru.zh_CN_SFW.csv（GBK）→ 中文 → 英文
 *   4) 任何 `tag,中文` / `tag` 一行的纯文本、custom.yaml / append.yaml
 *
 * 干什么：
 *   - normalizePrompt()  出图前把提示词捋一遍：中文→英文 tag、别名→规范 tag、去重、标未知 tag
 *   - findCandidates()   从剧情/输入里找「动作、表情、镜头、场景」候选词，喂给改写用的 LLM，
 *                        让它挑词库里的规范 tag，而不是自由发挥 —— 动作更容易出得来、也更丰富
 *   - search / browse / randomFrom  面板里搜词、按分类翻词、随机抽动作
 *
 * 通用性：本文件不 import 任何酒馆模块、不碰 DOM、不认识任何模型或工作流，纯文本进纯文本出，
 * 所以可以直接在 Node 里跑单元测试（见 _lex_test.mjs）。
 */

// ------------------------------------------------------------------ 基础工具

/** 含中日韩表意文字（用来判断「这是中文，需要翻译」） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function hasCjk(s) {
    return CJK_RE.test(String(s ?? ''));
}

/**
 * 归一化 key：小写、下划线折成空格、压掉多余空白。
 * 词库里 `hair_ornament` 和提示词里 `hair ornament` 必须是同一个东西，
 * 所以查找一律走这个形式；输出也用空格形态（和 tagcomplete 默认的
 * 「下划线替换成空格」一致，SD1.5/SDXL/Pony/Illustrious 都吃）。
 */
export function normKey(s) {
    return String(s ?? '')
        .replace(/[\u3000]/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, ' ')
        .trim();
}

/**
 * 有些 tag 的下划线是语义的一部分，换成空格反而失效（Pony 系的 score_7、
 * 以及 source_anime / rating_questionable 这类）。这些一律原样保留。
 */
const KEEP_UNDERSCORE = /^(score|source|rating|year|artist|character|series|copyright)[_\s]/i;

export function outputForm(key) {
    const k = String(key ?? '').trim();
    if (KEEP_UNDERSCORE.test(k)) return k.toLowerCase().replace(/\s+/g, '_');
    return k;
}

/** 按逗号切 tag，但不切括号 / 尖括号里的逗号（`(a, b)`、`<lora:x, y>` 要当成一个）。 */
export function splitTags(text) {
    const out = [];
    let buf = '';
    let depth = 0;
    for (const ch of String(text ?? '')) {
        if ('([{<'.includes(ch)) depth++;
        else if (')]}>'.includes(ch)) depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { out.push(buf); buf = ''; } else buf += ch;
    }
    out.push(buf);
    return out.map(x => x.trim()).filter(Boolean);
}

/** 简单 CSV 一行 → 字段数组（支持双引号包裹与 "" 转义）。 */
function splitCsvLine(line) {
    const out = [];
    let buf = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"') {
                if (line[i + 1] === '"') { buf += '"'; i++; } else quoted = false;
            } else buf += c;
        } else if (c === '"') {
            quoted = true;
        } else if (c === ',') {
            out.push(buf); buf = '';
        } else buf += c;
    }
    out.push(buf);
    return out.map(x => x.trim());
}

// ------------------------------------------------------------------ 编码

/**
 * 字节 → 文本。优先严格 UTF-8；失败再按 GBK 解。
 * tagcomplete 的中文对照表是 GBK 的，直接当 UTF-8 读会得到一屏乱码，
 * 但用不严格的 UTF-8 解码不会抛错、只会塞一堆 U+FFFD —— 所以先用 fatal 试。
 */
export function decodeBytes(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { /* 不是合法 UTF-8，往下走 */ }
    for (const enc of ['gbk', 'gb18030', 'big5']) {
        try { return new TextDecoder(enc).decode(bytes); } catch { /* 环境不支持就试下一个 */ }
    }
    return new TextDecoder('utf-8').decode(bytes);
}

// ------------------------------------------------------------------ 分组标签（喂给 LLM 的中文名）

/** 词库一级分类 → 英文提示词里好认的桶名。 */
export const BUCKET_LABELS = {
    人物: 'character',
    服饰: 'outfit',
    表情动作: 'pose/expression',
    性爱: 'sex/position',
    画面: 'style',
    环境: 'environment',
    场景: 'scene',
    物品: 'props',
    镜头: 'camera',
    汉服: 'hanfu',
    魔法系: 'magic',
    反向提示词: 'negative',
};

/** 注入候选时的桶优先级：性爱体位、动作表情、镜头排最前，因为它们最影响成片。 */
export const BUCKET_ORDER = ['性爱', '表情动作', '镜头', '场景', '环境', '物品', '服饰', '人物', '画面', '魔法系', '汉服'];

/** 会触发「近义候选」展开的分组 —— 动作、镜头、体位都需要备选词。 */
export const NEAR_GROUPS = ['性爱', '表情动作', '镜头'];

export const NEGATIVE_GROUP = '反向提示词';
export const NSFW_GROUP = '性爱';

/**
 * 英文侧的露骨标记词。只看「有没有性内容」，不管体位细节 ——
 * 体位细节交给内置性爱词库（NSFW_SUBGROUPS）。
 */
export const NSFW_MARKERS = /\b(nude|naked|nipples?|areola|pussy|vagina|clitoris|penis|cock|erection|testicles|anus|anal|semen|cum|creampie|ejaculat\w*|orgasm|ahegao|futanari|dickgirl|fellatio|cunnilingus|paizuri|handjob|footjob|deepthroat|irrumatio|bondage|shibari|topless|bottomless|penetrat\w*|masturbat\w*|intercourse|sex|threesome|orgy|gangbang|spitroast|rape|netorare|lingerie|underboob|sideboob|navel|pubic)\b/i;

/**
 * 内置性爱/体位词库。
 * 为什么需要它：SD-WebUI 那套词库里根本没有「性爱」这个分类 ——
 * 中文分类词库（zh_CN.yaml）的 11 个大类全是 SFW 的；tagcomplete 的中文对照表是
 * SFW 版（danbooru.zh_CN_SFW.csv），NSFW 词一个都没有。所以光导入它们，
 * 「后入 / 骑乘 / 中出」这些词在词库里查不到，改写时也就没有候选词可以给模型 ——
 * 结果就是提示词里只有「pinned on bed, assisting」这种散文，没有体位 tag。
 *
 * 这里补上中文 → 规范 danbooru tag 的映射（顺手也进了搜索/校验/规范化）。
 * 多个中文名用 | 分隔，第一个当显示名。
 */
export const NSFW_SUBGROUPS = {
    体位: [
        'missionary: 传教士体位|正常位|男上位',
        'doggystyle: 后入式|后背位|后入|狗爬式',
        'cowgirl position: 骑乘位|女上位',
        'reverse cowgirl position: 反向骑乘位|背向女上位',
        'mating press: 屈曲位|种付位|压腿位',
        'spooning: 侧卧位|勺子式',
        'standing sex: 站立位|站立性交',
        'suspended congress: 悬空性交|抱起位|火车便当',
        'full nelson: 全纳尔逊固定|抱腿抬起',
        'prone bone: 趴卧位|压在身下后入',
        'sex from behind: 从背后插入|背后位',
        'bent over: 弯腰|俯身',
        'all fours: 四肢着地|跪趴',
        'legs up: 抬腿|双腿抬起',
        'top-down bottom-up: 上下位',
        'spread legs: 张开双腿|M字开腿',
        'amazon position: 亚马逊体位|女尊位',
        'upright straddle: 跨坐位|面对面骑乘',
        'leg lock: 双腿锁住|剪刀脚',
        'lotus position: 莲花位|盘腿位',
        'squatting: 蹲姿',
        'on back: 仰卧',
        'on stomach: 俯卧',
        'straddling: 跨坐',
    ],
    性行为: [
        'sex: 性交|做爱',
        'vaginal: 阴道性交|插入阴道',
        'penetration: 插入|贯穿',
        'deep penetration: 深度插入|顶到深处',
        'cervix: 宫颈|顶到子宫口',
        'uterus: 子宫|宫内',
        'impregnation: 受精|怀孕|播种',
        'fellatio: 口交|吹箫|含肉棒',
        'irrumatio: 主动口交|被按头',
        'deepthroat: 深喉|整根吞入',
        'cunnilingus: 舔阴|舔穴',
        'anilingus: 舔肛',
        'handjob: 手交|打手枪',
        'fingering: 手指插入|指交',
        'masturbation: 自慰|自摸',
        'paizuri: 乳交|胸推',
        'footjob: 足交',
        'thigh sex: 素股|腿交',
        'anal: 肛交|后庭',
        'kissing: 接吻',
        'french kiss: 舌吻|法式接吻',
        'making out: 激吻|热吻',
        'foreplay: 前戏',
        'breast sucking: 吸乳|吮吸乳房',
        'sucking nipples: 舔乳头|吸乳头',
        'groping: 揉胸|咸猪手|抚摸',
        'ass grab: 抓臀|揉屁股',
        'undressing: 脱衣|扒衣服',
        'clothed sex: 穿着衣服做|半脱',
        'rape: 强暴|强奸',
        'netorare: 寝取|NTR',
        'prostitution: 卖淫|嫖娼',
        'pegging: 被女人插|假阳具插男人',
        'yuri: 百合|女女',
        'yaoi: 耽美|男男',
    ],
    群交: [
        'threesome: 三人行|3P',
        'mmf threesome: 两男一女|2男1女',
        'ffm threesome: 两女一男|2女1男',
        'group sex: 群交|多人性爱',
        'orgy: 乱交|群P',
        'spitroast: 前后夹击|双穴同插',
        'double penetration: 双插|双穴插入',
        'triple penetration: 三穴插入',
        'gangbang: 轮奸|轮交',
        'bukkake: 多人颜射|射满脸',
        'futanari: 扶她|双性|人妖',
        'dickgirl: 扶她',
    ],
    体液与高潮: [
        'cum: 精液|射精',
        'cum in pussy: 内射|中出|射在里面',
        'excessive cum: 大量精液|精液泛滥',
        'cum in mouth: 射在嘴里|口爆',
        'cum on face: 脸上精液',
        'cum on breasts: 射在胸上',
        'cum on body: 射在身上',
        'facial: 颜射',
        'swallowing: 吞精|咽下',
        'precum: 前列腺液|龟头流水',
        'pussy juice: 爱液|淫水',
        'female ejaculation: 潮吹|喷水',
        'orgasm: 高潮',
        'ahegao: 阿黑颜|高潮脸',
        'torogao: 陶醉脸|失神脸',
        'fucked silly: 被干到失神',
        'mind break: 精神崩坏|被操坏',
        'moaning: 呻吟|娇喘',
        'heavy breathing: 喘息',
        'saliva: 唾液|口水|垂涎',
        'sweat: 汗|汗湿',
        'after sex: 事后',
        'afterglow: 余韵',
        'condom: 避孕套',
        'used condom: 用过的避孕套',
    ],
    束缚与道具: [
        'bondage: 束缚|捆绑',
        'shibari: 龟甲缚|日式捆绑',
        'rope: 绳子|绑绳',
        'blindfold: 眼罩|蒙眼',
        'handcuffs: 手铐',
        'collar: 项圈',
        'leash: 狗链|牵引绳',
        'collar and leash: 项圈与牵引绳',
        'gag: 口塞|口球',
        'spreader bar: 分腿杆',
        'sex toy: 性玩具|情趣用品',
        'vibrator: 按摩棒|跳蛋',
        'dildo: 假阳具',
        'anal beads: 拉珠',
        'nipple clamp: 乳夹',
        'chastity belt: 贞操带',
        'onahole: 飞机杯|自慰套',
        'sex machine: 性爱机器',
        'tentacles: 触手',
    ],
    状态与露出: [
        'completely nude: 全裸|一丝不挂',
        'topless: 上半身赤裸|露胸',
        'bottomless: 下半身赤裸|下面没穿',
        'no panties: 没穿内裤',
        'nipples: 乳头',
        'areola: 乳晕',
        'large areolae: 大乳晕',
        'pussy: 阴部|小穴|私处',
        'spread pussy: 掰开阴部|扒开小穴',
        'clitoris: 阴蒂',
        'penis: 阴茎|肉棒|阳具',
        'large penis: 巨根|大肉棒',
        'testicles: 睾丸|蛋蛋',
        'anus: 肛门|后穴',
        'pubic hair: 阴毛',
        'shaved pussy: 白虎|剃干净的私处',
        'see-through: 透视|若隐若现',
        'wet clothes: 湿衣|衣服湿透',
        'panties aside: 内裤拨开',
        'pantyhose: 连裤袜',
        'naked apron: 裸体围裙',
        'exhibitionism: 露出癖|野外露出',
        'public indecency: 公然猥亵',
        'voyeurism: 偷窥|窥视',
    ],
};

/** 把内置性爱词库灌进 lexicon。 */
export function addNsfwSeed(lex) {
    const text = [
        `- name: ${NSFW_GROUP}`,
        '  groups:',
        ...Object.entries(NSFW_SUBGROUPS).flatMap(([sub, lines]) => [
            `    - name: ${sub}`,
            '      tags:',
            ...lines.map(l => '        ' + l),
        ]),
    ].join('\n');
    lex.addYaml(text, '内置性爱体位词库');
    lex._invalidate();
    return lex;
}

// ------------------------------------------------------------------ 正文

export function createLexicon() {
    /** key → 词条 { k, zh, zhp, n, top, sub, cat, aliases:[] } */
    const canon = new Map();
    /** aliasKey → key */
    const alias = new Map();
    /** 中文 → [{ k, p }]（同一个中文可能对应多个 tag；p 是来源优先级） */
    const zhIndex = new Map();
    /** 一级分类 → 二级分类 → [key,...]（只来自分类词库，保持原始顺序） */
    const groups = new Map();
    /** 文件来源记录 */
    const sources = [];
    /**
     * 中文来源优先级：
     *   3 = 分类词库（人工整理，最可靠）
     *   2 = 用户自己的 custom.yaml / 清单
     *   1 = tagcomplete 的中文对照表（机器翻译，量大但噪声多，比如 害羞→shyi）
     * 查中文时高优先级优先；只有 1 级要过热度门槛，免得把 wh1te 这种垃圾翻出来。
     */
    const P_CURATED = 3;
    const P_USER = 2;
    const P_FLAT = 1;
    /** 1 级（机翻表）条目要被采纳，tag 至少得有这么多次使用 */
    const FLAT_MIN_COUNT = 100;
    /** 检索候选词时，1 级条目要更热才值得拿出来 */
    const FLAT_MIN_COUNT_FOR_HINT = 5000;

    /** 中文键视图的缓存（key 变了就重算） */
    let zhVersion = 0;
    let zhCache = null;
    let nsfwZhCache = null;
    function invalidate() { zhVersion++; zhCache = null; nsfwZhCache = null; }

    function ensure(key, seed) {
        let e = canon.get(key);
        if (!e) {
            e = { k: key, zh: '', zhp: 0, n: 0, top: '', sub: '', cat: -1, aliases: [] };
            canon.set(key, e);
        }
        if (seed) {
            if (seed.n && seed.n > e.n) e.n = seed.n;
            if (seed.zh && seed.zhp >= (e.zhp || 0)) { e.zh = seed.zh; e.zhp = seed.zhp; }
            if (seed.top && !e.top) { e.top = seed.top; e.sub = seed.sub || ''; }
        }
        return e;
    }

    function addAlias(a, key) {
        const ak = normKey(a);
        if (!ak || ak === key) return;
        const e = canon.get(key);
        if (e && !e.aliases.includes(ak)) e.aliases.push(ak);
        if (!alias.has(ak)) alias.set(ak, key);
    }

    function addZh(zh, key, prio = P_FLAT) {
        const z = String(zh ?? '').trim();
        if (!z) return;
        invalidate();
        const e = canon.get(key);
        if (e && prio >= (e.zhp || 0)) { e.zh = z; e.zhp = prio; }
        let list = zhIndex.get(z);
        if (!list) { list = []; zhIndex.set(z, list); }
        const old = list.find(x => x.k === key);
        if (!old) list.push({ k: key, p: prio });
        else if (prio > old.p) old.p = prio;
    }

    function groupAdd(top, sub, key) {
        let g = groups.get(top);
        if (!g) { g = new Map(); groups.set(top, g); }
        let arr = g.get(sub);
        if (!arr) { arr = []; g.set(sub, arr); }
        if (!arr.includes(key)) arr.push(key);
    }

    // -------------------------------------------------------------- 解析

    /** 分类词库 YAML（prompt-all-in-one 的 group_tags/*.yaml）。 */
    function addYaml(text, name) {
        let top = null;
        let sub = null;
        let inTags = false;
        let count = 0;
        for (const raw of String(text ?? '').split(/\r?\n/)) {
            const line = raw.replace(/\s+$/, '');
            if (!line.trim() || /^\s*#/.test(line)) continue;
            const indent = line.match(/^ */)[0].length;

            const nm = line.match(/^\s*-\s*name:\s*(.*)$/);
            if (nm) {
                const label = nm[1].trim().replace(/^["']|["']$/g, '');
                if (indent <= 2) { top = label; sub = null; inTags = false; }
                else { sub = label; inTags = false; }
                continue;
            }
            if (/^\s*tags:\s*$/.test(line)) { inTags = true; continue; }
            if (/^\s*(color|groups):/.test(line)) { inTags = false; continue; }
            if (!inTags) continue;

            // `tag: 中文`：key 里可能带冒号（`:3`、`:d` 这种颜文字），所以 key 取「最短的、
            // 让冒号后面还能接上值」的那一段 —— 用惰性匹配 + 冒号后空格来锚定。
            const m = line.match(/^\s*(\S.*?)\s*:\s?(.*)$/);
            if (!m) continue;
            const key = normKey(m[1]);
            if (!key) continue;
            // 中文名可以用 | 写多个：`missionary: 传教士体位|正常位`
            const zhList = m[2].split('|').map(x => x.trim()).filter(Boolean);
            const e = ensure(key, { top, sub });
            e.top = top || e.top;
            e.sub = sub || e.sub;
            // 倒着写进索引，让「第一个中文名」成为显示名
            for (let i = zhList.length - 1; i >= 0; i--) addZh(zhList[i], key, P_CURATED);
            groupAdd(top || '未分类', sub || '未分类', key);
            count++;
        }
        sources.push({ name, kind: '分类词库(YAML)', count });
        return count;
    }

    /** tagcomplete 标签表：`tag,分类,热度,"别名1,别名2"`。 */
    function addTagCsv(text, name) {
        let count = 0;
        for (const raw of String(text ?? '').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            const f = splitCsvLine(line);
            if (f.length < 3) continue;
            const key = normKey(f[0]);
            if (!key) continue;
            const cat = Number(f[1]);
            const n = Number(f[2]);
            if (!Number.isFinite(n) && !Number.isFinite(cat)) continue;
            const e = ensure(key, { n: Number.isFinite(n) ? n : 0 });
            if (Number.isFinite(cat)) e.cat = cat;
            if (f[3]) for (const a of splitTags(f[3])) addAlias(a, key);
            count++;
        }
        invalidate();
        sources.push({ name, kind: '标签表(CSV)', count });
        return count;
    }

    /** 中文对照表：`tag,中文`（可能 GBK）。 */
    function addTransCsv(text, name) {
        let count = 0;
        for (const raw of String(text ?? '').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            const f = splitCsvLine(line);
            if (f.length < 2) continue;
            const key = normKey(f[0]);
            if (!key) continue;
            // 两列版：第二列是中文；三列版（tag,分类,热度）不算对照表，跳过
            if (/^\d+$/.test(f[1])) continue;
            ensure(key);
            addZh(f[1], key, P_FLAT);
            count++;
        }
        sources.push({ name, kind: '中文对照(CSV)', count });
        return count;
    }

    /** 纯文本一行一个 tag，或 `tag,中文`。 */
    function addList(text, name) {
        let count = 0;
        for (const raw of String(text ?? '').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const f = splitCsvLine(line);
            const key = normKey(f[0]);
            if (!key) continue;
            ensure(key);
            if (f[1] && hasCjk(f[1])) addZh(f[1], key, P_USER);
            count++;
        }
        sources.push({ name, kind: '清单', count });
        return count;
    }

    /** 自动认格式后解析。 */
    function addText(name, text) {
        const body = String(text ?? '');
        const head = body.slice(0, 4000);
        if (/\.ya?ml$/i.test(name || '') || /^\s*-\s*name:\s*/m.test(head)) return addYaml(body, name);
        // 找第一条数据行判断 CSV 形态
        const first = body.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('#')) || '';
        const f = splitCsvLine(first.trim());
        if (f.length >= 3 && /^\d+$/.test(f[1])) return addTagCsv(body, name);
        if (f.length === 2 && hasCjk(f[1])) return addTransCsv(body, name);
        return addList(body, name);
    }

    // -------------------------------------------------------------- 查询

    function lookup(tag) {
        const k = normKey(tag);
        if (!k) return null;
        if (canon.has(k)) return canon.get(k);
        const a = alias.get(k);
        return a ? canon.get(a) : null;
    }

    /** 任意写法 → 规范 key（别名、下划线、大小写都能收）。认不出返回 ''。 */
    function resolve(tag) {
        const k = normKey(tag);
        if (!k) return '';
        if (canon.has(k)) return k;
        const a = alias.get(k);
        return a && canon.has(a) ? a : '';
    }

    /** 候选够不够格当翻译结果：人工整理的一律算，机翻表条目要够热。 */
    function qualified(it, minCount = FLAT_MIN_COUNT) {
        if (it.p >= P_USER) return true;
        return (canon.get(it.k)?.n || 0) >= minCount;
    }

    /** 同一中文对应多个 tag 时：先比来源优先级，再比热度。 */
    function bestOf(list) {
        let best = '';
        let bp = -1;
        let bn = -1;
        for (const it of list) {
            const n = canon.get(it.k)?.n || 0;
            if (it.p > bp || (it.p === bp && n > bn)) { best = it.k; bp = it.p; bn = n; }
        }
        return best;
    }

    /**
     * 中文 → 规范 key。三级匹配：
     *   ① 完全相同            拥抱   → hug
     *   ② 中文词是查询的一部分  笑得很开心 ⊃ 笑得
     *   ③ 查询是中文词的一部分  害羞   ⊂ 害羞的 → shy（机翻表把 害羞 对成了冷门 tag shyi，
     *                          靠这一级退回人工整理的「害羞的」）
     * 每一级都按「来源优先级 → 热度」挑；机翻表条目要过热度门槛。
     */
    function fromZh(text, { substring = true } = {}) {
        const t = String(text ?? '').trim();
        if (!t || !hasCjk(t)) return '';
        const exact = zhIndex.get(t);
        if (exact) {
            const ok = exact.filter(it => qualified(it));
            if (ok.length) return bestOf(ok);
        }
        if (!substring || t.length < 2) return '';
        const arr = zhLists().all;
        // ② 查询里包含的中文词：取最长的（最具体）。arr 已按长度倒序，命中即可收工。
        let best = '';
        let bestLen = 0;
        for (const zh of arr) {
            if (zh.length <= bestLen) break;
            if (!t.includes(zh)) continue;
            const ok = (zhIndex.get(zh) || []).filter(it => qualified(it));
            if (!ok.length) continue;
            best = bestOf(ok);
            bestLen = zh.length;
        }
        if (best) return best;
        // ③ 中文词里包含查询：取最短的（最贴近）。倒着走，第一个命中的就是最短的。
        for (let i = arr.length - 1; i >= 0; i--) {
            const zh = arr[i];
            if (zh.length <= t.length) continue;
            if (!zh.includes(t)) continue;
            const ok = (zhIndex.get(zh) || []).filter(it => qualified(it));
            if (!ok.length) continue;
            return bestOf(ok);
        }
        return '';
    }

    function isKnown(tag) {
        return !!resolve(tag);
    }

    function stats() {
        return {
            tags: canon.size,
            zh: zhIndex.size,
            alias: alias.size,
            groups: groups.size,
            sources: sources.map(x => `${x.name}（${x.kind} ${x.count}）`),
        };
    }

    function categories() {
        const out = [];
        for (const [top, subs] of groups) {
            const list = [];
            for (const [sub, keys] of subs) list.push({ name: sub, count: keys.length });
            out.push({ name: top, count: list.reduce((a, b) => a + b.count, 0), subs: list });
        }
        return out;
    }

    function browse(top, sub) {
        const g = groups.get(top);
        if (!g) return [];
        const keys = sub ? (g.get(sub) || []) : [...g.values()].flat();
        return keys.map(k => canon.get(k)).filter(Boolean);
    }

    function search(query, { limit = 40, top = '', sub = '' } = {}) {
        const q = String(query ?? '').trim().toLowerCase();
        const qk = normKey(q);
        const scored = [];
        const pool = (top || sub) ? browse(top, sub) : [...canon.values()];
        for (const e of pool) {
            let score = -1;
            if (qk && e.k === qk) score = 0;
            else if (e.zh && e.zh === q) score = 1;
            else if (qk && e.k.startsWith(qk)) score = 2;
            else if (e.zh && e.zh.startsWith(q)) score = 3;
            else if (qk && qk.length >= 2 && e.k.includes(qk)) score = 4;
            else if (q.length >= 2 && e.zh && e.zh.includes(q)) score = 5;
            else if (qk.length >= 2 && e.aliases.some(a => a.includes(qk))) score = 6;
            if (score < 0) continue;
            // 同类命中里：人工整理的分类词库排前面，机翻表里那些「拥抱它！ precure」往后站
            scored.push({ e, score, flat: e.top ? 0 : 1 });
        }
        scored.sort((a, b) => (a.score - b.score) || (a.flat - b.flat)
            || ((b.e.n || 0) - (a.e.n || 0)) || a.e.k.localeCompare(b.e.k));
        return scored.slice(0, limit).map(x => x.e);
    }

    function randomFrom(top, sub, n = 3, exclude = []) {
        const skip = new Set(exclude.map(normKey));
        const pool = browse(top, sub).filter(e => !skip.has(e.k));
        const out = [];
        while (out.length < n && pool.length) {
            out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].k);
        }
        return out;
    }

    // -------------------------------------------------------------- 提示词规范化

    /** 拆掉 `(tag:1.2)` / `[tag]` / `{tag}` 这层壳，返回 {inner, open, close, weight}。 */
    function unwrap(tok) {
        const m = String(tok).match(/^([([{]+)\s*([\s\S]*?)\s*(?::\s*([0-9.]+))?\s*([)\]}]+)$/);
        if (!m) return null;
        return { open: m[1], inner: m[2], close: m[4], weight: m[3] || '' };
    }

    /**
     * 把一个 token 变成规范形态。
     * 返回 { out, kind } —— kind: keep | unknown | translated | fixed | same
     */
    function normalizeToken(tok) {
        const raw = String(tok).trim();
        // LoRA / embedding / 酒馆宏 / 通配符：不碰
        if (/^<[\s\S]*>$/.test(raw)) return { out: raw, kind: 'keep' };
        if (/\{\{|\}\}|__/.test(raw)) return { out: raw, kind: 'keep' };

        const w = unwrap(raw);
        const inner = w ? w.inner : raw;
        const wrap = (s) => (w ? `${w.open}${s}${w.weight ? ':' + w.weight : ''}${w.close}` : s);

        if (!inner.trim()) return { out: '', kind: 'drop' };

        // 1) 中文 → 英文 tag
        if (hasCjk(inner)) {
            const key = fromZh(inner);
            if (key) return { out: wrap(outputForm(key)), kind: 'translated', key };
            return { out: raw, kind: 'unknown' };
        }

        // 2) 英文 → 查表（别名归一 / 下划线折空格）
        const key = resolve(inner);
        if (!key) return { out: raw, kind: 'unknown' };
        const nice = outputForm(key);
        const same = nice === inner;
        return { out: wrap(nice), kind: same ? 'same' : 'fixed', key };
    }

    /**
     * 提示词规范化。
     * opts.translate     中文转英文（默认开）
     * opts.canonical     别名/写法归一（默认开）
     * opts.dedupe        去重（默认开）
     * opts.dropUnknown   把查不到的 tag 丢掉（默认关；默认只报告不动手）
     * 返回 { text, changed, translated, unknown, kept }
     */
    function normalizePrompt(text, opts = {}) {
        const { translate = true, canonical = true, dedupe = true, dropUnknown = false } = opts;
        const out = [];
        const seen = new Set();
        const changed = [];
        const translated = [];
        const unknown = [];
        // 中文标点也当分隔符，不然「拥抱，微笑」会被当成一个整体
        for (const tok of splitTags(String(text ?? '').replace(/[，、；;]/g, ','))) {
            let r = normalizeToken(tok);
            if (r.kind === 'translated' && !translate) r = { out: tok, kind: 'unknown' };
            if (r.kind === 'fixed' && !canonical) r = { out: tok, kind: 'same' };
            if (r.kind === 'unknown') {
                unknown.push(tok);
                if (dropUnknown) continue;
            }
            if (!r.out) continue;
            if (dedupe) {
                const dk = normKey(r.out);
                if (seen.has(dk)) continue;
                seen.add(dk);
            }
            if (r.kind === 'translated') translated.push(`${tok} → ${r.out}`);
            if (r.kind === 'fixed') changed.push(`${tok} → ${r.out}`);
            out.push(r.out);
        }
        return { text: out.join(', '), changed, translated, unknown };
    }

    /** 只报告不修改：列出提示词里词库查不到的 tag。 */
    function unknownTags(text) {
        const out = [];
        for (const tok of splitTags(text)) {
            const raw = tok.trim();
            if (!raw || /^<[\s\S]*>$/.test(raw) || /\{\{|\}\}|__/.test(raw)) continue;
            const w = unwrap(raw);
            const inner = (w ? w.inner : raw).trim();
            if (!inner) continue;
            if (hasCjk(inner)) { if (!fromZh(inner)) out.push(raw); continue; }
            if (!resolve(inner)) out.push(raw);
        }
        return out;
    }

    /** 「性爱」分组里的中文说法，用来判断一段文字是不是 NSFW 场景。 */
    function nsfwZhKeys() {
        if (nsfwZhCache) return nsfwZhCache;
        const keys = new Set();
        const g = groups.get(NSFW_GROUP);
        if (g) for (const arr of g.values()) for (const k of arr) keys.add(k);
        const out = [];
        for (const [zh, list] of zhIndex) {
            if (zh.length < 2 || !hasCjk(zh)) continue;
            if (list.some(it => keys.has(it.k))) out.push(zh);
        }
        nsfwZhCache = out;
        return out;
    }

    /**
     * 这段提示词是不是 NSFW。
     * 英文看解剖/性行为标记词，中文看内置性爱词库里的说法 —— 两边都不看模型，
     * 只做「有没有露骨的性内容」这个判断，用来决定要不要把 rating 从 safe 换成 explicit。
     */
    function isNsfw(text) {
        const t = String(text ?? '');
        if (!t) return false;
        if (NSFW_MARKERS.test(t)) return true;
        return nsfwZhKeys().some(zh => t.includes(zh));
    }

    // -------------------------------------------------------------- 候选词检索（RAG）

    /**
     * 中文键的两种视图（按长度倒序缓存）：
     *   all  —— 全部中文键，用于「查询里包含中文词」的最长匹配
     *   hint —— 只留够可靠的（人工整理，或机翻表里特别热的），用于从剧情里挖候选词。
     *           不筛的话「白色」会命中 wh1te / dirndl 这种垃圾。
     */
    /** 按热度取前 n 个（没热度数据的按原始顺序），排除已经命中的。 */
    function topByPop(list, exclude, n) {
        return list
            .filter(e => e && !exclude.has(e.k))
            .sort((a, b) => (b.n || 0) - (a.n || 0))
            .slice(0, n);
    }

    function zhLists() {
        if (zhCache && zhCache.v === zhVersion) return zhCache;
        const all = [];
        const hint = [];
        for (const [zh, list] of zhIndex) {
            if (zh.length < 2 || !hasCjk(zh)) continue;
            all.push(zh);
            if (list.some(it => qualified(it, FLAT_MIN_COUNT_FOR_HINT))) hint.push(zh);
        }
        const desc = (a, b) => b.length - a.length;
        all.sort(desc);
        hint.sort(desc);
        zhCache = { v: zhVersion, all, hint };
        return zhCache;
    }

    /**
     * 从一段文字（剧情/输入）里挖出可用的提示词候选。
     * - 命中文字里出现的中文词 → 对应的规范 tag（剧情里正在发生的动作）
     * - 同一子分类里再挑几个「同义/近义动作」当备选 —— 让 LLM 有得挑，
     *   出图动作才会丰富，而不是每次都 hug
     * 返回 { buckets: [{ top, label, hits:[], near:[] }], hits:[], near:[] }
     */
    function findCandidates(text, { perBucket = 8, nearCount = 4, buckets = BUCKET_ORDER, maxHits = 60, groupSex = false } = {}) {
        const body = String(text ?? '');
        const hitKeys = new Set();
        if (body.trim()) {
            for (const zh of zhLists().hint) {
                if (hitKeys.size >= maxHits) break;
                if (!body.includes(zh)) continue;
                const ok = (zhIndex.get(zh) || []).filter(it => qualified(it, FLAT_MIN_COUNT_FOR_HINT));
                for (const it of ok) hitKeys.add(it.k);
            }
            // 文字里已经写出来的英文 tag 也算命中
            for (const tok of splitTags(body)) {
                const raw = tok.trim();
                if (!raw || hasCjk(raw)) continue;
                const w = unwrap(raw);
                const key = resolve(w ? w.inner : raw);
                if (key) hitKeys.add(key);
            }
        }

        const nearKeys = new Set();
        const byTop = new Map();
        const push = (top, e, kind) => {
            if (!top) return;
            if (!byTop.has(top)) byTop.set(top, { top, hits: [], near: [], first: [] });
            const b = byTop.get(top);
            if (kind === 'hit') { if (!b.hits.includes(e.k)) b.hits.push(e.k); }
            else if (kind === 'first') { if (!b.first.includes(e.k) && !b.near.includes(e.k)) b.first.push(e.k); }
            else if (!b.near.includes(e.k)) b.near.push(e.k);
        };

        for (const k of hitKeys) {
            const e = canon.get(k);
            if (!e) continue;
            push(e.top || '未分类', e, 'hit');
            // 同子分类的近义动作 / 近义体位
            if (nearCount > 0 && NEAR_GROUPS.includes(e.top)) {
                const sibs = browse(e.top, e.sub).filter(x => !hitKeys.has(x.k));
                sibs.sort((a, b) => (b.n || 0) - (a.n || 0));
                for (const s of sibs.slice(0, nearCount)) { nearKeys.add(s.k); push(e.top, s, 'near'); }
            }
        }

        // 只要这一场沾了性，就把「体位库」整批推过去当备选。
        // 剧情里通常只写「压在身下」「贯穿」这类叙述，不会明说「后入式」——
        // 不主动给体位词，改写出来的就永远是散文，没有体位 tag。
        const sexBucket = byTop.get(NSFW_GROUP);
        if (sexBucket) {
            const hasPosition = sexBucket.hits.some(k => canon.get(k)?.sub === '体位');
            if (!hasPosition) {
                for (const s of topByPop(browse(NSFW_GROUP, '体位'), hitKeys, nearCount + 6)) {
                    nearKeys.add(s.k);
                    push(NSFW_GROUP, s, 'first');
                }
            }
            // 画面里三个人以上 → 群体体位也得给，不然模型只会画两个人
            if (groupSex) {
                for (const s of topByPop(browse(NSFW_GROUP, '群交'), hitKeys, 5)) {
                    nearKeys.add(s.k);
                    push(NSFW_GROUP, s, 'first');
                }
            }
        }

        const order = (t) => {
            const i = buckets.indexOf(t);
            return i < 0 ? 99 : i;
        };
        const list = [...byTop.values()]
            .filter(b => b.top !== NEGATIVE_GROUP)
            .sort((a, b) => order(a.top) - order(b.top))
            .map(b => ({
                top: b.top,
                label: BUCKET_LABELS[b.top] || b.top,
                hits: b.hits.slice(0, perBucket),
                // 性爱桶多给几个：体位是这场戏的重点，少了挑不出来
                near: [...(b.first || []), ...b.near]
                    .slice(0, b.top === NSFW_GROUP ? Math.max(nearCount, 6) + 6 : Math.max(nearCount, 6)),
            }))
            .filter(b => b.hits.length || b.near.length);

        return {
            buckets: list,
            hits: list.flatMap(b => b.hits),
            near: list.flatMap(b => b.near),
        };
    }

    /** 候选词 → 塞进改写提示词的一段文字。没有候选返回 ''。 */
    function candidatesToHint(cand) {
        if (!cand || !cand.buckets.length) return '';
        const lines = ['【词库候选 · 优先用下面的规范 tag，候选里没有合适的再自己写】'];
        for (const b of cand.buckets) {
            if (b.hits.length) lines.push(`${b.label}（剧情里已经出现的）: ${b.hits.map(outputForm).join(', ')}`);
            if (b.near.length) lines.push(`${b.label}（可替换的近义词）: ${b.near.map(outputForm).join(', ')}`);
        }
        return lines.join('\n');
    }

    return {
        // 解析
        addText,
        addYaml,
        addTagCsv,
        addTransCsv,
        addList,
        // 查询
        lookup,
        resolve,
        isKnown,
        fromZh,
        isNsfw,
        stats,
        categories,
        browse,
        search,
        randomFrom,
        unknownTags,
        // 规范化 / 检索
        normalizePrompt,
        findCandidates,
        candidatesToHint,
        // 内部维护
        _invalidate: invalidate,
        _canon: canon,
    };
}

/**
 * 从 IndexedDB 里恢复时用：把存下来的原文一条条喂回去。
 * 无论导没导词库，都先灌两份内置种子：
 *   · 性爱/体位词库  —— SD-WebUI 那套词库里没有这个分类，不补就永远检索不到体位
 *   · 兜底动作/镜头  —— 一条词库都没导时也不至于空手
 */
export function buildLexiconFromSources(list, { seeds = true } = {}) {
    const lex = createLexicon();
    if (seeds) {
        try { addNsfwSeed(lex); } catch (err) { console.warn('[CharImageGen] 内置性爱词库加载失败', err); }
    }
    for (const it of list || []) {
        try { lex.addText(it.name, it.text); } catch (err) { console.warn('[CharImageGen] 词库解析失败', it.name, err); }
    }
    if (seeds) {
        try { addFallback(lex); } catch (err) { console.warn('[CharImageGen] 内置兜底词库加载失败', err); }
    }
    return lex;
}

/** 内置兜底：一条词库都没有时，至少让「随机动作/镜头」有货。 */
export const FALLBACK_GROUPS = {
    表情动作: {
        基础动作: ['standing', 'sitting', 'lying', 'kneeling', 'walking', 'running', 'jumping', 'hug', 'hug from behind', 'carrying', 'bridal carry', 'piggyback ride', 'holding hands', 'stretching', 'leaning forward', 'arms behind back', 'arms up', 'crossed arms', 'hand on hip', 'reaching out'],
        手部动作: ['hand on own cheek', 'hand on own chest', 'hand up', 'waving', 'pointing', 'peace sign', 'thumbs up', 'holding cup', 'holding phone', 'holding book'],
        腿部动作: ['legs crossed', 'crossed legs', 'knees up', 'leg up', 'spread legs', 'tiptoes'],
        其他表情: ['smile', 'grin', 'blush', 'embarrassed', 'surprised', 'crying', 'tears', 'pout', 'angry', 'serious', 'smirk', 'half-closed eyes', 'empty eyes', 'parted lips', 'open mouth', 'closed eyes'],
    },
    镜头: {
        镜头: ['close-up', 'portrait', 'upper body', 'full body', 'cowboy shot', 'wide shot'],
        镜头角度: ['from above', 'from below', 'from behind', 'from side', 'dutch angle', 'facing viewer', 'profile'],
        其他构图: ['character sheet', 'multiple views', 'symmetrical docking', 'rule of thirds'],
    },
};

/** 把兜底词库灌进 lexicon（只在空词库时用）。 */
export function addFallback(lex) {
    lex.addYaml(
        Object.entries(FALLBACK_GROUPS).map(([top, subs]) => [
            `- name: ${top}`,
            '  groups:',
            ...Object.entries(subs).flatMap(([sub, keys]) => [
                `    - name: ${sub}`,
                '      tags:',
                ...keys.map(k => `        ${k}: `),
            ]),
        ].join('\n')).join('\n'),
        '内置兜底词库',
    );
    lex._invalidate();
    return lex;
}
