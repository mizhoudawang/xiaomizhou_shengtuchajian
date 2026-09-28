/**
 * 「谁在画面里」+「多个人怎么落成提示词」的纯逻辑。
 *
 * 不 import 任何酒馆模块、不碰 DOM，所以可以拿真实聊天记录在 Node 里直接跑
 * （见 _test_castmatch.mjs）—— 上一个人名匹配的坑（正文只写名不写姓、
 * 玩家那句没有主语）就是这么踩出来的。
 */
import { splitTags } from './lexicon.js';

/** 一个人的可匹配名字：全名 + 名字后缀（正文里常只写名，例如全名「山田美咲」正文里只写「美咲」）。 */
export function nameKeysOf(label) {
    const s = String(label || '').trim();
    if (s.length < 2) return [];
    const keys = [s];
    // 后缀切分是给中日文名的（「山田美咲」→「美咲」）；英文名切出来的 ng/ao
    // 会命中 running / Taoism 这类普通词，所以只对含中日文的标签做
    if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(s)) {
        if (s.length >= 3) keys.push(s.slice(-2));
        if (s.length >= 4) keys.push(s.slice(-3));
    }
    return [...new Set(keys)].filter(k => k.length >= 2);
}

/** 在正文里找名字：中日文直接 indexOf；纯 ASCII 按单词边界（ling 不该命中 lingerie）。 */
function findKey(text, key) {
    if (!/^[\x00-\x7F]+$/.test(key)) return text.indexOf(key);
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(^|[^A-Za-z0-9_])' + esc + '(?![A-Za-z0-9_])', 'i').exec(text);
    return m ? m.index + (m[1] ? m[1].length : 0) : -1;
}

/**
 * 从正文里认人。
 * @param scene    正文（最近几条消息 + 输入框）
 * @param subjects [{ id, label }]，id 由调用方定义（插件里是角色名 / __player__）
 * @returns [{ id, index, len }]，按在正文里出现的先后排序 —— 位置词的左右就按这个来
 *
 * 规则：
 *   · 全名优先，其次名字后缀（「美咲」也能认出「山田美咲」）
 *   · 同一个短名被多人共用（两个角色都叫美咲）→ 该短名作废，不猜
 *   · 匹配范围被更长名字包住时丢掉，避免同一个人算两次
 */
export function matchSubjects(scene, subjects) {
    const text = String(scene || '');
    if (!text) return [];
    const list = (subjects || []).filter(x => x && x.label && String(x.label).length >= 2);
    const owner = new Map();
    for (const sub of list) {
        for (const k of nameKeysOf(sub.label)) {
            if (!owner.has(k)) owner.set(k, new Set());
            owner.get(k).add(sub.id);
        }
    }
    const hits = [];
    for (const sub of list) {
        let best = -1;
        let bestLen = 0;
        for (const k of nameKeysOf(sub.label)) {
            if ((owner.get(k)?.size || 0) > 1) continue;
            const i = findKey(text, k);
            if (i < 0) continue;
            if (best < 0 || i < best || (i === best && k.length > bestLen)) { best = i; bestLen = k.length; }
        }
        if (best >= 0) hits.push({ id: sub.id, index: best, len: bestLen });
    }
    const keep = hits.filter(a => !hits.some(b => b !== a && b.len > a.len && b.index <= a.index && b.index + b.len > a.index));
    keep.sort((a, b) => a.index - b.index);
    return keep;
}

/**
 * 用户这一句是不是「玩家自己的动作」。
 * RP 里用户经常写无主语的祈使句（「顺势翻身将她压在身下」），这种人就是在画面里的；
 * 但「继续」「在旁边围观」这种推进/旁观指令不算。
 * 旁观词放在第一人称之前判：否则「我在旁边围观」会被「我」抢先判成动作。
 */
