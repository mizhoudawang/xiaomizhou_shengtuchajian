/**
 * 服装「差分」判定（纯模块，不依赖酒馆，方便单测）
 * ------------------------------------------------------------------
 * 用户定的语义：
 *   · **差分** = 同一套衣服的不同状态：原装 / 破损 / 脱了一部分 / 换了一部分（配饰、袜子、鞋、颜色…）
 *   · **只是长得像的两套衣服** → 不算差分，也不能因为 tag 相似就并成一个分类
 *   · **过于相近（只差措辞、或只换了个小首饰）** → 没必要存第二条，直接复用原来那条
 *
 * 判定顺序：
 *   1. 抽出「主体衣物名词」（dress / skirt / shirt / kimono / uniform …，注意是从整条 tag 里抽名词，
 *      不是拿整条 'torn white dress' 当主体）
 *   2. 主体不同 → 就是两套衣服，各自开分类（哪怕 tag 很像）
 *   3. 主体相同 → 去掉状态词再比：
 *        · 去掉后完全一致            → 纯状态变化 = 差分
 *        · 只剩小配饰差异            → 太像，复用
 *        · 其它差异（换鞋/袜/帽/外层/颜色…） → 差分
 */

/** 主体衣物：决定「是不是同一套衣服」。外层（外套/披风）算部件，不算主体。 */
const CORE_GARMENTS = [
    'dress', 'sundress', 'gown', 'skirt', 'shirt', 'blouse', 't-shirt', 'tee', 'tank top', 'camisole', 'tube top',
    'sweater', 'sweatshirt', 'turtleneck', 'kimono', 'yukata', 'cheongsam', 'qipao', 'hanfu', 'sari', 'robe',
    'uniform', 'serafuku', 'suit', 'tuxedo', 'vest', 'corset', 'bodysuit', 'leotard', 'swimsuit', 'bikini',
    'nightgown', 'negligee', 'pajamas', 'pyjamas', 'overalls', 'jumpsuit', 'romper', 'shorts', 'pants',
    'trousers', 'jeans', 'leggings', 'apron dress', 'wedding dress', 'sportswear', 'jersey', 'tunic',
];

/** 部件/配饰：换这些 = 「换了一部分」，仍算同一套衣服 */
const PARTS = [
    'jacket', 'coat', 'cardigan', 'hoodie', 'cape', 'capelet', 'cloak', 'shawl', 'bolero', 'blazer', 'parka',
    'socks', 'thighhighs', 'thigh-highs', 'stockings', 'pantyhose', 'tights', 'kneehighs', 'shoes', 'boots',
    'sandals', 'loafers', 'heels', 'high heels', 'sneakers', 'slippers', 'hat', 'cap', 'beret', 'headband',
    'hairband', 'headdress', 'maid headdress', 'ribbon', 'bow', 'hair bow', 'hair ornament', 'hair flower',
    'hairclip', 'gloves', 'mittens', 'choker', 'necktie', 'tie', 'scarf', 'collar', 'sailor collar', 'ascot',
    'neckerchief', 'earmuffs', 'goggles', 'glasses', 'sunglasses', 'eyepatch', 'mask', 'monocle', 'veil',
    'belt', 'sash', 'obi', 'armband', 'bandages', 'armor', 'pauldron', 'pauldrons', 'breastplate', 'gauntlets',
    'apron', 'tail', 'wings', 'undershirt', 'bra', 'panties', 'underwear', 'bloomers', 'garter belt',
];

/** 小配饰：只差这些的话算「太像」，不值得单开一条 */
const MINOR_PARTS = [
    'jewelry', 'earrings', 'earring', 'necklace', 'bracelet', 'ring', 'rings', 'bag', 'backpack', 'purse',
    'chain', 'gem', 'pendant', 'hairpin', 'choker',
];