export function looksLikePlayerAction(text) {
    const raw = String(text || '');
    if (!raw.trim()) return false;
    if (/旁观|围观|远远地|退到一边|躲在一旁|只在旁边|默默看着/.test(raw)) return false;
    if (/我|自己|咱/.test(raw)) return true;
    const cleaned = raw.replace(/[\s，。、！？…~～,.!?]/g, '');
    return cleaned.length >= 6;
}

const MAN_RE = /\b(1boy|2boys|male|man|men|boy|father|brother|uncle)\b/i;
const FUTA_RE = /\b(futanari|futa|dickgirl|newhalf|shemale)\b/i;

/** 这个身份该叫 girl 还是 man（只用于人数 tag 和分句主语）。 */
export function nounOf(identity) {
    return MAN_RE.test(String(identity || '')) ? 'man' : 'girl';
}

/** 这个身份是不是扶她（分句主语仍算 girl，但人数 tag 要单独数）。 */
export function isFutaIdentity(identity) {
    return FUTA_RE.test(String(identity || ''));
}

/**
 * 未成年判定 —— 只用来拦「服装未知就默认裸体」这件事。
 * 命中就一律不裸（兜底交给非裸体分支），宁可少画，不可画错。
 * 覆盖：英文幼态词、明确年龄、中文幼态词。
 */
const MINOR_WORDS = /\b(toddler|baby(?!\s*face)|infant|newborn|child(?!hood)|children|kid(?!ney)|loli|lolita|shota|underage|preschool|kindergarten|elementary school|middle school|junior high)\b|幼女|幼童|萝莉|正太|小学生|幼儿园|未成年/i;
const AGE_RE = /(\d{1,2})\s*(?:years?[ -]?old|y\.?o\.?)\b|(\d{1,2})\s*岁/gi;

export function isMinorIdentity(identity) {
    const t = String(identity || '');
    if (!t) return false;
    if (MINOR_WORDS.test(t)) return true;
    const re = new RegExp(AGE_RE.source, 'gi');
    let m;
    while ((m = re.exec(t)) !== null) {
        const age = Number(m[1] ?? m[2]);
        if (age > 0 && age < 18) return true;
    }
    return false;
}

/**
 * 扶她那一段的写法。为什么不用「全局加个 penis tag」：
 * 全局 tag 是对整张图生效的，模型很可能把特征糊到别人身上（这正是「jj 长在别人身上」的成因）。
 * 所以把解剖写进**这个人的分句**里，再给其他女性一句明确的说明，双方各自有依据。
 */
export function futaClause(subject, anatomy) {
    const a = String(anatomy || '').trim().replace(/[,\s]+$/, '').replace(/,\s*/g, ' and ');
    return a ? `${subject} is a futanari with ${a}.` : `${subject} is a futanari.`;
}

/** 非扶她的女性角色，在 NSFW 场景里明确一句，免得毛囊里长出多余的东西。 */
export function femaleClause(subject, pronoun) {
    return `${subject} (${pronoun}) is female and has a vagina.`;
}

/** 服装 tag 里有没有「真正穿在身上的东西」——用来判断该说 wearing 还是 is。 */
const CLOTHING_NOUNS = /\b(dress|shirt|skirt|bra|panties|underwear|socks|stockings|thighhighs|shoes|loafers|boots|jacket|coat|uniform|swimsuit|bikini|apron|robe|towel|kimono|yukata|suit|tie|gloves|hat|cap|choker|ribbon|belt|shorts|pants|trousers|jeans|sweater|hoodie|vest|cape|scarf|bandage|eyepatch|necktie|cardigan|camisole|leggings|sandals|jewelry|earring|necklace|bracelet|glasses|mask|armor|scrubs|lab coat|sundress|nightgown|pajamas|yukata)\b/i;

/**
 * 「她身上那套」的句子。
 * 裸体那套不能写成 `is wearing completely nude` —— 那不是衣服，语法崩了模型也读不懂；
 * 判据是「出现 nude/naked 且没有任何衣物名词」，这样 `pink dress pulled down, topless`
 * 这类半脱状态仍然走 wearing。
 */
export function wearingLine(pronoun, tags) {
    const t = String(tags || '').trim().replace(/[,\s]+$/, '');
    if (!t) return '';
    const looksNude = /\b(completely nude|fully nude|nude|naked)\b/i.test(t) && !CLOTHING_NOUNS.test(t);
    if (!looksNude) return `${pronoun} is wearing ${t}.`;
    // 裸体那套里「nipples / navel」这类纯状态 tag 摘掉再说，句读才像人话
    const kept = t.split(',').map(x => x.trim()).filter(Boolean)
        .filter(x => !/^(nipples?|areolae?|navel|pubic hair)$/i.test(x));
    return `${pronoun} is ${(kept.length ? kept : ['completely nude']).join(', ')}.`;
}

/**
 * 人数 tag。扶她要单独数 —— danbooru 的规范写法是 `1futanari, 2girls`：
 * 只写 `3girls` 再把 futanari 挂在某个人身上，模型没有「只有一个」的依据，
 * 结果就是所有人都长出那玩意。futaCount 由调用方传。
 */
export function countTagOf(nouns, futaCount = 0) {
    const girls = (nouns || []).filter(n => n === 'girl').length;
    const men = (nouns || []).filter(n => n === 'man').length;
    const futas = Number(futaCount) || 0;
    const bits = [];
    if (futas > 0) bits.push(futas === 1 ? '1futanari' : `${futas}futanari`);
    if (girls > 1) bits.push(`${girls}girls`); else if (girls === 1) bits.push('1girl');
    if (men > 1) bits.push(`${men}boys`); else if (men === 1) bits.push('1boy');
    return bits.join(', ');
}