/** 状态词：出现这些词 = 「同一套衣服的不同状态」= 正牌差分 */
const STATE_WORDS = [
    'torn', 'ripped', 'damaged', 'frayed', 'shredded', 'wet', 'soaked', 'drenched', 'damp', 'stained', 'dirty',
    'muddy', 'bloodstained', 'dusty', 'wrinkled', 'disheveled', 'messy', 'untidy', 'loose', 'undone', 'unbuttoned',
    'unzipped', 'open', 'opened', 'pulled down', 'pulled up', 'pulled aside', 'pushed up', 'pushed down',
    'rolled up', 'rolled down', 'slipped', 'slipping', 'slid down', 'hanging off', 'half off', 'off shoulder',
    'one shoulder', 'partially unclothed', 'partially undressed', 'partially nude', 'partially removed',
    'clothing aside', 'clothes aside', 'topless', 'bottomless', 'naked', 'nude', 'undressed', 'removed', 'discarded',
    'around one leg', 'around knees', 'around waist', 'to waist', 'above chest', 'bare', 'exposed', 'see-through',
    'transparent', 'translucent', 'torn clothes', 'shirt lift', 'clothes lift', 'skirt lift', 'lifted',
    'unfastened', 'unhooked', 'slipping off', 'falling off', 'hanging down',
];

const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 生成「按词匹配」的正则：词会作为整体命中，返回第 2 组 */
const wordRe = (arr, flags = 'i') => new RegExp(`(^|[^a-z0-9])(${arr.map(esc).join('|')})([^a-z0-9]|$)`, flags);

const CORE_RE = wordRe(CORE_GARMENTS);
const PART_RE = wordRe(PARTS);
const MINOR_RE = wordRe(MINOR_PARTS);
const STATE_RE = wordRe(STATE_WORDS);

/** 把 tag 串拆成规范 token（去权重括号、小写、去重、保序） */
export function tokensOf(tags) {
    const seen = new Set();
    const out = [];
    for (const raw of String(tags ?? '').split(',')) {
        let t = raw.trim().toLowerCase();
        t = t.replace(/^\(+/, '').replace(/\)+$/, '');
        t = t.replace(/:\s*[\d.]+$/, '').trim();
        t = t.replace(/\s{2,}/g, ' ');
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

/** 从一条 tag 里抽出所有命中的「主体衣物名词」 */
function nounsIn(text, re) {
    const out = [];
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(text)) !== null) {
        out.push(String(m[2]).toLowerCase());
        if (m.index === g.lastIndex) g.lastIndex++;      // 防零宽死循环
    }
    return out;
}

const hasCore = t => CORE_RE.test(t);
const isState = t => STATE_RE.test(t);
const isMinor = t => MINOR_RE.test(t) && !PART_RE.test(t.replace(MINOR_RE, ' '));

/** 主体衣物集合：返回的是**名词**（dress / kimono…），不是整条 tag */
export function coreGarmentsOf(tags) {
    const out = new Set();
    for (const t of tokensOf(tags)) for (const n of nounsIn(t, CORE_RE)) out.add(n);
    return out;
}

/**
 * 主件：tag 串里**第一条**主体衣物名词（'school uniform, …, unbuttoned shirt' 的主件是 uniform）。
 * 判定「是不是同一套衣服」只看主件 —— 不然「校服里脱了件衬衫」会被当成两套不同的衣服。
 */
export function primaryGarmentOf(tags) {
    for (const t of tokensOf(tags)) {
        const n = nounsIn(t, CORE_RE);
        if (n.length) return n[0];
    }
    return '';
}

/** 部件指纹：把「鞋/袜/手套/帽子…」按词归类，用于判断换了哪一部分 */
export function partsOf(tags) {
    const map = new Map();
    for (const t of tokensOf(tags)) {
        for (const n of nounsIn(t, PART_RE)) {
            if (!map.has(n)) map.set(n, new Set());
            map.get(n).add(t);
        }
    }
    return map;
}

export function tagJaccard(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    return inter / (setA.size + setB.size - inter);
}

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

/** 去掉状态词（torn / pulled down / …）后的骨架 */
export function stripStateWords(tags) {
    return tokensOf(tags).map(t => {
        let x = ` ${t} `;
        for (const w of STATE_WORDS) x = x.split(` ${w} `).join(' ').split(`${w} `).join(' ').split(` ${w}`).join(' ');
        return x.replace(/\s{2,}/g, ' ').trim();
    }).filter(Boolean);
}

const R = (kind, reason, extra = {}) => ({ kind, reason, ...extra });

/**
 * 比较两套服装。
 * @returns {{kind:'same'|'variant'|'different', reason:string, coreA?:string[], coreB?:string[]}}
 */
export function compareOutfits(aTags, bTags) {
    const A = tokensOf(aTags), B = tokensOf(bTags);
    if (sameSet(new Set(A), new Set(B))) return R('same', 'tag 完全一样');
    if (!A.length || !B.length) return R('different', '有一边是空的');

    const mainA = primaryGarmentOf(aTags), mainB = primaryGarmentOf(bTags);
    const coreA = [...coreGarmentsOf(aTags)], coreB = [...coreGarmentsOf(bTags)];
    if (!(mainA && mainB && mainA === mainB)) {
        if (!mainA && !mainB && tagJaccard(new Set(A), new Set(B)) >= 0.6) return R('same', '都没写主体衣物、但高度重合');
        return R('different', `主体衣物不同（${mainA || '无'} vs ${mainB || '无'}）`, { coreA, coreB });
    }

    const A2 = stripStateWords(aTags), B2 = stripStateWords(bTags);
    const setA2 = new Set(A2), setB2 = new Set(B2);
    const stateWordsSeen = A.join(' ') !== A2.join(' ') || B.join(' ') !== B2.join(' ');

    // 去掉状态词后完全一致 → 纯状态差分（破损/半脱/敞开…）
    if (stateWordsSeen && sameSet(setA2, setB2)) return R('variant', '同一套衣服的状态变化（破损 / 半脱 / 敞开…）', { coreA });

    const restDiff = [...A2.filter(t => !setB2.has(t)), ...B2.filter(t => !setA2.has(t))];
    if (restDiff.length === 0) {
        return R('same', stateWordsSeen ? '差异只是状态词写法' : '差异只是措辞');
    }
    if (restDiff.every(isMinor) && restDiff.length <= 2) return R('same', `只换了小配饰（${restDiff.join('、')}）`);
    return R('variant', `换了部件或颜色（${restDiff.slice(0, 4).join('、')}）`, { coreA });
}

/** 是不是「同一件主体」——自动归类只用这个，不再拿 tag 相似度硬并 */
export function sameGarment(aTags, bTags) {
    const ma = primaryGarmentOf(aTags), mb = primaryGarmentOf(bTags);
    if (ma && mb) return ma === mb;
    if (!ma && !mb) return tagJaccard(new Set(tokensOf(aTags)), new Set(tokensOf(bTags))) >= 0.6;
    return false;
}

/**
 * 在已有服装里给新 tag 找归宿。
 * @returns {{kind:'same'|'variant'|'different', name?:string, reason:string}}
 */
export function classifyOutfit(newTags, existing /* [[name, tags], …] */) {
    let variantHit = null;
    for (const [name, tags] of existing || []) {
        const r = compareOutfits(newTags, tags);
        if (r.kind === 'same') return { kind: 'same', name, reason: r.reason };
        if (r.kind === 'variant' && !variantHit) variantHit = { kind: 'variant', name, reason: r.reason };
    }
    if (variantHit) return variantHit;
    return { kind: 'different', reason: '没找到同一主体的衣服' };
}

/** 自动归类：按「主体衣物相同」聚簇（两边都没写主体时退回 tag 相似度） */
export function groupByGarment(entries /* [[name, tags], …] */, fallbackThreshold = 0.45) {
    const names = entries.map(e => e[0]);
    const parent = new Map(names.map(n => [n, n]));
    const find = x => { let r = x; while (parent.get(r) !== r) r = parent.get(r); return r; };
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            if (!sameGarment(entries[i][1], entries[j][1])) {
                const ma = primaryGarmentOf(entries[i][1]), mb = primaryGarmentOf(entries[j][1]);
                if (ma || mb) continue;                                 // 有主件但不同 → 绝不并
                if (tagJaccard(new Set(tokensOf(entries[i][1])), new Set(tokensOf(entries[j][1]))) < fallbackThreshold) continue;
            }
            const ra = find(entries[i][0]), rb = find(entries[j][0]);
            if (ra !== rb) parent.set(ra, rb);
        }
    }
    const clusters = new Map();
    for (const n of names) {
        const r = find(n);
        if (!clusters.has(r)) clusters.set(r, []);
        clusters.get(r).push(n);
    }
    return [...clusters.values()];
}