/** 位置词：两人/三人最有效，再多就没法用左右锚定了。 */
export function positionalWord(i, n) {
    if (n === 2) return i === 0 ? 'on the left' : 'on the right';
    if (n === 3) return ['on the left', 'in the center', 'on the right'][i];
    return '';
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

/** 四个人以上没有左右锚点可用，退而求其次给序数，至少让每个人各成一句。 */
export function ordinalWord(i) {
    return ORDINALS[i] || `#${i + 1}`;
}

/** 三个人且玩家在画面里时，把玩家放中间（主体居中比挤在左边稳）。 */
export function arrangePlayerCenter(ids, playerId) {
    const list = [...(ids || [])];
    if (list.length !== 3 || !list.includes(playerId)) return list;
    const others = list.filter(x => x !== playerId);
    return [others[0], playerId, others[1]];
}

/** 按人数组出「多个人怎么写」的句子数组（不含身份/服装内容，那些由调用方填）。 */
export function multiLookLines(ids, nouns) {
    return ids.map((id, i) => {
        const pos = positionalWord(i, ids.length);
        const subj = pos ? `The ${nouns[i]} ${pos}`
            : (ids.length > 3 ? `The ${ordinalWord(i)} ${nouns[i]}` : `The ${nouns[i]}`);
        return { subject: subj, pronoun: nouns[i] === 'man' ? 'He' : 'She' };
    });
}

const ACTION_STOPWORDS = new Set([
    'with', 'from', 'that', 'this', 'and', 'the', 'into', 'onto', 'over', 'their', 'them',
    'her', 'his', 'she', 'he', 'while', 'being', 'very', 'both', 'other', 'each', 'near',
]);

/**
 * 把「1girl 短红发 被压在床上」这种扁平动作句，改写成带位置锚点的句子。
 *
 * auto-illustrator 那条链路自己写提示词，动作就是这种扁平句：人和位置不绑定，
 * 第三个人还经常完全没有动作 —— 这是「角色动作关系不对」的直接来源。
 * 这里拿句子里的描述词去跟每个人的身份/服装做词重叠，判断这句写的是谁，
 * 再套上和外观锁一致的位置词（左/中/右），模型才有依据把动作分对人。
 * 重叠为 0 就原样留着，不乱猜。
 *
 * @param body  提示词正文
 * @param people [{ identity, outfit }]，顺序必须和外观锁的位置顺序一致
 */
export function bindActionsToCast(body, people) {
    const list = (people || []).map(p => ({
        id: String(p?.identity || '').toLowerCase(),
        ot: String(p?.outfit || '').toLowerCase(),
    })).map(p => ({ ...p, pool: `${p.id} ${p.ot}`.trim() }));
    if (list.length < 2 || !list.some(p => p.pool.trim())) return body;
    const used = new Set();
    const out = [];
    for (const tok of splitTags(body)) {
        const m = String(tok).match(/^\s*(\d+)?\s*(girls?|boys?|men|man|women|woman)\b[\s,:;-]*(.*)$/i);
        const rest = m ? String(m[3] || '').trim() : '';
        if (!m || !rest) { out.push(tok); continue; }
        const words = [...new Set(rest.toLowerCase().split(/[^a-z0-9]+/)
            .filter(w => w.length > 2 && !ACTION_STOPWORDS.has(w)))];
        if (!words.length) { out.push(tok); continue; }
        let pick = -1;
        let bestScore = 0;
        list.forEach((p, i) => {
            if (used.has(i) || !p.pool.trim()) return;
            // 身份（发色/瞳色/体型）权重 2，服装权重 1 ——
            // 认人是靠长相：「long pink hair」该认到长粉发那个人，
            // 而不是「长黑发 + 粉裙子」的那个人。
            let sc = 0;
            for (const w of words) {
                if (p.id.includes(w)) sc += 2;
                else if (p.ot.includes(w)) sc += 1;
            }
            if (sc > bestScore) { bestScore = sc; pick = i; }
        });
        if (pick < 0) { out.push(tok); continue; }
        used.add(pick);
        const noun = /boy|man/i.test(m[2]) ? 'man' : 'girl';
        const pos = positionalWord(pick, list.length);
        const subject = pos ? `The ${noun} ${pos}` : `The ${ordinalWord(pick)} ${noun}`;
        out.push(`${subject}: ${rest}`);
    }
    return out.join(', ');
}

/**
 * 裸露 / 脱衣状态的 tag。
 * 服装库是「记住上一场穿成什么样」的：NSFW 那场留下的 topless / bottomless
 * 会被之后每一张图无条件套用 —— 普通剧情就变成半裸体了。
 */
const NUDITY_TAGS = /(completely nude|nude|naked|topless|bottomless|bare breasts?|breasts? exposed|exposed (huge |large )?breasts?|exposed chest|nipples?|navel|bare (belly|midriff|shoulders?)|underboob|sideboob|no panties|panties? (pulled|aside|around|down)|(pulled|pushed|rolled) (down|up)( to waist| above chest)?|undone|unbuttoned|partially (clothed|unclothed|nude)|clothing aside|undressed|spread legs|see-through|trans\w*rent)/gi;

/**
 * 把服装 tag 里的裸露/脱衣状态剥掉，只留真正穿在身上的部分。
 * 注意是「从 tag 里抠掉那半句」而不是「整条丢掉」——
 * `pink chiffon dress pulled down to waist` 要留下 `pink chiffon dress`，
 * `topless` 这种纯状态才会被整条丢。全丢光时给个中性兜底，免得模型干脆画成裸的。
 */
export function stripNudityTags(tags) {
    const src = String(tags || '').trim();
    if (!src) return '';
    const kept = src.split(',')
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => x.replace(NUDITY_TAGS, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim())
        .filter(Boolean);
    if (!kept.length) return 'casual clothes';
    return kept.join(', ');
}

/**
 * 提示词里「画幅说明」的所有写法：
 *   aspect ratio 16:9, 1344x768 ／ 1344x768 ／ --ar 9:16 ／ aspect ratio 9:16
 */
export const SIZE_SPEC_RE = /(?:aspect\s*ratio\s*[\d.]+\s*[:：]\s*[\d.]+\s*[,，]?\s*)?\d{3,5}\s*[x×*]\s*\d{3,5}|--ar\s*[\d.]+\s*[:：]\s*[\d.]+|aspect\s*ratio\s*[\d.]+\s*[:：]\s*[\d.]+/gi;

/** 把画幅说明从提示词里去掉（那是给程序看的，不是给模型看的），顺手收拾逗号。 */
export function stripSizeSpec(text) {
    return String(text ?? '')
        .replace(SIZE_SPEC_RE, ' ')
        .replace(/\s*,\s*/g, ', ')
        .replace(/(,\s*)+/g, ', ')
        .replace(/^[,\s]+|[,\s]+$/g, '')
        .trim();
}

/**
 * 把宽高收进安全范围：贴 64 的倍数（DiT/SDXL 友好）、限幅 512~2048、总像素不超过上限。
 * 世界书会按剧情给出 1344x768 这种画幅，但偶尔也会给出很大的（1920x1080 = 2.07MP），
 * 8G 显存跑 2MP 的 Anima 容易爆，所以必须夹一下。
 */
export function clampSize(w, h, maxMegapixels = 1.5) {
    let W = Math.round(Number(w) || 0);
    let H = Math.round(Number(h) || 0);
    if (!(W > 0) || !(H > 0)) return null;
    const max = Math.max(0.25, Number(maxMegapixels) || 1.5) * 1e6;
    if (W * H > max) {
        const k = Math.sqrt(max / (W * H));
        W = Math.round(W * k);
        H = Math.round(H * k);
    }
    const snap = (v) => Math.min(2048, Math.max(512, Math.round(v / 64) * 64));
    W = snap(W);
    H = snap(H);
    while (W * H > max && (W > 512 || H > 512)) {
        if (W >= H) W = Math.max(512, W - 64); else H = Math.max(512, H - 64);
    }
    return { w: W, h: H };
}

/**
 * 从提示词里解析画幅规格。
 * 认这几种写法（世界书用的是第一种）：
 *   `aspect ratio 16:9, 1344x768` / `1344x768` / `--ar 9:16`
 * 只给比例不给像素时，按「像素上限」反推一组。
 * 取**最后一次**出现的规格（世界书把它写在提示词末尾）。
 * 认不出返回 null —— 调用方就会退回固定宽高。
 */
export function parseSizeSpec(text, { maxMegapixels = 1.5 } = {}) {
    const t = String(text || '');
    if (!t) return null;
    // 带像素的写法：`aspect ratio 16:9, 1344x768` 或干脆只有 `1344x768`
    const px = /(?:aspect\s*ratio\s*[\d.]+\s*[:：]\s*[\d.]+\s*[,，]?\s*)?(\d{3,5})\s*[x×*]\s*(\d{3,5})/gi;
    let m;
    let last = null;
    while ((m = px.exec(t)) !== null) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        // 真画幅两边都 ≥384；这样不会把 `1girl, 100x200` 之类的噪声当规格
        if (w >= 384 && h >= 384 && w <= 4096 && h <= 4096) last = { w, h, raw: m[0] };
    }
    if (last) {
        const c = clampSize(last.w, last.h, maxMegapixels);
        return c ? { ...c, raw: last.raw } : null;
    }
    const ar = /(?:--ar\s*|aspect\s*ratio\s*)([\d.]+)\s*[:：/]\s*([\d.]+)/i.exec(t);
    if (ar) {
        const r = Number(ar[1]) / Number(ar[2]);
        if (Number.isFinite(r) && r > 0) {
            const h = Math.sqrt((Math.max(0.25, Number(maxMegapixels) || 1.5) * 1e6) / r);
            const c = clampSize(Math.round(r * h), Math.round(h), maxMegapixels);
            return c ? { ...c, raw: ar[0] } : null;
        }
    }
    return null;
}
