/*!
 * CharImageGen · 角色一致性生图（SillyTavern 扩展）
 * Copyright (c) 2026 小米粥大王
 * MIT License — 完整协议见仓库根目录 LICENSE 文件
 * 仓库: https://github.com/mizhoudawang/xiaomizhou_shengtuchajian
 */
/**
 * 角色一致性生图 —— SillyTavern 扩展
 *
 * 悬浮球打开面板 -> 输入任意描述 -> 自动改写成生图语法 -> 调 ComfyUI 出图。
 *
 * 两种模式：
 *   free (自由构图)  纯文生图。身份靠「角色身份」+「服装库」+ 每个角色固定的 seed 维持，
 *                    构图/视角/动作完全交给提示词，能出背影、俯视、躺卧等任意角度。
 *   lock (锁定形象)  img2img，用角色头像当参考图。长得最像，但构图被参考图锁死。
 *
 * 角色/服装的登记默认走「主生成附带输出」：往主提示词里注入一小段指令，让模型在正文
 * 末尾附一个 <UpdateCast> 块，正则把它从对话里隐藏，扩展再解析入库。
 * 这样不额外调用 API、走你自己的预设，且没变化的内容不会重复入库。
 *
 * 数据模型：
 *   characters: { 角色名: { identity, source } }        identity 只有身体特征，不含服装
 *   outfits:    { 服装名: { tags, base } }              全局共享；base 相同即互为差分
 */
import { extension_settings, getContext } from '../../../extensions.js';
import {
    eventSource, event_types, generateQuietPrompt, saveSettingsDebounced, substituteParams,
    setExtensionPrompt, extension_prompt_types, extension_prompt_roles,
} from '../../../../script.js';
import { mountFanPanel } from './fanpanel.js';
import { buildArtistBlock } from './artists.js';
import { classifyOutfit, groupByGarment, primaryGarmentOf } from './outfits.js';
import { mountArtistPanel } from './artistpanel.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import {
    buildLexiconFromSources, decodeBytes, splitTags,
} from './lexicon.js';
import {
    matchSubjects, looksLikePlayerAction, nounOf, countTagOf, isFutaIdentity, isMinorIdentity,
    futaClause, femaleClause, wearingLine,
    positionalWord, ordinalWord, arrangePlayerCenter, multiLookLines, bindActionsToCast,
    stripNudityTags,
    parseSizeSpec, clampSize, stripSizeSpec,
} from './castmatch.js';

const KEY = 'char_imagegen';

/** 版本号：出问题时先看控制台这行，确认浏览器加载的是不是最新代码（F5 有时候不够，要 Ctrl+Shift+R）。 */
const CIG_VERSION = '1.3.0';

const CAST_TAG = 'UpdateCast';
const CAST_ENTRY_NAME = '📏画面登记';
const PROMPT_KEY = 'char_imagegen_cast';
const REGEX_HIDE = '生图助手 · 隐藏角色登记块[UpdateCast]';
const REGEX_STRIP = '生图助手 · 过滤角色登记块[UpdateCast]';

// 玩家主角（{{user}} / persona）在存档里用这个保留名，和角色卡来的 NPC 分开存
const PLAYER = '__player__';

// 一键换装的镜头预设：允许叠加自定义描述
const SHOT_PRESETS = [
    ['face', '面部特写', 'close-up face portrait, headshot, looking at viewer, detailed face, simple background'],
    ['bust', '半身像', 'upper body, portrait, looking at viewer, detailed clothing, simple background'],
    ['full_front', '全身正面', 'full body, standing, front view, looking at viewer, full outfit visible, simple background'],
    ['full_back', '全身背面', 'full body, standing, back view, from behind, full outfit visible, simple background'],
    ['full_side', '全身侧面', 'full body, standing, side view, profile, full outfit visible, simple background'],
    ['sheet', '三视图立绘', 'character sheet, reference sheet, multiple views, front view and side view and back view, full body, plain white background'],
    ['lower', '下半身/鞋袜', 'lower body only, close-up on legs and feet, focus on socks and shoes'],
    ['hands', '手部特写', 'close-up on hands, focus on hand and finger details'],
    ['fabric', '服装细节', 'close-up of clothing details, fabric texture and folds, focus on the outfit'],
    ['back_close', '背部特写', 'close-up on the back, back view, focus on the back of the outfit and hair'],
];

const DEFAULT_TEMPLATE = [
    '你是一个动漫图像生成提示词工程师。请结合聊天记录里正在发生的剧情，把用户的要求转换成一行英文的「场景描述」提示词。',
    '',
    '用户要求：{{input}}',
    '',
    '输出格式（严格按此顺序，逗号分隔，单行）：',
    '<画面主体>, <动作与姿态>, <场景与环境>, <光线与氛围>, <镜头与构图>, <额外细节>',
    '',
    '硬性要求：',
    '- 只输出英文提示词本身。不要解释、不要引号、不要 markdown、不要换行、不要加任何前缀',
    '- 不要输出质量词（masterpiece / best quality / score_7 等），程序会自动加在前面',
    '- 不要写 1girl / 2girls / 1boy / solo 这类人数 tag —— 人数由程序按出镜名单统一给，你写了会互相打架，导致少画人',
    '- 不要描述人物长相（脸型、发色、瞳色、体型、五官），也不要描述服装，这些由「角色身份」和「服装库」统一提供',
    '- 必须明确写出镜头与视角，例如 from behind / from above / close-up / full body / from side / dutch angle',
    '- 要贴合聊天记录里的当前情景：地点、时间、天气、正在发生的事、情绪氛围',
    '- 性爱场面必须写出**规范体位与性行为 tag**（例如 missionary / doggystyle / cowgirl position / mating press / sex from behind / fellatio / paizuri / cum in pussy / spread legs），不要只用「pinned on bed」「assisting」这种散文描述 —— 模型看不懂散文',
    '- 画面里三个人以上时，另加群体关系 tag：threesome / mmf threesome / ffm threesome / group sex / spitroast 按实际情况选',
    '- 上限 60 个英文单词以内',
].join('\n');

const ROSTER_TEMPLATE = [
    '你是动漫角色设定整理助手。请从下面的角色卡内容里，提取出其中出现的所有角色。',
    '',
    '要求：',
    '- 如果这是一张世界观 / 系统 / 剧情卡，把设定里出现过的、有名有姓的角色都提取出来',
    '- 每个角色给出：名字、固定外观、以及身上的服装',
    '- 固定外观只写不随剧情变化的部分：性别、发色、发型、瞳色、肤色、体型、外观年龄、五官特征、标志性配饰',
    '- 外观字段里绝对不要写服装、鞋、袜 —— 服装单独放 outfit 字段',
    '- 名字保留原文（中文就写中文），不要翻译、不要加书名号',
    '- 全部用小写英文 tag，逗号分隔',
    '- 按设定里描述的详细程度排序，最多 12 个',
    '',
    '角色卡名：{{card}}',
    '角色卡内容：',
    '{{desc}}',
    '',
    '只输出一个 JSON 数组，不要任何解释文字：',
    '[',
    '  {"name": "角色名", "identity": "1girl, solo, long black hair, red eyes, pale skin", "outfit_name": "服装名", "outfit": "white dress, thighhighs"}',
    ']',
].join('\n');

const OUTFIT_TEMPLATE = [
    '从下面的角色卡内容里，找出角色「{{char}}」身上的穿着，整理成一套可用于动漫图像生成的英文服装 tag。',
    '',
    '要求：',
    '- 只写服装、鞋、袜、内衣，以及属于穿着范围的配饰',
    '- 不要写发色、瞳色、发型、体型、年龄等身体特征',
    '- 全部小写英文 tag，逗号分隔',
    '- 顺便给它起一个 2-6 个字的中文名',
    '',
    '角色卡内容：',
    '{{desc}}',
    '',
    '只输出一个 JSON 对象，不要任何解释文字：',
    '{"name": "服装名", "outfit": "white dress, thighhighs"}',
].join('\n');

const PLAYER_TEMPLATE = [
    '从下面的玩家（persona）设定里，提取出用于动漫图像生成的固定外观特征，输出一行英文 tag，逗号分隔。',
    '',
    '要求：',
    '- 只保留不随剧情变化的外观：性别、发色、发型、瞳色、肤色、体型、身高、外观年龄、标志性配饰',
    '- 不要写服装、鞋、袜 —— 服装单独管理',
    '- 不要性格、经历、人际关系等非视觉信息',
    '- 开头保留 "1girl, solo" / "1boy, solo" / "1other, solo"',
    '- 全部小写英文 tag，逗号分隔，单行，不要解释、不要引号',
    '- 控制在 25 个 tag 以内',
    '',
    '人设：',
    '{{desc}}',
    '',
    '只输出 tag。',
].join('\n');

const DEFAULTS = {
    quality: 'masterpiece, best quality, score_7, safe,',
    mode: 'free',
    freeWorkflow: '',
    lockWorkflow: '',
    denoise: 0.65,
    useCharSeed: true,      // 按角色名算固定 seed（让同一个角色的脸更稳）
    seedFixed: false,       // 勾了就一律用 seedValue，不再按角色算
    seedValue: 0,           // 固定种子的值
    lastSeed: -1,           // 上次出图真正用的种子（-1 = 随机）
    characters: {},
    outfits: {},
    player: { identity: '', outfit: '' },
    activeChar: '',
    currentOutfit: '',
    lastCast: [],
    lastScene: '',
    multiChar: true,
    castOverrideMap: {},     // 手动指定的出镜人物，按「角色卡+聊天」分开存（空 = 跟随正文登记）
    autoAddPlayer: true,     // 正文提到玩家名字时，自动把 {{user}} 也算进画面
    nsfwRating: true,        // 检测到 NSFW 时自动把 rating 标签换成 explicit
    ratingNsfw: 'explicit',
    ratingUserPrefix: '',    // 用户自己那份质量前缀（换 rating 用，见 syncRatingPrefix）
    stripNudityInSfw: true,  // 非 NSFW 剧情时，把服装库里的裸露状态剥掉
    freeNorm: true,          // 绘图区：发送前用词库规范化
    sizeMode: 'auto',        // auto=按提示词里的画幅 / fixed=固定宽高 / off=不动酒馆设置
    fixedWidth: 832,
    fixedHeight: 1216,
    maxMegapixels: 1.5,      // 尺寸上限（世界书偶尔会给出 1920x1080 这种，8G 显存要夹一下）
    sizeStripTag: true,      // 把解析过的那串画幅说明从提示词里去掉
    groupThreshold: 0.45,
    autoRegister: true,
    autoFollow: true,
    injectPos: 'chat',
    useLlm: true,
    template: DEFAULT_TEMPLATE,
    // —— 词库（SD-WebUI 的标签库 / 中文分类词库，全部本地跑） ——
    lexInject: true,          // 改写时把「动作/表情/镜头」候选词喂给模型
    lexFromChat: true,        // 候选词也从最近剧情里找
    lexNormalize: true,       // 出图前规范化提示词（中文→英文、别名纠正、去重）
    lexHookNormalize: true,   // 酒馆自带生图（魔杖菜单/自动生图）也过一遍翻译与归一
    lexPerBucket: 8,          // 每个分类最多给几个候选
    lexNear: 4,               // 每个分类额外给几个「近义动作」
    sections: { free: true, gen: true, player: true, quick: true, fan: true, artist: true, lex: true, cast: true, auto: true, settings: false },
    pos: null,
    collapsed: false,
    lastInput: '',
    freePrompt: '',          // 绘图区上次写的提示词
    freeNorm: true,          // 绘图区：发送前用词库规范化
    freeRef: '',             // 绘图区上传的参考图（酒馆相对路径，如 /user/files/x.png）
    freeRefName: '',         // 参考图文件名（拼绝对路径用）
    img2imgWorkflow: 'Anima_MiaomiaoRealSkin_Img2Img.json',
    img2imgRoot: '',         // 酒馆 user/files 的绝对路径（ComfyUI 按绝对路径读图）
    img2imgDenoise: 0.6,     // 重绘幅度
    // —— LoRA（可选，一个总开关：关了就用不带 LoRA 的那套工作流） ——
    loraEnabled: false,
    loraName: '',            // LoRA 文件名（自己填 ComfyUI/models/loras/ 里的名字）
    loraWeight: 0.8,
    loraWorkflow: 'Anima_MiaomiaoRealSkin_LoRA_SillyTavern.json',      // 文生图（含自动生图、绘图区）
    loraImg2imgWorkflow: 'Anima_MiaomiaoRealSkin_LoRA_Img2Img.json',   // 图生图
    loraBaseWorkflow: '',    // 开 LoRA 前用的工作流，关掉时切回去
    // —— 同人角色库（fanchars.js 的数据面板部分见 fanpanel.js） ——
    fanQuery: '',
    fanSeries: '',
    fanRating: 'all',
    fanSavedIds: [],         // 已建档的同人角色 id
    fanAliases: {},          // 角色名 → 外号数组（正文里出现外号也要能认出来）
    fanNameMap: {},          // 别名 → booru tag（提示词里出现中文名时替换用）
    fanRefs: {},             // 角色名 → { path, name }：每角色的参考图
    customChars: [],         // 用户自己导入的角色（和内置库一起显示）
    fanPaste: '',            // 导入框里粘的内容
    fanPreview: [],          // 识别结果（确认前先给用户看）
    fanPreviewErrors: [],
    fanRefDenoise: 0.6,      // 参考图重绘幅度
    refNow: false,           // 本次出图是否用参考图（img2img）
    // —— 画师画风（只改提示词；和 LoRA 互不干扰，可叠加） ——
    artistStyles: [],        // [{ tag, weight }]
    artistSyntax: '@',       // '@' | 'artist:' | ''
    artistOn: true,
    artistInFree: false,     // 绘图区（纯提示词出图）是否也套用
    artistQuery: '',
    artistRating: 'all',
    // —— 界面 ——
    theme: 'st',             // st=跟随酒馆 | black | gray | light | white | sepia
    launcherPos: null,       // 启动图标位置 {x,y}（拖动后记住）
    panelPos: null,          // 面板位置（已有 s.pos）
    panelSize: null,         // 面板尺寸 {w,h}（右下角拖出来的）
    // —— 裸体 / 服装兜底 ——
    nudeOutfitName: '裸体',  // 服装库里这套「裸体」：出现在服装下拉里，可分配给任何角色
    nudeAsDefault: true,     // 服装未知（含选「跟随剧情」）时默认裸体；未成年角色一律不裸
    // —— 扶她解剖（提示词层，就是为了治「jj 糊成一团 / 长在别人身上」） ——
    futaAnatomy: 'penis, testicles',
    futaNegatives: 'extra penis, fused genitals, malformed genitals, mutated genitals, conjoined',
    futaOwnership: true,     // NSFW 多人画面里写明「谁有」，并给其他女性一句 female
    userNegativePrompt: '',  // 负面词的基准副本（追加扶她项用，可逆）
};

function clone(o) {
    return JSON.parse(JSON.stringify(o));
}

function S() {
    if (!extension_settings[KEY] || typeof extension_settings[KEY] !== 'object') {
        extension_settings[KEY] = clone(DEFAULTS);
    }
    const s = extension_settings[KEY];
    for (const k of Object.keys(DEFAULTS)) {
        if (s[k] === undefined) s[k] = clone(DEFAULTS[k]);
    }
    if (!s.characters || typeof s.characters !== 'object') s.characters = {};
    if (!s.outfits || typeof s.outfits !== 'object') s.outfits = {};
    // sections 是对象，缺子键时不会自动补，这里手动补全
    if (!s.sections || typeof s.sections !== 'object') s.sections = clone(DEFAULTS.sections);
    for (const k of Object.keys(DEFAULTS.sections)) {
        if (typeof s.sections[k] !== 'boolean') s.sections[k] = DEFAULTS.sections[k];
    }
    // 老版本存档没有 outfit 字段，补上空串，免得界面显示 undefined
    for (const v of Object.values(s.characters)) {
        if (v && typeof v === 'object' && typeof v.outfit !== 'string') v.outfit = '';
    }
    if (!s.player || typeof s.player !== 'object') s.player = { identity: '', outfit: '' };
    if (typeof s.player.identity !== 'string') s.player.identity = '';
    if (typeof s.player.outfit !== 'string') s.player.outfit = '';

    // 旧版 migration：appearance（含服装的扁平串）搬进 characters
    if (s.appearance && typeof s.appearance === 'object') {
        for (const [n, v] of Object.entries(s.appearance)) {
            if (typeof v === 'string' && v.trim() && !s.characters[n]) {
                s.characters[n] = { identity: tidyPrompt(v), source: '' };
            }
        }
        delete s.appearance;
    }
    // 旧版 migration：服装从扁平串升级成 { tags, base }，base 用于归并差分
    for (const [n, v] of Object.entries(s.outfits)) {
        if (typeof v === 'string') s.outfits[n] = { tags: v, base: n };
        else if (v && typeof v === 'object' && typeof v.tags !== 'string') v.tags = '';
    }
    // 内置那套「裸体」：放进服装库（所以服装下拉里能选、也能分配给角色），tag 你随时能改
    const nudeName = String(s.nudeOutfitName || '裸体');
    if (!s.outfits[nudeName]) {
        s.outfits[nudeName] = { tags: 'completely nude, nipples', base: nudeName };
    }
    return s;
}

function save() {
    saveSettingsDebounced();
}

function outfitTagsOf(v) {
    return typeof v === 'string' ? v : String(v?.tags || '');
}

function outfitBaseOf(name, v) {
    return typeof v === 'string' ? name : String(v?.base || name);
}

/** tag 集合的规范化形式，用于「内容是否真的变了」的比较（顺序无关）。 */
function normTags(text) {
    return tidyPrompt(text).toLowerCase()
        .split(',').map(x => x.trim()).filter(Boolean).sort().join(', ');
}

function currentChar() {
    try {
        const ctx = getContext();
        const id = ctx.characterId;
        const ch = (id !== undefined && id !== null && Array.isArray(ctx.characters)) ? ctx.characters[id] : null;
        const avatar = String(ch?.avatar || '');
        return {
            name: ch?.name || ctx.name2 || '',
            avatarStem: avatar.replace(/\.png$/i, ''),
            desc: ch?.description || '',
        };
    } catch {
        return { name: '', avatarStem: '', desc: '' };
    }
}

function resolvedName() {
    const s = S();
    return s.activeChar || currentChar().name || '';
}

function isPlayer(name) {
    return name === PLAYER;
}

/** 这个名字是不是玩家本人（{{user}}）—— 模型有时会把玩家也报进 characters。 */
function isPlayerName(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (n === PLAYER) return true;
    try {
        const ctx = getContext();
        const cands = [ctx?.name1, String(ctx?.user_avatar || '').replace(/\.png$/i, '')].filter(Boolean);
        return cands.some(x => String(x).trim().toLowerCase() === n.toLowerCase());
    } catch {
        return false;
    }
}

/** ST 里玩家叫 {{user}}；界面显示用它的真名。 */
function playerLabel() {
    try {
        return getContext()?.name1 || '玩家主角';
    } catch {
        return '玩家主角';
    }
}

/** 取某个主体的存档：NPC 在 characters 里，玩家主角单独放 player。 */
function subjectEntry(name) {
    const s = S();
    if (!name) return null;
    if (isPlayer(name)) {
        if (!s.player || typeof s.player !== 'object') s.player = { identity: '', outfit: '' };
        return s.player;
    }
    return s.characters[name] || null;
}

/** 这个主体是不是「有建档」的（玩家主角永远算有）。 */
function subjectExists(name) {
    return !!subjectEntry(name);
}

/** 某个主体当前穿的是哪一套（用于界面显示和切换）。 */
function wornOutfitOf(name) {
    return String(subjectEntry(name)?.outfit || '');
}

/**
 * 出镜名单按「角色卡 + 聊天」分开存。
 * 「三个人在做」是这一场戏的决定，不该粘到别的聊天里 —— 换个聊天就得重新算。
 */
function castKey() {
    try {
        const ctx = getContext();
        return `${ctx?.characterId ?? ''}::${ctx?.chatId ?? ''}`;
    } catch {
        return '';
    }
}

function castOverrideOf() {
    const s = S();
    const map = (s.castOverrideMap && typeof s.castOverrideMap === 'object') ? s.castOverrideMap : {};
    const v = map[castKey()];
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
}

function setCastOverride(list) {
    const s = S();
    if (!s.castOverrideMap || typeof s.castOverrideMap !== 'object') s.castOverrideMap = {};
    const k = castKey();
    if (Array.isArray(list) && list.length) s.castOverrideMap[k] = list;
    else delete s.castOverrideMap[k];
    save();
}

function identityOf(name) {
    return String(subjectEntry(name)?.identity || '');
}

function outfitTags() {
    const s = S();
    return s.currentOutfit ? outfitTagsOf(s.outfits[s.currentOutfit]) : '';
}

/** 某个主体身上那一套的 tag（不含「未知就裸体」的兜底）。 */
function resolvedOutfitOf(name) {
    const worn = wornOutfitOf(name);
    if (worn && S().outfits[worn] !== undefined) return outfitTagsOf(S().outfits[worn]);
    return name === resolvedName() ? outfitTags() : '';
}

/** 档案里到底有没有外观数据 —— 认人、算人数、决定谁在画面里都用这个（绝不能用裸体兜底的结果）。 */
function hasLookData(name) {
    return !!(identityOf(name) || resolvedOutfitOf(name));
}

/**
 * 服装未知时兜底「裸体」。
 * 两条硬规则：① 开关关掉就不兜底；② 未成年角色（身份里有幼态词或明确年龄 < 18）一律不裸。
 * 返回的是裸体那套的 tag（通常就是服装库里的「裸体」条目，可以直接在面板上改）。
 */
function defaultNudeTagsFor(name) {
    const s = S();
    if (s.nudeAsDefault === false) return '';
    // 未成年角色：永不裸体，兜底一身衣服（宁可平淡，不可画错）。
    // 两种判定：① 建档时带了 minor 标记（同人库里原作就是小孩的角色）
    //           ② 身份串里有幼态词或年龄 < 18
    if (subjectEntry(name)?.minor === true || isMinorIdentity(identityOf(name))) return 'casual clothes';
    const nude = s.outfits[s.nudeOutfitName || '裸体'];
    return nude ? outfitTagsOf(nude) : 'completely nude';
}

/** 某个主体身上那一套的 tag。没建档/没记录穿着/选了「跟随剧情」时 → 裸体兜底。 */
function outfitTagsFor(name) {
    const own = resolvedOutfitOf(name);
    if (own) return own;
    return defaultNudeTagsFor(name);
}

/**
 * 当前场景的原文（用户刚发的 + 最近几条 AI 回复 + 输入框里正在写的），用来自动认人。
 * 登记块（<!--cast=...-->）要剔掉，不然名单会被当成"正文里提到过"反复命中。
 * 长回复两边都留：开头常点人名，结尾是正在发生的动作 —— 只留尾巴会把开头的人名截掉。
 */
function recentSceneText(limit = 3) {
    const parts = [];
    try {
        const chat = getContext()?.chat;
        if (Array.isArray(chat) && chat.length) {
            for (const m of chat.slice(-limit)) {
                const t = String(m?.mes || '').replace(/<!--[\s\S]*?-->/g, ' ');
                parts.push(t.length > 2400 ? `${t.slice(0, 1200)}\n${t.slice(-1200)}` : t);
            }
        }
    } catch { /* 读不到就算了 */ }
    try { parts.push(String($('#cig-input').val() || '')); } catch { /* 面板没渲染也无所谓 */ }
    const text = parts.join('\n');
    return text.length > 9000 ? text.slice(-9000) : text;
}

/** 所有建过档的主体：玩家主角 + NPC。 */
function allSubjects() {
    const s = S();
    const out = [];
    if (subjectExists(PLAYER)) out.push(PLAYER);
    for (const n of Object.keys(s.characters)) out.push(n);
    return out.filter(n => hasLookData(n));
}

/** 界面上叫这个名字。 */
function displayNameOf(name) {
    return isPlayer(name) ? playerLabel() : String(name || '');
}

/**
 * 自动认人：正文里点到名的都算在画面里。
 * 这是「三个人在做」的正解 —— 模型登记漏了谁都不怕，正文提到就得画。
 * 长的名字优先匹配（「美咲子」命中后就不再算「美咲」），并且丢掉被更长名字包含的短名。
 */
function autoCastFromText() {
    const scene = recentSceneText(3);
    if (!scene) return [];
    const subjects = allSubjects().map(n => ({ id: n, label: displayNameOf(n) }));
    // 同人角色的外号/英文名也当名字用（「兔兔」→阿米娅、「Hu Tao」→胡桃）。
    // 只认中日文名的后缀，英文名按单词边界匹配 —— 所以不会把 lingerie 认成「令」。
    const aliases = S().fanAliases;
    if (aliases && typeof aliases === 'object') {
        for (const [name, list] of Object.entries(aliases)) {
            if (!subjectExists(name) || !Array.isArray(list)) continue;
            for (const a of list) {
                const al = String(a || '').trim();
                if (al.length >= 2 && al !== name) subjects.push({ id: name, label: al });
            }
        }
    }
    // 同一个 id 可能被「名字」和「外号」同时命中，去重但保留出现顺序
    return [...new Set(matchSubjects(scene, subjects).map(x => x.id))];
}

/** 玩家本人是不是在画面里：正文写了玩家名，或者用户这轮写的是自己的动作。 */
function playerLikelyInFrame() {
    if (!hasLookData(PLAYER)) return false;
    if (isPlayer(S().activeChar)) return true;
    const label = playerLabel();
    const scene = recentSceneText(3);
    if (label && label.length >= 2 && matchSubjects(scene, [{ id: PLAYER, label }]).length) return true;
    try {
        const chat = getContext()?.chat;
        const lastUser = Array.isArray(chat) ? [...chat].reverse().find(m => m?.is_user) : null;
        const text = `${lastUser?.mes || ''} ${$('#cig-input').val() || ''}`;
        return looksLikePlayerAction(text);
    } catch {
        return false;
    }
}

/**
 * 本画面该画哪几个人。
 * 优先级：手动勾选的名单 > 正文自动认人（+ 玩家）> 模型登记名单 > 当前角色。
 * 三个人以上的画面之所以出不来，最常见就是登记块漏了人 —— 所以正文提到谁就算谁。
 */
function sceneCast() {
    const s = S();
    const override = castOverrideOf().filter(n => subjectExists(n));
    if (override.length) return override.slice(0, 6);

    const keep = autoCastFromText();
    if (s.autoAddPlayer !== false && !keep.includes(PLAYER) && playerLikelyInFrame()) keep.push(PLAYER);

    // 正文里一个人名都没认出来（第一人称叙事很常见）→ 退回模型登记的名单
    if (keep.length < 2) {
        for (const n of (Array.isArray(s.lastCast) ? s.lastCast : [])) {
            if (typeof n !== 'string' || !n || keep.includes(n)) continue;
            if (hasLookData(n)) keep.push(n);
        }
    }

    const list = keep.filter(n => hasLookData(n)).slice(0, 6);
    if (list.length) return list;

    const solo = resolvedName();
    return solo && identityOf(solo) ? [solo] : [];
}

// 人物名词（girl/man）、人数 tag、位置词、序数、玩家居中 —— 都在 castmatch.js 里，
// 那是个不依赖酒馆的纯模块，能直接拿真实聊天记录做测试。

/**
 * 人物计数 tag 由 countTagOf 统一给。角色自己的 identity 里通常也带着 1girl / solo，
 * 和顶部的 2girls 摆在一起会互相打架（模型会按 1girl 收成一个人），所以这里剔掉。
 */
function stripCountTags(tags) {
    const re = /^(solo|multiple (girls|boys)|\d+\+?\s*(girls?|boys?|other))$/i;
    return String(tags || '')
        .split(',')
        .map(x => x.trim())
        .filter(x => x && !re.test(x))
        .join(', ');
}

/**
 * 多人画面按句拆开写，这是 Anima 减少「两个人长一个样」的关键。
 *  - 人数 tag 打头
 *  - 每个角色独立成句，用 on the left / on the right 锚定空间位置
 *  - 句号结尾：DiT 的注意力在句号处会断开，等于给每个角色划了硬边界
 * 反向验证过：同样的 seed 和参数，一长串扁平 tag 会让两张脸趋同，
 * 拆成定位句之后脸的形状、年龄感、瞳型都能拉开。
 */
function buildMultiLook(names, scene = '') {
    if (names.length < 2) return '';
    // 没有存档的人不能占位 —— 否则人数 tag 会算多，画出来却是空的
    const list = names.filter(n => hasLookData(n));
    if (list.length < 2) return '';
    const arranged = arrangePlayerCenter(list, PLAYER);
    const nouns = arranged.map(n => nounOf(identityOf(n)));
    // 非 NSFW 剧情：服装库里存着的裸露状态不该跟过来
    const sfw = shouldStripNudity(scene);
    const lines = [];
    const futas = arranged.filter(n => isFutaIdentity(identityOf(n))).length;
    arranged.forEach((name, i) => {
        // 「has female, long pink hair…」读起来很怪：性别由后面的 femaleClause 明说，这里去掉
        const id = stripCountTags(identityOf(name)).replace(/^\s*(female|male)\s*,\s*/i, '');
        const strip = sfw && !nudeChosenOnPurpose(name);
        const ot = strip ? stripNudityTags(outfitTagsFor(name)) : outfitTagsFor(name);
        if (!id && !ot) return;
        const { subject, pronoun } = multiLookLines(arranged, nouns)[i];
        if (id) lines.push(`${subject} has ${id}.`);
        if (ot) lines.push(wearingLine(pronoun, ot));
        // NSFW 里把「谁有、谁没有」写明：全局加一个 penis tag 会让特征糊到别人身上，
        // 写进各自的分句、再给其他女性一句说明，模型才有依据只画在一个人身上。
        if (!sfw && futas > 0) {
            const isFuta = isFutaIdentity(identityOf(name));
            if (isFuta) {
                if (S().futaOwnership !== false) lines.push(futaClause(subject, S().futaAnatomy));
            } else if (S().futaOwnership !== false) {
                lines.push(femaleClause(subject, pronoun));
            }
        }
    });
    if (!lines.length) return '';
    return [countTagOf(nouns, futas), ...lines].filter(Boolean).join('\n');
}

/** 非 NSFW 剧情时要不要把服装里的裸露 tag 剥掉（默认剥）。 */
function shouldStripNudity(scene) {
    if (S().stripNudityInSfw === false) return false;
    if (!scene) return true;              // 不知道剧情就别裸着
    return !isNsfwText(scene);
}

/**
 * 用户是不是在「服装」下拉里**明确选了裸体那套**。
 * 明确选的照做（普通场景也不剥）；「记忆里的」和「兜底的」才在普通场景兜底穿衣 ——
 * 老毛病（普通剧情半裸体）是记忆里的 topless 跟过来造成的，不是用户选的。
 */
function nudeChosenOnPurpose(name) {
    const s = S();
    if (name !== resolvedName()) return false;
    const cur = String(s.currentOutfit || '');
    return !!cur && cur === String(s.nudeOutfitName || '裸体');
}

/** 找到内容完全相同的已有服装（顺序无关），没有则 null —— 这就是「没变化就不新建」。 */
function findOutfitByTags(tags) {
    const n = normTags(tags);
    if (!n) return null;
    for (const [name, v] of Object.entries(S().outfits)) {
        if (normTags(outfitTagsOf(v)) === n) return name;
    }
    return null;
}

/** 最长公共子串长度（中文短名比对用）。 */
function lcsLength(a, b) {
    let best = 0;
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        const cur = new Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                cur[j] = prev[j - 1] + 1;
                if (cur[j] > best) best = cur[j];
            }
        }
        prev = cur;
    }
    return best;
}

function jaccard(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    return inter / (setA.size + setB.size - inter);
}

/**
 * 服装名相似度，三种算法取最大：
 *   1. 二元组 Jaccard        —— 抓「日常衬衫 / 日常衬衫长裤」这种
 *   2. 最长公共子串占比      —— 抓「白色连衣裙 / 白色洋装」这种
 *   3. 字符集 Dice（双方都 ≥3 字才启用）—— 抓「碎花连衣裙 / 碎花吊带裙」这种
 *      （只共一个「薄纱」，前两种都偏低，但共享了薄/纱/裙三个字）
 * 之所以用名字而不是 tag：模型会把同一套衣服的 tag 换个说法
 * （white dress, floral pattern, white thighhighs  vs
 *   white floral kindergarten dress, white thigh-high socks），tag 交集是 0。
 * 第 3 种设了长度下限，否则「常服 / 日常便服」会因共享「常服」两字被误并。
 */
function nameSimilarity(a, b) {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x || !y) return 0;
    if (x === y) return 1;

    const grams = (t) => {
        const out = new Set();
        if (t.length < 2) { out.add(t); return out; }
        for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
        return out;
    };
    const jac = jaccard(grams(x), grams(y));

    const lcs = lcsLength(x, y);
    const lcsRatio = lcs >= 2 ? lcs / Math.min(x.length, y.length) : 0;

    let dice = 0;
    if (x.length >= 3 && y.length >= 3) {
        const A = new Set(x);
        const B = new Set(y);
        let inter = 0;
        for (const c of A) if (B.has(c)) inter++;
        dice = (2 * inter) / (A.size + B.size);
    }
    return Math.max(jac, lcsRatio, dice);
}

/** tag 集合相似度（按逗号切、当集合比）。 */
function tagSimilarity(a, b) {
    const toSet = (t) => new Set(String(t || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
    return jaccard(toSet(a), toSet(b));
}

function outfitSimilarity(nameA, tagsA, nameB, tagsB) {
    return Math.max(nameSimilarity(nameA, nameB), tagSimilarity(tagsA, tagsB));
}

/** 找出内容不同、但和它「相近」的已有服装（返回最像的那个）。 */
function findSimilarOutfit(name, tags, threshold) {
    const s = S();
    let best = null;
    let bestScore = 0;
    for (const [n, v] of Object.entries(s.outfits)) {
        const score = outfitSimilarity(name, tags, n, outfitTagsOf(v));
        if (score > bestScore) { bestScore = score; best = n; }
    }
    return bestScore >= threshold ? { name: best, score: bestScore } : null;
}

/** 把整个服装库按相似度重新归类（纯本地计算，不调 API）。 */
function autoGroupOutfits() {
    const s = S();
    const th = Number(s.groupThreshold) || 0.45;
    const names = Object.keys(s.outfits);
    if (names.length < 2) return 0;

    // 只把「同一件主件」的衣服归到一起（以前拿 tag 相似度硬并，会把连衣裙和和服并成一类）
    const clusters = groupByGarment(names.map(n => [n, outfitTagsOf(s.outfits[n])]), th);
    let changed = 0;
    for (const members of clusters) {
        // 分类名取簇里最短的名字，通常就是最通用的那个
        const label = members.slice().sort((x, y) => x.length - y.length)[0];
        for (const n of members) {
            const v = s.outfits[n];
            if (v && typeof v === 'object' && v.base !== label) { v.base = label; changed++; }
        }
    }
    if (changed) save();
    return changed;
}

/** 同名但内容不同时，自动派生成差分「名字·2」。 */
function uniqueOutfitName(base) {
    const s = S();
    if (s.outfits[base] === undefined) return base;
    let i = 2;
    while (s.outfits[`${base}·${i}`] !== undefined) i++;
    return `${base}·${i}`;
}

/**
 * 入库一套服装，三级判定：
 *   1. tag 完全一样 -> 直接复用（一种衣服只记一次）
 *   2. 名字/tag 相近 -> 归到那个已有分类下当差分（分类 = base）
 *   3. 都不像       -> 自己开一个新分类
 * 返回 { name, reused, grouped? }。
 */
function addOutfit(name, tags) {
    const s = S();
    const wanted = String(name || '').trim() || '未命名服装';
    const body = tidyPrompt(tags);
    if (!body) return null;

    // 判定规则（见 outfits.js）：
    //   · 主件（dress/kimono/uniform…）不同 → 两套衣服，各开分类，哪怕 tag 很像
    //   · 主件相同 + 状态变化（破损/半脱/敞开）或换了部件（鞋/袜/帽/外层/颜色） → 收成差分「名字·2」
    //   · 主件相同、只差措辞或只换了个小首饰 → 太像了，直接复用原来那条，不新增
    const existing = Object.entries(s.outfits).map(([n, v]) => [n, outfitTagsOf(v)]);
    const hit = classifyOutfit(body, existing);
    if (hit.kind === 'same') return { name: hit.name, reused: true, why: hit.reason };
    if (hit.kind === 'variant') {
        const base = outfitBaseOf(hit.name, s.outfits[hit.name]);
        const n = uniqueOutfitName(base);
        s.outfits[n] = { tags: body, base };
        return { name: n, reused: false, grouped: base, why: hit.reason };
    }
    const n = uniqueOutfitName(wanted);
    s.outfits[n] = { tags: body, base: n };
    return { name: n, reused: false, why: hit.reason };
}

/**
 * 勾了「固定种子」就返回那个值；没勾返回 null（表示按角色算或随机）。
 * 返回 null 和返回 0 是两回事 —— 0 是个合法种子。
 */
function seedFixedValue() {
    const s = S();
    if (!s.seedFixed) return null;
    const v = Math.floor(Number(s.seedValue));
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 面板上那行「本次会用 / 上次用了」的提示。 */
function renderSeedHint() {
    const s = S();
    const cur = seedFixedValue();
    let eff;
    if (cur !== null) eff = cur + '（固定）';
    else if (s.useCharSeed) eff = '按角色算 ' + seedFor(resolvedName()) + '（要自己定就勾「固定种子」）';
    else eff = '每次随机';
    $('#cig-seed-hint').text('本次会用：' + eff + '　·　上次出图用了：' + (s.lastSeed >= 0 ? s.lastSeed : '随机'));
}

function seedFor(name) {
    let h = 2166136261 >>> 0;
    const str = String(name || 'default');
    for (let i = 0; i < str.length; i++) {
        h ^= str.codePointAt(i) ?? 0;
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h % 2000000000;
}

function tidyPrompt(text) {
    let t = String(text ?? '').trim();
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    // 去引号必须排在换行转换之前：否则结尾引号会被推到字符串中间而躲过 $ 锚点
    t = t.replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, '');
    t = t.replace(/^\s*(prompt|output|结果|提示词)\s*[:：]\s*/i, '');
    t = t.replace(/[\r\n]+/g, ', ');
    t = t.replace(/\s*,\s*/g, ', ').replace(/(,\s*)+/g, ', ');
    t = t.replace(/^[,\s"“”'‘’]+|[,\s"“”'‘’]+$/g, '');
    return t.trim();
}

function localConvert(text) {
    let t = String(text ?? '');
    t = t.replace(/[，、；;]/g, ', ').replace(/。/g, ', ');
    t = t.replace(/[\r\n]+/g, ', ');
    t = t.replace(/\s+/g, ' ');
    t = t.replace(/\s*,\s*/g, ', ').replace(/(,\s*)+/g, ', ');
    return t.replace(/^[,\s]+|[,\s]+$/g, '').trim();
}

/**
 * 丢掉 JSON 字符串之外那些不属于 JSON 语法的字符。
 * 实测模型会往 JSON 里塞中文说明（如 "...thighhighs"}遮挡]}），导致整段解析失败；
 * 字符串内部原样保留，所以角色名的中文不受影响。
 */
function repairJson(text) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            out += c;
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; out += c; continue; }
        const lit = ['true', 'false', 'null'].find(w => text.startsWith(w, i));
        if (lit) { out += lit; i += lit.length - 1; continue; }
        if ('{}[]:,'.includes(c) || /\s/.test(c) || /[0-9]/.test(c) || '-+.'.includes(c)) out += c;
        // 其余字符＝模型夹带进来的说明文字，直接丢弃
    }
    return out;
}

function parseJsonLoose(text) {
    let t = String(text ?? '').trim();
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    const tryParse = (x, repair) => {
        const s = repair ? repairJson(x) : x;
        try { return JSON.parse(s); } catch { return undefined; }
    };
    const attempts = (x) => tryParse(x) ?? tryParse(x, true);
    let v = attempts(t);
    if (v !== undefined) return v;
    for (const [open, close] of [['[', ']'], ['{', '}']]) {
        const a = t.indexOf(open);
        const b = t.lastIndexOf(close);
        if (a !== -1 && b > a) {
            v = attempts(t.slice(a, b + 1));
            if (v !== undefined) return v;
        }
    }
    return undefined;
}

function parseRosterLines(text) {
    const out = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim().replace(/^[-*\d.、）)\s]+/, '').replace(/,$/, '');
        const i = line.indexOf('|');
        if (i <= 0) continue;
        const name = line.slice(0, i).trim().replace(/^["“']|["”']$/g, '');
        const identity = tidyPrompt(line.slice(i + 1));
        if (name && identity) out.push({ name, identity });
    }
    return out;
}

// ---------------------------------------------------------------- 主生成附带登记

function buildInstruction({ withRegistry = true } = {}) {
    const s = S();
    const names = Object.keys(s.characters);
    const lines = [
        '[画面登记 · 每次输出都要做]',
        '你的输出必须带上下面这一段，放在内容靠前的位置（可以紧跟 <game> 之类的开场标签之后）：',
        '',
        '<!--cast={"characters":[{"name":"名字","identity":"英文外观tag"}],'
        + '"scene_character":"名字",'
        + '"outfits":[{"character":"角色名","name":"服装名","tags":"英文服装tag"}]}-->',
        '',
        '规则：',
        '- 这一段开头必须是 <!--（小于号、感叹号、两个短横），结尾是 -->；整段原样输出，不要漏字符',
        '- characters 写本次出场的每一个角色',
    ];
    if (withRegistry) {
        // 带名单的版本（扩展注入）：名单里的可以只写名字，省 token
        lines.push(
            '- 第一次出场的角色必须写完整 identity；上面已登记名单里的角色只写名字就行，例如 {"name":"角色名"}',
            '- 本场一个角色都没有才写 []',
        );
    } else {
        // 静态版本（写进预设）：没有名单可参考，所以一律写全，去重交给程序
        lines.push(
            '- 每个角色都必须写完整 identity：性别、发色、发型、瞳色、眼型、脸型、肤色、体型、外观年龄、标志性配饰',
            '- 就算这个角色之前出现过，也要照样写全，不要只写名字',
            '- 本场一个角色都没有才写 []',
        );
    }
    lines.push(
        '- identity 只写身体特征：性别、发色、发型、瞳色、眼型、脸型、肤色、体型、外观年龄、标志性配饰',
        '- identity 里绝对不要写服装、鞋、袜',
        '- 同一画面有两个人以上时，各人的【眼型 / 脸型 / 体型】必须写出明显差别，'
        + '否则模型会把两个人画成同一张脸。可用词：sharp narrow eyes / round wide eyes、'
        + 'mature face / youthful face、tall / petite、large breasts / flat chest；'
        + '这两人越像，越要把差别写足',
        '- scene_character 写这个画面里最该被画出来的角色名，没有就写空字符串',
        '- 玩家本人{{user}}如果在画面里（包括第一人称「我」在动作的场景），必须把他也写进 characters，'
        + '名字用玩家名 —— 漏掉他，出图就只会画 NPC，三个人变成两个人',
        '- outfits 必须给本次出场的【每一个】角色各写一条，有几个角色就写几条，不要只写主视角那个',
        '- 没穿衣服也是衣服：照样写一条，tags 写 completely nude（只脱上半身写 topless，只脱下半身写 bottomless），名字写「全裸」之类',
        '- 服装名 2-6 个字，要能区分不同状态；同一套衣服每次都用同一个名字',
        '- 名字保留原文，不要翻译',
        '- 这一段是纯 JSON，里面不许夹任何中文说明或多余字符，否则整段作废',
        '- 这是 HTML 注释，不会显示给用户，不要在正文里提到它、也不要解释',
    );
    if (functionCallingOn()) {
        lines.push('- 本预设要求所有输出都通过函数工具提交：这一段必须放进那个 content 参数的最开头，否则等于没写');
    }
    if (withRegistry) {
        lines.push(`- 已登记角色：${names.length ? names.join('、') : '（无）'}`);
    }
    return lines.join('\n');
}

/** 当前是否启用了函数调用（tool calling）—— 决定要不要额外提醒「放进参数里」。 */
function functionCallingOn() {
    try {
        const ctx = getContext();
        return !!(ctx?.oai_settings?.function_calling
            ?? ctx?.chatCompletionSettings?.function_calling
            ?? extension_settings?.oai_settings?.function_calling);
    } catch {
        return false;
    }
}

/**
 * 把登记指令注入主提示词。
 * IN_CHAT 会被拼接到指定深度那条消息的内容前面（见 openai.js 的 mesSend 组装），
 * 位置靠近末尾、模型很难忽略，而且不会产生中途的 system 消息、没有 API 兼容问题。
 * IN_PROMPT 只是追加到系统提示词，长角色卡里容易被淹没。
 */
function applyInjection() {
    try {
        const s = S();
        const value = s.autoRegister ? buildInstruction() : '';
        if (s.injectPos === 'system') {
            setExtensionPrompt(PROMPT_KEY, value, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        } else {
            setExtensionPrompt(PROMPT_KEY, value, extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
        }
    } catch (err) {
        console.warn('[CharImageGen] 注入登记指令失败', err);
    }
}

/**
 * 外观锁内容：纯 tag（身份 + 当前服装），会被拼进生图提示词。
 * 锁定形象模式靠参考图锁外观，这里返回空，免得和参考图打架。
 * 画面里有两个人以上时改走分句写法（见 buildMultiLook）。
 */
function buildLookBlock(scene = '') {
    const s = S();
    if (s.mode !== 'free') return '';
    if (s.multiChar) {
        const multi = buildMultiLook(sceneCast(), scene);
        if (multi) return multi;
    }
    const name = resolvedName();
    const id = identityOf(name);
    const sfw = shouldStripNudity(scene) && !nudeChosenOnPurpose(name);
    const raw = outfitTagsFor(name);
    const ot = sfw ? stripNudityTags(raw) : raw;
    // 单人画面只有一个主体，解剖 tag 直接跟着身份写不会糊到别人身上（多人走 buildMultiLook 的分句）
    const anatomy = (!sfw && isFutaIdentity(id) && s.futaOwnership !== false)
        ? String(s.futaAnatomy || '').trim()
        : '';
    return tidyPrompt([id, anatomy, ot].filter(Boolean).join(', '));
}

/**
 * 把外观锁插进生图提示词。
 * 用 ST 的 SD_PROMPT_PROCESSING 钩子（stable-diffusion/index.js 会在拼好提示词、
 * 送去 %prompt% 之前 emit 它，并接受扩展修改），所以面板、魔杖菜单、自动生图
 * 三条路径都能吃到，而不是只有面板那一条。
 * 插在质量前缀之后、场景描述之前 —— 保持「质量词 → 身份 → 服装 → 场景」的顺序。
 */
/**
 * 「绘图区」这一次生成不要拼外观锁。
 * 用一次性开关（在 finally 里复位）—— 那段代码是同一条 SD 管线，
 * 只能用这个办法区分"角色出图"和"纯提示词出图"。
 */
let skipLookOnce = false;

/** 同人角色库面板挂载后的句柄（查「这个角色有没有参考图」要用）。 */
let fanPanel = null;

/**
 * 把「胡桃」这类中文名/外号换成 booru 角色 tag。
 * 为什么需要：词库是「标签表」不是人名表，SD 模型也不认中文名；但正文/世界书里写的
 * 一定是中文名。换成 `hu tao (genshin impact)` 之后模型才真的能调出原作那张脸。
 * 单字名（令 / 梓 / 影）加前后汉字边界，免得把「命令」这种词也换掉。
 */
function applyFanNameMap(text) {
    const map = S().fanNameMap;
    if (!map || typeof map !== 'object') return text;
    const src = String(text ?? '');
    if (!src) return src;
    const keys = Object.keys(map).filter(k => k && (k.length >= 2 || /[\u4e00-\u9fff]/.test(k)));
    if (!keys.length) return src;
    keys.sort((a, b) => b.length - a.length);          // 长名优先（raiden shogun 先于 raiden）
    const alts = [];
    for (const k of keys) {
        const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (/^[\x00-\x7F]+$/.test(k)) alts.push(`\\b${esc}\\b`);
        else if (k.length === 1) alts.push(`(?<![\\u4e00-\\u9fff])${esc}(?![\\u4e00-\\u9fff])`);
        else alts.push(esc);
    }
    let re;
    try { re = new RegExp(alts.join('|'), 'gi'); } catch { return src; }
    // 一次扫描：替换出来的文字**不会**再被后面的规则扫到。
    // 分批 replace 的话「raiden」会把刚换出来的「raiden shogun」再换一次 → shogun shogun。
    return src.replace(re, (hit, offset) => {
        const val = map[hit.toLowerCase()];
        if (!val) return hit;
        // 幂等：文本里已经是这个 tag 了就别再套一层（否则 hu tao → hu tao (genshin impact) (genshin impact)）
        if (src.slice(offset, offset + String(val).length).toLowerCase() === String(val).toLowerCase()) return hit;
        return val;
    });
}
/** 应用面板主题（具体配色在 style.css 的 [data-cig-theme] 里）。 */
function applyTheme() {
    const el = document.getElementById('cig-root');
    if (!el) return;
    const theme = String(S().theme || 'st');
    if (theme === 'st') el.removeAttribute('data-cig-theme');
    else el.setAttribute('data-cig-theme', theme);
}

/** 画师画风要注入的那一段（纯提示词；关掉开关或没选画师就返回空）。 */
function artistBlockFor(isFreeArea) {
    const s = S();
    if (s.artistOn === false) return '';
    if (isFreeArea && s.artistInFree !== true) return '';
    return buildArtistBlock(s.artistStyles || [], s.artistSyntax ?? '@');
}

/** 本次出图要不要拿某个角色的参考图做 img2img。返回 { name, abs } 或 null。 */
function fanRefTarget() {
    const s = S();
    if (!s.refNow || !fanPanel) return null;
    const names = [];
    const cur = resolvedName();
    if (cur) names.push(cur);
    for (const n of sceneCast()) if (!names.includes(n)) names.push(n);
    for (const n of names) {
        const abs = fanPanel.refAbsOf(n);
        if (abs) return { name: n, abs };
    }
    return null;
}

/**
 * 参考图开关的落点：勾了就用图生图工作流 + 把绝对路径塞进 %free_ref%；
 * 没勾、但酒馆当前正是图生图工作流（上一次用参考图留下的）就收拾干净，
 * 否则下一次普通出图会拿着一个已经不存在的参考图去跑。
 */
function applyFanRefWorkflow() {
    const sd = extension_settings?.sd;
    if (!sd) return;
    const target = fanRefTarget();
    const imgWf = String(workflowFor(true) || '');
    if (target) {
        if (imgWf) sd.comfy_workflow = imgWf;
        sd.denoising_strength = Math.min(1, Math.max(0.15, Number(S().fanRefDenoise) || 0.6));
        setComfyPlaceholder('free_ref', target.abs);
        console.log(`[CharImageGen] 用「${target.name}」的参考图做图生图（denoise ${sd.denoising_strength}）`);
    } else if (imgWf && String(sd.comfy_workflow || '') === imgWf) {
        const back = workflowFor(false);
        if (back) sd.comfy_workflow = back;
        sd.denoising_strength = 1.0;
        setComfyPlaceholder('free_ref', '');
    }
    save();
}

function injectLookIntoPrompt(prompt) {
    const cfg = lexSettings();
    const rawBody = String(prompt ?? '').trim();
    // 第一道评级：只看「剧情本身」（世界书/改写写出来的那段场景），不看角色外观档案 ——
    // 外观里带着 futanari（主角是扶她），拿它判 NSFW 会让普通剧情也一直发 explicit。
    // 第二道在拼完外观锁之后（见下面 nsfwFinal）：那时才分得清「身份里的 futanari」和
    // 「真的裸了 / 真的在做」（服装是裸体预设、或 stripNudityInSfw 关掉了）。
    const nsfw = isNsfwText(rawBody);
    syncRatingPrefix(nsfw);
    const wantRating = (S().nsfwRating !== false && nsfw) ? String(S().ratingNsfw || 'explicit') : '';
    let body = cfg.hook ? lexClean(applyFanNameMap(rawBody), { dedupe: false }) : applyFanNameMap(rawBody);
    if (wantRating) body = swapRatingTag(body, wantRating);
    // 尺寸：把提示词里的画幅解析出来，真的设成这次生成的分辨率（并去掉那串说明）
    body = applySizeToSt(body);

    // 外观锁：绘图区那条路不拼；其余按剧情决定要不要剥掉裸露 tag
    const look = skipLookOnce ? '' : lexCleanLook(buildLookBlock(rawBody));

    // 评级按「拼完的成品」再判一次：
    //  - 场景本身 NSFW，或
    //  - 最终提示词里真的出现了裸露/性行为 tag（选了「裸体」这套衣服、或关掉了 SFW 剥离）
    // 身份里的 futanari 不算（见 isNsfwBody）—— 否则主角是扶她，普通剧情也会一直 explicit。
    const sfw = shouldStripNudity(rawBody);
    const nsfwFinal = nsfw || isNsfwBody(look);
    if (nsfwFinal && !nsfw) {
        syncRatingPrefix(true);
        body = swapRatingTag(body, String(S().ratingNsfw || 'explicit'));
    }
    // 扶她的解剖负面词：只在「NSFW + 画面里有扶她」时追加，其他时候还原
    const hasFuta = isFutaIdentity(rawBody) || isFutaIdentity(look)
        || sceneCast().some(n => isFutaIdentity(identityOf(n)));
    syncFutaNegatives(hasFuta && !sfw);

    // 参考图（img2img）：绘图区那条路自己管，这里只管角色出图
    if (!skipLookOnce) {
        try { applyFanRefWorkflow(); } catch (err) { console.warn('[CharImageGen] 参考图工作流切换失败', err); }
    }

    // 外观锁已经给了权威人数（3girls 这种），正文里对不上的计数 tag 必须清掉；
    // 扁平动作句要绑到位置上，否则「谁在做什么」全看模型猜
    if (look) {
        body = bindActionsToCast(body, sceneCast().map(n => ({
            identity: identityOf(n),
            outfit: outfitTagsFor(n),
        })));
        body = fixCountConflicts(body, look);
    }
    // 画师画风：纯提示词注入，和 LoRA 各走各的（能叠加）
    const artistBlock = artistBlockFor(!!skipLookOnce);
    if (!look && !artistBlock) return body;

    // 画师 tag 放靠前（质量词之后、角色外观之前），风格影响更明显
    const head = [artistBlock, look].filter(Boolean).join(', ');
    // 分句写法自带句号，不能再补逗号，否则句读被破坏、位置锚点失效
    const glue = /[.!?]$/.test(head) ? '\n' : ', ';
    const prefix = String(extension_settings?.sd?.prompt_prefix || '').trim();
    if (prefix && body.toLowerCase().startsWith(prefix.toLowerCase())) {
        return `${body.slice(0, prefix.length)} ${head}${glue}${body.slice(prefix.length).trim()}`;
    }
    return `${head}${glue}${body}`;
}

/** 这段文字是不是 NSFW（词库判定，认不出就按不 NSFW 处理）。 */
function isNsfwText(text) {
    try {
        return lex().isNsfw(text);
    } catch {
        return false;
    }
}

/** 身份里的「扶她/性别」词不算 NSFW —— 否则主角是扶她，普通剧情也会一直发 explicit。 */
const GENDER_MARKER_RE = /\b(futanari|futa|dickgirl|newhalf|shemale)\b/gi;

/** 只看「裸露 / 性行为」：把性别词剔掉再判。服装库/store 里那身裸体、或场景真露了，才算。 */
function isNsfwBody(text) {
    return isNsfwText(String(text || '').replace(GENDER_MARKER_RE, ' '));
}

/** 在基准负面词后面补上这些 tag（已经有的不重复加）。 */
function withNegatives(base, extras) {
    const parts = splitTags(String(base || '')).map(t => t.trim()).filter(Boolean);
    const have = new Set(parts.map(t => t.toLowerCase()));
    for (const t of extras) {
        const k = String(t).trim();
        if (!k || have.has(k.toLowerCase())) continue;
        parts.push(k);
        have.add(k.toLowerCase());
    }
    return parts.join(', ');
}

/**
 * 扶她专用负面词：只在「NSFW 且画面里真有扶她」时追加，其他时候原样还原。
 * 和评级前缀一样，改的是酒馆的 sd.negative_prompt（钩子之后才拼进请求，改文本没用），
 * 并且自己留一份基准副本 userNegativePrompt，用户手动改过就以他的为准。
 */
function syncFutaNegatives(need) {
    const sd = extension_settings?.sd;
    if (!sd) return;
    const s = S();
    const cur = String(sd.negative_prompt ?? '');
    const extras = splitTags(String(s.futaNegatives || '')).map(t => t.trim()).filter(Boolean);
    let own = typeof s.userNegativePrompt === 'string' ? s.userNegativePrompt : '';
    if (!own) {
        own = cur;
        s.userNegativePrompt = own;
        save();
    } else if (cur !== own && cur !== withNegatives(own, extras)) {
        own = cur;                 // 用户在酒馆里自己改过负面词 → 以他的为准
        s.userNegativePrompt = own;
        save();
    }
    const target = (need && extras.length) ? withNegatives(own, extras) : own;
    if (cur === target) return;
    sd.negative_prompt = target;
    try { $('#sd_negative_prompt').val(target); } catch { /* 界面没渲染也无所谓 */ }
    console.log('[CharImageGen] 扶她负面词 ' + (need ? '已追加' : '已还原'));
}

/** 提示词里所有「画幅说明」的写法：aspect ratio 16:9, 1344x768 / 1344x768 / --ar 9:16。 */
// （见 castmatch.js 的 SIZE_SPEC_RE / stripSizeSpec）

/**
 * 按剧情决定这张图的分辨率。
 *
 * 世界书会在提示词末尾写 `aspect ratio 16:9, 1344x768` —— 那就是模型按当前剧情挑好的画幅。
 * 酒馆的 ComfyUI 链路是在钩子**之后**才把 extension_settings.sd.width / height 填进工作流的
 * （stable-diffusion/index.js 的 generateComfyImageCommon 里 replaceAll("%width%")），
 * 所以在这里改就一定生效，工作流一个字都不用动。
 *
 * 返回「去掉画幅说明之后」的提示词。
 */
function applySizeToSt(text) {
    const s = S();
    const sd = extension_settings?.sd;
    const mode = s.sizeMode || 'auto';
    if (!sd || mode === 'off') return text;

    const spec = mode === 'auto' ? parseSizeSpec(text, { maxMegapixels: s.maxMegapixels }) : null;
    let w;
    let h;
    let from;
    if (spec) {
        w = spec.w;
        h = spec.h;
        from = 'prompt';
    } else {
        const c = clampSize(s.fixedWidth, s.fixedHeight, s.maxMegapixels) || { w: 832, h: 1216 };
        w = c.w;
        h = c.h;
        from = 'fixed';
    }

    if (sd.width !== w || sd.height !== h) {
        sd.width = w;
        sd.height = h;
        console.log(`[CharImageGen] 尺寸 → ${w}x${h}（${from === 'prompt' ? '来自提示词的画幅' : '固定值'}）`);
        try {
            const el = document.getElementById('cig-size-last');
            if (el) el.textContent = `上次实际尺寸：${w}×${h}（${from === 'prompt' ? '按剧情画幅' : '固定值'}）`;
        } catch { /* 面板没渲染也无所谓 */ }
    }

    if (spec && s.sizeStripTag !== false) return stripSizeSpec(text);
    return text;
}

/**
 * 评级 tag 必须改在酒馆的 prompt_prefix 上，不能只改提示词文本。
 * 原因：酒馆是在 SD_PROMPT_PROCESSING 钩子**之后**、sendGenerationRequest() 里
 * 才把 prompt_prefix 拼到提示词前面（stable-diffusion/index.js 第 3332 行），
 * 所以钩子里拿到的字符串里根本没有 safe/explicit —— 之前只改文本，一直打不中，
 * 于是 safe 永远压着 NSFW。
 *
 * 自己那份前缀单独记在 s.ratingUserPrefix 里，用户手动改过就以他的为准，
 * 这样 SFW 的图还能换回 safe，不会把 explicit 粘住。
 */
function syncRatingPrefix(nsfw) {
    const sd = extension_settings?.sd;
    if (!sd) return;
    const s = S();
    const cur = String(sd.prompt_prefix ?? '');
    const want = String(s.ratingNsfw || 'explicit');
    let own = typeof s.ratingUserPrefix === 'string' ? s.ratingUserPrefix : '';
    if (!own) {
        own = cur;
        s.ratingUserPrefix = own;
        save();
    } else if (cur !== own && cur !== withRating(own, want)) {
        own = cur;               // 用户在酒馆里自己改过前缀 → 以他的为准
        s.ratingUserPrefix = own;
        save();
    }
    const target = (s.nsfwRating !== false && nsfw) ? withRating(own, want) : own;
    if (cur === target) return;
    sd.prompt_prefix = target;
    try { $('#sd_prompt_prefix').val(target); } catch { /* 界面没渲染也无所谓 */ }
    console.log('[CharImageGen] 评级前缀 → ' + target);
}

/** 把评级 tag 换成 want；原本一个评级 tag 都没有就在末尾补一个。 */
function withRating(text, want) {
    const base = String(text || '').trim();
    if (!want) return base;
    let hit = false;
    const parts = splitTags(base).map(t => {
        if (RATING_RE.test(t.trim())) { hit = true; return want; }
        return t;
    });
    if (!hit) parts.push(want);
    return parts.join(', ');
}

/** 评级 tag：模型只认这几个单词，且必须是独立的 tag，不能是普通单词的一部分。 */
const RATING_TAGS = new Set(['safe', 'sensitive', 'questionable', 'explicit', 'general', 'nsfw']);
const RATING_RE = /^(safe|sensitive|questionable|explicit|general|nsfw)$/i;

/** 把提示词里独立的评级 tag 换成目标值（没有评级 tag 就不动，不擅自加）。 */
function swapRatingTag(text, want) {
    if (!text || !want) return text;
    let touched = false;
    const out = splitTags(text).map(t => {
        const k = t.trim().toLowerCase();
        if (!RATING_TAGS.has(k)) return t;
        if (k === want.toLowerCase()) return t;
        touched = true;
        return want;
    });
    return touched ? out.join(', ') : text;
}

const COUNT_TAG_RE = /^(solo|multiple (girls|boys)|\d+\+?\s*(girls?|boys?|others?))$/i;

/**
 * 正文里的计数 tag 和外观锁打架时，以外观锁为准。
 *  - 纯计数 tag（1girl / 2girls / solo）：和外观锁一致就留，不一致就丢
 *  - 「1girl short red hair …」这种计数开头 + 描述：只砍掉开头的计数，描述留着
 */
function fixCountConflicts(body, look) {
    const want = splitTags(String(look).split('\n')[0])
        .map(t => t.trim().toLowerCase())
        .filter(t => COUNT_TAG_RE.test(t));
    if (!want.length) return body;
    const keep = new Set(want);
    const out = [];
    for (const tok of splitTags(body)) {
        const k = tok.trim().toLowerCase();
        if (COUNT_TAG_RE.test(k)) {
            if (keep.has(k)) out.push(tok);
            continue;
        }
        const stripped = tok.replace(/^\s*\d+\+?\s*(girls?|boys?|others?)\b[\s,]*/i, '').trim();
        out.push(stripped && stripped !== tok.trim() ? stripped : tok);
    }
    return out.join(', ');
}

/**
 * 外观锁的规范化。
 * 多人画面是「按位置分句」写法（换行 + 句号就是硬切分锚点），绝不能按逗号重排，
 * 所以带换行的一律原样返回。
 */
function lexCleanLook(look) {
    if (!look || /[\r\n]/.test(look)) return look;
    return lexClean(look, { dedupe: true });
}

/**
 * 把预设里那个静态条目同步成当前指令文本，避免「预设一份、扩展一份」两边走偏。
 * 预设条目带不了动态的「已登记」名单，所以用 withRegistry=false 的版本。
 * getContext().chatCompletionSettings 就是 oai_settings（st-context.js:226 确认过）。
 */
function syncPresetEntry() {
    try {
        const list = getContext()?.chatCompletionSettings?.prompts;
        if (!Array.isArray(list)) return 'no-list';
        const entry = list.find(p => p?.name === CAST_ENTRY_NAME);
        if (!entry) return 'no-entry';
        const want = buildInstruction({ withRegistry: false });
        if (entry.content !== want) {
            entry.content = want;
            save();
            return 'updated';
        }
        return 'same';
    } catch (err) {
        console.warn('[CharImageGen] 同步预设条目失败', err);
        return 'error';
    }
}

/** 隐藏用的正则：两种标签形式都要能吃，且不能误伤别人的 img-prompt 注释。 */
function castFindRegex() {
    return `/<${CAST_TAG}>[\\s\\S]*?<\\/${CAST_TAG}>|(?:<[!\\-\\s]*)?cast\\s*=\\s*\\{[\\s\\S]*?-->/g`;
}

/** 确保两条正则存在：一条只影响显示（隐藏块），一条只影响提示词（省 token）。 */
function installRegexes() {
    const s = S();
    if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
    const list = extension_settings.regex;
    const mk = (scriptName, markdownOnly, promptOnly) => ({
        id: (crypto?.randomUUID?.() ?? String(Date.now() + Math.random())),
        scriptName,
        disabled: false,
        runOnEdit: true,
        findRegex: castFindRegex(),
        trimStrings: [],
        replaceString: '',
        placement: [2],
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        markdownOnly,
        promptOnly,
    });

    let added = 0;
    for (const [name, mdOnly, prOnly] of [[REGEX_HIDE, true, false], [REGEX_STRIP, false, true]]) {
        const exist = list.find(r => r?.scriptName === name);
        if (exist) {
            exist.disabled = false;
            exist.findRegex = castFindRegex();
            exist.markdownOnly = mdOnly;
            exist.promptOnly = prOnly;
        } else {
            list.push(mk(name, mdOnly, prOnly));
            added++;
        }
    }
    save();
    return added;
}

/** 从 start 处的 { 开始做花括号配对，返回完整的 JSON 文本（正确处理字符串与转义）。 */
function extractBalancedJson(text, start) {
    if (text[start] !== '{') return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * 解析登记块。故意不依赖 HTML 注释语法 —— 实测模型会把 <!--cast= 写成 <cast=，
 * 所以这里只认「cast= 后面跟一个 JSON 对象」，前后缀怎么写都能吃。
 */
function parseCastBlock(text) {
    const t = String(text ?? '');
    // 形式一：<UpdateCast>{...}</UpdateCast>
    const m = t.match(new RegExp(`<${CAST_TAG}>([\\s\\S]*?)</${CAST_TAG}>`, 'i'));
    if (m) {
        const v = parseJsonLoose(m[1]);
        if (v && typeof v === 'object') return v;
    }
    // 形式二：cast= 后跟 JSON 对象；花括号配对取完整对象
    const re = /(?:<[!\-–—\s]*)?cast\s*=\s*/gi;
    let hit;
    while ((hit = re.exec(t)) !== null) {
        const brace = t.indexOf('{', hit.index + hit[0].length - 1);
        if (brace === -1) continue;
        const json = extractBalancedJson(t, brace);
        if (!json) continue;
        const v = parseJsonLoose(json);
        if (v && typeof v === 'object') return v;
    }
    return null;
}

/**
 * 增量合并。要点：
 *  - 角色内容没变就不动，变了才原地更新
 *  - 服装按 tag 集合判等：一样就复用已有条目，不一样才派生成差分
 *  - outfits 是数组，每个出场角色各一条；兼容旧的单个 outfit 对象
 *  - 记录「哪个角色现在穿哪一套」，画面主角切换时自动跟随（受 autoFollow 控制）
 */
function mergeCast(payload) {
    const s = S();
    const log = { newChars: [], updatedChars: [], reusedOutfits: [], newOutfits: [], unchanged: 0, owned: [] };

    let chars = payload?.characters ?? payload?.new_characters ?? [];
    if (!Array.isArray(chars)) chars = [];
    const present = [];
    for (const it of chars) {
        const name = String(it?.name ?? it?.character ?? '').trim();
        const identity = tidyPrompt(it?.identity ?? it?.appearance ?? '');
        if (!name || !identity) continue;
        // 模型报的若是玩家本人，存到玩家槽位，别混进 NPC 列表
        const who = isPlayerName(name) ? PLAYER : name;
        if (!present.includes(who)) present.push(who);
        const cur = subjectEntry(who);
        if (!cur) {
            s.characters[name] = { identity, source: currentChar().name, outfit: '' };
            log.newChars.push(name);
        } else if (normTags(cur.identity) !== normTags(identity)) {
            cur.identity = identity;
            log.updatedChars.push(isPlayer(who) ? `🧍${playerLabel()}` : name);
        } else {
            log.unchanged++;
        }
    }

    // 服装：数组优先，单个对象兼容
    let list = payload?.outfits;
    if (!Array.isArray(list)) list = (payload?.outfit && typeof payload.outfit === 'object') ? [payload.outfit] : [];
    for (const o of list) {
        if (!o || typeof o !== 'object') continue;
        const tags = tidyPrompt(o.tags ?? o.outfit ?? '');
        if (!tags) continue;
        const owner = String(o.character ?? o.name_of_character ?? '').trim();

        const res = addOutfit(o.name, tags);
        if (!res) continue;
        const name = res.name;
        if (res.reused) {
            if (!log.reusedOutfits.includes(name)) log.reusedOutfits.push(name);
        } else if (res.grouped) {
            log.newOutfits.push(`${name}（归入 ${res.grouped}）`);
        } else {
            log.newOutfits.push(name);
        }
        // 记下这个角色当前穿的是哪一套
        const ownerKey = owner && isPlayerName(owner) ? PLAYER : owner;
        if (ownerKey && subjectEntry(ownerKey)) {
            subjectEntry(ownerKey).outfit = name;
            log.owned.push(`${isPlayer(ownerKey) ? '🧍' + playerLabel() : ownerKey}→${name}`);
        }
        if (!owner) s.currentOutfit = name;
    }

    // 跟随：把当前角色/服装切到画面主角身上那套
    const sceneChar = String(payload?.scene_character ?? '').trim();
    const sceneKey = sceneChar && isPlayerName(sceneChar) ? PLAYER : sceneChar;
    if (sceneKey && subjectEntry(sceneKey)) {
        if (s.autoFollow) s.activeChar = sceneKey;
        const worn = wornOutfitOf(sceneKey);
        if (worn && s.outfits[worn] !== undefined && s.autoFollow) s.currentOutfit = worn;
    }
    // 出场名单：只认正文登记块（带 scene_character 或 outfits），
    // 角色卡识别那条路只报 characters，不能拿它当「本画面有谁」。
    const fromScene = Object.prototype.hasOwnProperty.call(payload ?? {}, 'scene_character')
        || Array.isArray(payload?.outfits);
    if (fromScene && present.length) {
        // 画面主角排最前，保证同一场里左右位置不会来回翻
        if (sceneKey && present.includes(sceneKey)) {
            present.splice(present.indexOf(sceneKey), 1);
            present.unshift(sceneKey);
        }
        s.lastCast = present;
        s.lastScene = sceneKey || '';
    }
    save();
    return log;
}

function mergeSummary(log) {
    const bits = [];
    if (log.newChars.length) bits.push(`新角色 ${log.newChars.join('、')}`);
    if (log.updatedChars.length) bits.push(`外观更新 ${log.updatedChars.join('、')}`);
    if (log.newOutfits.length) bits.push(`新服装 ${log.newOutfits.join('、')}`);
    if (log.reusedOutfits.length) bits.push(`复用服装 ${log.reusedOutfits.join('、')}`);
    if (log.owned && log.owned.length) bits.push(`当前穿着 ${log.owned.join('、')}`);
    if (log.unchanged) bits.push(`跳过未变角色 ${log.unchanged}`);
    return bits.join(' | ');
}

// ---------------------------------------------------------------- 词库
//
// 把 SD-WebUI 里那套词库（tagcomplete 的 danbooru 标签表 + 提示词插件的中文分类词库）
// 拿来做三件事，全部本地跑、不加 API 调用、与模型和工作流无关：
//   ① 改写时给 LLM 喂「动作 / 表情 / 镜头」候选词 —— 动作更容易出得来、也更丰富
//   ② 出图前把提示词捋一遍：中文 → 英文 tag、别名 → 规范 tag、去重
//   ③ 面板里能搜词、翻分类、随机抽动作
// 词库原文存在 IndexedDB 里，下次开页面直接重建索引，不联网。

const LEX_DB = 'cig_lexicon';
const LEX_STORE = 'files';
/** 「从插件 tags/ 自动加载」按顺序试这些文件，取不到的跳过。 */
const LEX_AUTO_FILES = [
    'tags/zh_CN.yaml',
    'tags/group_tags/zh_CN.yaml',
    'tags/danbooru.csv',
    'tags/danbooru.zh_CN_SFW.csv',
    'tags/danbooru.zh_CN.csv',
    'tags/e621.csv',
    'tags/custom.yaml',
    'tags/append.yaml',
];

let LEX = null;

/** 词库单例。没导过词库时先给一份内置兜底，保证任何入口都不会因为「没词库」而报错。 */
function lex() {
    if (!LEX) LEX = buildLexiconFromSources([]);
    return LEX;
}

/** 只有兜底词库 = 还没导入真词库。 */
function lexIsReal() {
    return lex().stats().tags > 300;
}

function lexSettings() {
    const s = S();
    return {
        inject: s.lexInject !== false,
        fromChat: s.lexFromChat !== false,
        normalize: s.lexNormalize !== false,
        hook: s.lexHookNormalize !== false,
        perBucket: Number(s.lexPerBucket) || 8,
        near: Number(s.lexNear) || 4,
    };
}

/**
 * 规范化一段生图提示词：中文→英文 tag、别名→规范 tag、去重。
 * 认不出的 tag 一律原样保留（只报告、不乱改），所以对任何模型都是安全的。
 */
function lexClean(text, { dedupe = true, force = false } = {}) {
    if (!text) return text;
    if (!force && !lexSettings().normalize) return text;
    try {
        return lex().normalizePrompt(text, {
            translate: true, canonical: true, dedupe, dropUnknown: false,
        }).text;
    } catch (err) {
        console.warn('[CharImageGen] 词库规范化失败，原样返回', err);
        return text;
    }
}

/** 最近几条正文，用来从剧情里挖动作词（登记块先剔掉）。 */
function recentStory(limit = 2) {
    try {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat) || !chat.length) return '';
        return chat.slice(-limit)
            .map(m => String(m?.mes || '').replace(/<!--[\s\S]*?-->/g, ' '))
            .join('\n').slice(-2000);
    } catch {
        return '';
    }
}

/** 给改写用的 LLM 准备候选词提示块；没候选就返回空串。 */
function lexHintFor(text) {
    const cfg = lexSettings();
    if (!cfg.inject) return '';
    try {
        const body = cfg.fromChat ? `${text}\n${recentStory(2)}` : String(text ?? '');
        // 三个人以上同框：额外把群体体位候选也推过去
        const groupSex = sceneCast().length >= 3;
        const cand = lex().findCandidates(body, { perBucket: cfg.perBucket, nearCount: cfg.near, groupSex });
        return lex().candidatesToHint(cand);
    } catch (err) {
        console.warn('[CharImageGen] 词库候选检索失败', err);
        return '';
    }
}

/** 词库查不到的 tag（只报告，给面板提示用）。 */
function lexUnknown(text) {
    try {
        return lex().unknownTags(text);
    } catch {
        return [];
    }
}

// ---- IndexedDB：存词库原文（不是索引），下次开页面直接重建

function lexDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(LEX_DB, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(LEX_STORE)) {
                db.createObjectStore(LEX_STORE, { keyPath: 'name' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function lexDbAll() {
    return lexDb().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(LEX_STORE, 'readonly').objectStore(LEX_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

function lexDbPut(items) {
    return lexDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(LEX_STORE, 'readwrite');
        const store = tx.objectStore(LEX_STORE);
        for (const it of items) store.put(it);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function lexDbClear() {
    return lexDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(LEX_STORE, 'readwrite');
        tx.objectStore(LEX_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

/** 启动时把上次导入的词库重建起来（纯本地，不联网）。 */
async function lexRestore() {
    try {
        const rows = await lexDbAll();
        if (!rows.length) return false;
        LEX = buildLexiconFromSources(rows);
        return true;
    } catch (err) {
        console.warn('[CharImageGen] 词库恢复失败（不影响出图）', err);
        return false;
    }
}

/** 导入文件（File / FileList）：格式自动认、编码自动认（GBK 也能读）。 */
async function lexImport(files) {
    const rows = [];
    for (const f of [...files]) {
        const buf = new Uint8Array(await f.arrayBuffer());
        rows.push({ name: f.name, text: decodeBytes(buf), size: f.size, at: Date.now() });
    }
    if (!rows.length) return { added: 0 };
    await lexDbPut(rows);
    LEX = buildLexiconFromSources(rows);
    return { added: rows.length, stats: LEX.stats() };
}

/** 从插件自己的 tags/ 目录拉词库：把 SD-WebUI 的标签文件拷进来即可一键加载。 */
async function lexAutoLoad() {
    const got = [];
    for (const rel of LEX_AUTO_FILES) {
        try {
            const res = await fetch(new URL(rel, import.meta.url).href, { cache: 'no-cache' });
            if (!res.ok) continue;
            const buf = new Uint8Array(await res.arrayBuffer());
            if (!buf.length) continue;
            got.push({
                name: rel.replace(/^tags\//, '').replace(/\//g, '_'),
                text: decodeBytes(buf), size: buf.length, at: Date.now(),
            });
        } catch { /* 没这个文件就算了 */ }
    }
    if (got.length) {
        await lexDbPut(got);
        LEX = buildLexiconFromSources(got);
    }
    return { added: got.length, stats: LEX ? LEX.stats() : null };
}

async function lexClear() {
    await lexDbClear();
    LEX = buildLexiconFromSources([]);
}

// ---------------------------------------------------------------- UI

function buildUI() {
    const s = S();

    const root = document.createElement('div');
    root.id = 'cig-root';
    root.innerHTML = `
<div id="cig-launcher" title="角色一致性生图">🎨</div>
<div id="cig-panel" class="cig-hidden">
  <div id="cig-header" title="按住拖动 · 双击折叠">
    <span class="cig-grip" aria-hidden="true">⠿</span>
    <span class="cig-title">🎨 角色一致性生图</span>
    <span class="cig-hbtn" id="cig-fold-all" title="全部折叠 / 全部展开">⇕</span>
    <span class="cig-hbtn" id="cig-collapse" title="折叠 / 展开整个面板">▾</span>
    <span class="cig-hbtn" id="cig-close" title="关闭">✕</span>
  </div>
  <div id="cig-body">
    <div class="cig-charbar">当前角色卡：<b id="cig-charname">—</b></div>

    <details id="cig-free-box" open>
    <summary>绘图区<span class="cig-hint">（纯提示词，不拼角色外观锁）</span></summary>
    <div class="cig-set">
      <textarea id="cig-free-prompt" rows="4" placeholder="直接写提示词，中文英文都行&#10;例：雨夜霓虹街道上回头的黑发红瞳少女，特写，电影感光影"></textarea>
      <div class="cig-row">
        <button id="cig-free-go" class="cig-btn cig-primary">生成图片</button>
        <button id="cig-free-clean" class="cig-btn">本地规范化</button>
      </div>
      <label class="cig-check"><input id="cig-free-norm" type="checkbox" /> 发送前用词库规范化（中文→英文 tag、别名纠正、去重）</label>

      <label class="cig-label">参考图<span class="cig-hint">（选了就是图生图重绘，不选就是纯文生图）</span></label>
      <div class="cig-row">
        <button id="cig-free-ref-pick" class="cig-btn">上传图片</button>
        <button id="cig-free-ref-clear" class="cig-btn">清除参考图</button>
      </div>
      <input id="cig-free-ref-file" type="file" accept="image/*" style="display:none" />
      <div id="cig-free-ref-info" class="cig-hint"></div>
      <img id="cig-free-ref-preview" alt="" />
      <label class="cig-label" for="cig-free-denoise">重绘幅度 denoise <span id="cig-free-denoise-val"></span><span class="cig-hint">（越低越像原图）</span></label>
      <input id="cig-free-denoise" type="range" min="0.15" max="1" step="0.05" />

      <div class="cig-hint">这条路径和角色无关：不拼外观锁、不认场景登记，就是个普通的文生图入口。
        尺寸走上面的「尺寸」设置；提示词里写 <code>1344x768</code> 或 <code>--ar 16:9</code> 也会照它走。
        NSFW 时 rating 照样会自动切 explicit。</div>
      <div id="cig-free-log" class="cig-hint"></div>
    </div>
    </details>

    <details id="cig-gen-box" open>
    <summary>出图</summary>
    <div class="cig-set">
    <label class="cig-label" for="cig-mode">模式</label>
    <select id="cig-mode">
      <option value="free">自由构图 —— 可出任意角度/动作（推荐）</option>
      <option value="lock">锁定形象 —— 最像，但构图被头像锁死</option>
    </select>

    <label class="cig-label">出镜人物<span class="cig-hint">（自动从正文认人）</span></label>
    <div id="cig-cast-auto" class="cig-hint"></div>
    <div id="cig-cast-pick" class="cig-pick"></div>
    <label class="cig-check"><input id="cig-auto-player" type="checkbox" /> 玩家没被点名时，也算他/她在画面里</label>
    <div class="cig-hint">自动识别看的是「你刚发的那句 + 最近几条正文 + 输入框」，正文里点到名的角色都会画进去 ——
      三个人同框不用手动勾，模型登记漏人也不怕。识别不准时（有重名、或者你只是在旁观）才勾下面的人强制指定。</div>

    <label class="cig-label" for="cig-size-mode">尺寸<span class="cig-hint">（世界书会给每张图配画幅，自动就是用它）</span></label>
    <select id="cig-size-mode">
      <option value="auto">自动：按提示词里的画幅（推荐）</option>
      <option value="fixed">固定：一直用下面这组</option>
      <option value="off">不动酒馆的宽高</option>
    </select>
    <div class="cig-row">
      <input id="cig-size-w" type="text" placeholder="宽" />
      <input id="cig-size-h" type="text" placeholder="高" />
    </div>
    <div class="cig-row">
      <button id="cig-size-preset-v" class="cig-btn">竖 832×1216</button>
      <button id="cig-size-preset-h" class="cig-btn">横 1216×832</button>
      <button id="cig-size-preset-s" class="cig-btn">方 1024×1024</button>
    </div>
    <label class="cig-label" for="cig-size-mp">尺寸上限 <span id="cig-size-mp-val"></span> MP<span class="cig-hint">（超了按比例缩；8G 显存别开太大）</span></label>
    <input id="cig-size-mp" type="range" min="0.5" max="2.5" step="0.1" />
    <label class="cig-check"><input id="cig-size-strip" type="checkbox" /> 把画幅说明从提示词里去掉</label>
    <div id="cig-size-last" class="cig-hint"></div>

    <label class="cig-label" for="cig-input">你要画什么？</label>
    <textarea id="cig-input" rows="3" placeholder="例：她从背后走去，雨夜的霓虹街道"></textarea>

    <div class="cig-row">
      <button id="cig-convert" class="cig-btn">仅改写</button>
      <button id="cig-generate" class="cig-btn cig-primary">改写并生成</button>
    </div>

    <label class="cig-label" for="cig-preview">场景描述<span class="cig-hint">（身份/服装会自动拼上）</span></label>
    <textarea id="cig-preview" rows="5" placeholder="转换后的提示词会出现在这里"></textarea>
    <button id="cig-generate-raw" class="cig-btn cig-wide">用上面的提示词直接生成</button>
    </div>
    </details>

    <details id="cig-player-box" open>
      <summary>玩家主角<span class="cig-hint">（我 / persona，独立存档）</span></summary>
      <div class="cig-set">
        <div class="cig-charbar">🧍 <b id="cig-player-name">玩家主角</b>
          <span class="cig-hint">＝ 酒馆里的 {{user}}，和角色卡的 NPC 分开存</span></div>
        <label class="cig-label" for="cig-player-identity">外观（固定身体特征，不含服装）</label>
        <textarea id="cig-player-identity" rows="3" placeholder="例：1boy, short black hair, blue eyes, tall, muscular build"></textarea>
        <div class="cig-row">
          <button id="cig-player-extract" class="cig-btn">从 persona 提取</button>
          <button id="cig-player-clear" class="cig-btn">清空</button>
        </div>
        <label class="cig-label" for="cig-player-outfit-select">当前穿着</label>
        <select id="cig-player-outfit-select"></select>
        <div id="cig-player-outfit" class="cig-hint"></div>
        <button id="cig-player-apply" class="cig-btn cig-wide">把「我」设为当前画面主体</button>
      </div>
    </details>

    <details id="cig-quick-box" open>
      <summary>一键换装出图<span class="cig-hint">（选人 + 选衣 + 选镜头）</span></summary>
      <div class="cig-set">
        <label class="cig-label" for="cig-quick-char">角色</label>
        <select id="cig-quick-char"></select>
        <label class="cig-label" for="cig-quick-outfit">服装</label>
        <select id="cig-quick-outfit"></select>
        <label class="cig-label" for="cig-quick-shot">镜头 / 构图</label>
        <select id="cig-quick-shot"></select>
        <textarea id="cig-quick-extra" rows="2" placeholder="补充描述（可留空）：例：站在雨里，湿发贴在脸上"></textarea>
        <div class="cig-row">
          <button id="cig-quick-preview" class="cig-btn">只预览</button>
          <button id="cig-quick-go" class="cig-btn cig-primary">一键生成</button>
        </div>
        <div class="cig-hint">选完直接出图：角色和服装会成为当前主体，外观锁自动拼进提示词，镜头预设可叠加自定义描述。
          改角色/服装也会同步到上面的下拉框。</div>
      </div>
    </details>

    <details id="cig-auto-box" open>
      <summary>自动登记<span class="cig-hint">（走主生成，零额外调用）</span></summary>
      <div class="cig-set">
        <label class="cig-check"><input id="cig-autoreg" type="checkbox" /> 往主提示词注入登记指令</label>
        <label class="cig-check"><input id="cig-autofollow" type="checkbox" /> 生成时跟随正文登记的角色与服装</label>
        <label class="cig-check"><input id="cig-multichar" type="checkbox" /> 多人画面按位置分句描写（减少两人长一个样）</label>
        <label class="cig-label" for="cig-injectpos">注入位置</label>
        <select id="cig-injectpos">
          <option value="chat">对话末尾（推荐，模型最不容易忽略）</option>
          <option value="system">系统提示词（长角色卡容易被淹没）</option>
        </select>
        <div class="cig-row">
          <button id="cig-rescan" class="cig-btn">扫描最近回复</button>
          <button id="cig-install-regex" class="cig-btn">修复隐藏正则</button>
        </div>
        <button id="cig-sync-preset" class="cig-btn cig-wide">同步指令到预设条目</button>
        <button id="cig-copy-instruction" class="cig-btn cig-wide">复制指令（手动贴进预设用）</button>
        <div class="cig-hint">模型会在回复里附一行 &lt;!--cast={...}--&gt;，正则把它隐藏，扩展解析入库。
          没变化的角色不会重复提取，服装一模一样时复用，不同才派生成差分。走你自己的预设，不额外花钱。</div>
        <div id="cig-autolog" class="cig-hint"></div>
      </div>
    </details>

    <details id="cig-cast-box" open>
      <summary>角色与服装<span class="cig-hint">（自由构图靠它认人）</span></summary>
      <div class="cig-set">
        <label class="cig-label" for="cig-char-select">角色身份<span class="cig-hint">（按角色卡分组）</span></label>
        <select id="cig-char-select"></select>
        <div id="cig-cast-owner" class="cig-hint"></div>
        <textarea id="cig-identity" rows="3" placeholder="只写身体特征：1girl, solo, long black hair, red eyes, pale skin"></textarea>
        <button id="cig-cast-delete" class="cig-btn cig-wide">删除该角色存档</button>

        <label class="cig-label" for="cig-outfit-select">服装</label>
        <select id="cig-outfit-select"></select>
        <div id="cig-outfit-owner" class="cig-hint"></div>
        <div class="cig-lookbox">
          <div class="cig-label">会拼进提示词的外观锁<span class="cig-hint">（所有生图路径生效）</span></div>
          <div id="cig-look-preview" class="cig-hint"></div>
        </div>
        <div class="cig-label">自建 / 修改服装<span class="cig-hint">（自己填名字和标签，存进全局服装库）</span></div>
        <textarea id="cig-outfit" rows="3" placeholder="white summer dress, thighhighs, brown loafers"></textarea>
        <input id="cig-outfit-name" type="text" placeholder="服装名（必填，例如：白色夏日连衣裙）" />
        <select id="cig-outfit-base"></select>
        <label class="cig-check"><input id="cig-outfit-force" type="checkbox" /> 强制新建分类（忽略「太像」判定）</label>
        <div class="cig-row">
          <button id="cig-outfit-save" class="cig-btn cig-primary">保存到服装库</button>
          <button id="cig-outfit-delete" class="cig-btn">删除该服装</button>
        </div>
        <div id="cig-outfit-msg" class="cig-hint"></div>
        <button id="cig-outfit-autogroup" class="cig-btn cig-wide">自动整理服装分类</button>
        <div class="cig-hint">服装库全局共享 —— 任何角色都能穿任意一套。上方下拉框按「分类」分组，
          <b>差分</b>指同一套衣服的不同状态：原装 / 破损 / 半脱 / 换了一部分（鞋袜、外层、颜色…）——
这种才收成「名字·2」。只是长得像的两套衣服（连衣裙 vs 和服）不会合并，
只是措辞不同或只换了个小首饰的也不会重复存一条。选「跟随剧情」则不锁定服装。</div>

        <div class="cig-hint">想<b>自己加一个角色</b>？用下面「同人角色」区块里的「<b>✍ 自建角色（手动填写）</b>」：填名字 + 外观 tag，点「保存并建档」就进库了。</div>

        <details id="cig-manual-box">
          <summary>备用：手动提取（会调一次 API）</summary>
          <div class="cig-set">
            <div class="cig-row">
              <button id="cig-cast-extract" class="cig-btn">提取本卡全部角色</button>
              <button id="cig-outfit-extract" class="cig-btn">提取当前角色服装</button>
            </div>
            <div class="cig-hint">不依赖主生成，但每次点击都会单独请求一次模型。</div>
          </div>
        </details>
      </div>
    </details>

    <details id="cig-fan-box" open>
      <summary>同人角色<span class="cig-hint">（原作角色一键建档，带标志性服装）</span></summary>
      <div class="cig-set">
        <div id="cig-fan-body"></div>
      </div>
    </details>

    <details id="cig-artist-box" open>
      <summary>画师画风<span class="cig-hint">（把画师 tag 加进提示词；和 LoRA 可叠加）</span></summary>
      <div class="cig-set">
        <div id="cig-artist-body"></div>
      </div>
    </details>

    <details id="cig-lex-box" open>
      <summary>词库<span class="cig-hint">（SD-WebUI 的标签库，本地跑、不花 API）</span></summary>
      <div class="cig-set">
        <div id="cig-lex-stat" class="cig-hint">词库未加载</div>
        <div class="cig-row">
          <button id="cig-lex-import" class="cig-btn">导入词库文件</button>
          <button id="cig-lex-auto" class="cig-btn">从插件 tags/ 加载</button>
        </div>
        <input id="cig-lex-file" type="file" multiple accept=".csv,.yaml,.yml,.txt" style="display:none" />

        <label class="cig-check"><input id="cig-lex-inject" type="checkbox" /> 改写时把「动作 / 表情 / 镜头」候选词喂给模型</label>
        <label class="cig-check"><input id="cig-lex-chat" type="checkbox" /> 候选词也从最近剧情里找</label>
        <label class="cig-check"><input id="cig-lex-norm" type="checkbox" /> 出图前规范化提示词（中文→英文、别名纠正）</label>
        <label class="cig-check"><input id="cig-lex-hook" type="checkbox" /> 酒馆自带生图也过一遍翻译 / 归一</label>
        <label class="cig-check"><input id="cig-strip-nudity" type="checkbox" /> 非 NSFW 剧情时，自动剥掉服装库里的裸露状态</label>
        <div class="cig-hint">服装库会「记住上一场穿成什么样」。NSFW 那场留下的 topless / bottomless 如果不剥掉，
          之后每一张图都会无条件套用 —— 正常剧情也会被画成半裸体。</div>

        <label class="cig-label" for="cig-lex-search">搜词<span class="cig-hint">（中文或英文；点下面的结果追加到「场景描述」）</span></label>
        <input id="cig-lex-search" type="text" placeholder="例：拥抱 / hug / 双马尾" />
        <div class="cig-row">
          <select id="cig-lex-cat"></select>
          <select id="cig-lex-sub"></select>
        </div>
        <div id="cig-lex-results"></div>
        <div class="cig-row">
          <button id="cig-lex-random" class="cig-btn">随机来 3 个动作</button>
          <button id="cig-lex-clear" class="cig-btn">清空词库</button>
        </div>
        <div id="cig-lex-check"></div>
        <div class="cig-hint">把 SD-WebUI 里的
          <code>group_tags/zh_CN.yaml</code>（中文分类词库）和
          <code>tags/danbooru.csv</code>（标签表，可再加 <code>danbooru.zh_CN_SFW.csv</code>）丢进来即可，
          格式与编码自动识别（GBK 也能读）。词库原文只存在这台浏览器里，不联网、不额外调 API，
          也不认识任何特定模型或工作流。</div>
      </div>
    </details>

    <details id="cig-settings">
      <summary>设置</summary>
      <div class="cig-set">
        <label class="cig-label" for="cig-theme">界面主题</label>
        <select id="cig-theme">
          <option value="st">跟随酒馆主题</option>
          <option value="black">纯黑</option>
          <option value="gray">深灰</option>
          <option value="light">浅灰</option>
          <option value="white">纯白</option>
          <option value="sepia">米色（护眼）</option>
        </select>

        <label class="cig-label" for="cig-quality">质量前缀</label>
        <input id="cig-quality" type="text" />
        <div class="cig-hint">提示词开头的质量词（masterpiece 之类）请在酒馆自己的
          Image Generation → Common Prompt Prefix 里设置，插件会自动沿用，不用在这里填。</div>

        <label class="cig-check"><input id="cig-charseed" type="checkbox" /> 按角色固定 seed（<span id="cig-seedval">—</span>）</label>
        <div class="cig-row">
          <label class="cig-check"><input id="cig-seedfix" type="checkbox" /> 固定种子</label>
          <input id="cig-seed-input" type="number" min="0" step="1" placeholder="0" />
          <button id="cig-seed-dice" class="cig-btn" title="随机生成一个种子">🎲 随机</button>
          <button id="cig-seed-last" class="cig-btn" title="用上次出图实际使用的种子">用上次</button>
        </div>
        <div id="cig-seed-hint" class="cig-hint"></div>
        <label class="cig-check"><input id="cig-usellm" type="checkbox" /> 用 LLM 把输入改写成生图语法</label>

        <label class="cig-label" for="cig-lockworkflow">锁定形象：工作流文件名</label>
        <input id="cig-lockworkflow" type="text" />
        <label class="cig-label" for="cig-freeworkflow">自由构图：工作流文件名</label>
        <input id="cig-freeworkflow" type="text" />

        <div class="cig-sub">LoRA（可选，画风 / 角色 LoRA）</div>
        <label class="cig-check"><input id="cig-lora-on" type="checkbox" /> 启用 LoRA<span class="cig-hint">（自动生图、绘图区、图生图都生效；关掉就换回不带 LoRA 的工作流）</span></label>
        <label class="cig-label" for="cig-lora-name">LoRA 文件名</label>
        <input id="cig-lora-name" type="text" list="cig-lora-list" placeholder="xxx.safetensors" />
        <datalist id="cig-lora-list"></datalist>
        <button id="cig-lora-scan" class="cig-btn cig-wide">从 ComfyUI 读取 LoRA 列表</button>
        <label class="cig-label" for="cig-lora-weight">LoRA 强度 <span id="cig-lora-weight-val"></span></label>
        <input id="cig-lora-weight" type="range" min="0" max="1.5" step="0.05" />
        <label class="cig-label" for="cig-lora-workflow">LoRA 工作流：文生图</label>
        <input id="cig-lora-workflow" type="text" />
        <label class="cig-label" for="cig-lora-i2i-workflow">LoRA 工作流：图生图</label>
        <input id="cig-lora-i2i-workflow" type="text" />
        <div class="cig-hint" id="cig-lora-state"></div>

        <label class="cig-label" for="cig-groupth">归类宽容度 <span id="cig-groupth-val"></span><span class="cig-hint">（只在两边都没写主体衣物时生效）</span></label>
        <input id="cig-groupth" type="range" min="0.25" max="0.8" step="0.05" />
        <div class="cig-hint">归类现在**按主件**判断：同一件主件才会并成差分；这个数值只管「两边都没写清是什么衣服」时的兜底。改完点「自动整理服装分类」重新归类。</div>

        <label class="cig-label" for="cig-denoise">锁定形象的 denoise <span id="cig-denoise-val"></span></label>
        <input id="cig-denoise" type="range" min="0.3" max="0.95" step="0.05" />

        <label class="cig-label" for="cig-img2img-workflow">图生图：工作流文件名</label>
        <input id="cig-img2img-workflow" type="text" />
        <label class="cig-label" for="cig-img2img-root">图生图：酒馆 user/files 的绝对路径<span class="cig-hint">（ComfyUI 要按绝对路径读上传的图；该工作流需要 VideoHelperSuite）</span></label>
        <input id="cig-img2img-root" type="text" placeholder="例：D:/SillyTavern/data/default-user/user/files" />

        <div class="cig-sub">裸体与扶她（提示词层）</div>
        <label class="cig-check"><input id="cig-nude-default" type="checkbox" /> 服装未知（含「跟随剧情」）时默认裸体<span class="cig-hint">（未成年角色一律不裸，兜底 casual clothes）</span></label>
        <label class="cig-label" for="cig-futa-anatomy">扶她解剖 tag<span class="cig-hint">（只有 NSFW 场景、且画面里有扶她时才加，写进本人的分句里）</span></label>
        <input id="cig-futa-anatomy" type="text" placeholder="penis, testicles" />
        <label class="cig-label" for="cig-futa-neg">扶她负面词<span class="cig-hint">（只在 NSFW + 有扶她时追加到酒馆的负面提示词，其他时候自动还原）</span></label>
        <input id="cig-futa-neg" type="text" />
        <label class="cig-check"><input id="cig-futa-own" type="checkbox" /> 多人画面写明「谁有 / 其他人是女性」<span class="cig-hint">（治特征糊到别人身上）</span></label>
        <div class="cig-hint" id="cig-minor-note"></div>

        <label class="cig-label" for="cig-template">改写模板（高级）</label>
        <textarea id="cig-template" rows="6"></textarea>
        <button id="cig-reset-template" class="cig-btn cig-wide">恢复默认模板</button>
      </div>
    </details>

    <div id="cig-resize" title="拖动改变窗口大小（会记住）"></div>
    <div id="cig-status"></div>
  </div>
</div>`;
    document.body.appendChild(root);

    const $panel = $('#cig-panel');
    const $status = $('#cig-status');
    const FOLLOW = '__follow__';

    function setStatus(msg, kind = '') {
        $status.text(msg || '').attr('class', kind);
    }

    // 用 DOM 构造 option：innerHTML 不转义双引号，角色名里一旦出现 " 会撑破 value 属性
    function fillSelect($sel, entries, current) {
        $sel.empty();
        for (const [val, label] of entries) {
            $sel.append($('<option>').val(val).text(label));
        }
        $sel.val(current);
    }

    function renderCast() {
        const name = resolvedName();
        const card = currentChar().name;
        const current = (s.activeChar && subjectExists(s.activeChar)) ? s.activeChar : FOLLOW;

        // 按来源角色卡分组，不同卡的角色分开列
        const groups = new Map();
        for (const [n, v] of Object.entries(s.characters)) {
            const src = String(v?.source || '').trim() || '未分类';
            if (!groups.has(src)) groups.set(src, []);
            groups.get(src).push(n);
        }
        const byName = (a, b) => a.localeCompare(b, 'zh');
        const labels = [...groups.keys()].sort((a, b) => {
            if (a === card) return -1;   // 当前卡的排最前
            if (b === card) return 1;
            if (a === '未分类') return 1;
            if (b === '未分类') return -1;
            return byName(a, b);
        });

        const $sel = $('#cig-char-select');
        $sel.empty();
        $sel.append($('<option>').val(FOLLOW).text(`跟随当前角色卡${card ? '（' + card + '）' : ''}`));
        // 玩家主角单独一栏，和角色卡的 NPC 分开
        const $me = $('<optgroup>').attr('label', '玩家主角');
        $me.append($('<option>').val(PLAYER).text(`🧍 ${playerLabel()}（我）`));
        $sel.append($me);
        for (const label of labels) {
            const items = groups.get(label).slice().sort(byName);
            const $g = $('<optgroup>').attr('label', `${label}（${items.length}）`);
            for (const n of items) $g.append($('<option>').val(n).text(n));
            $sel.append($g);
        }
        $sel.val(current);

        $('#cig-identity').val(identityOf(name));
        $('#cig-identity').prop('disabled', !name);
        $('#cig-cast-delete').prop('disabled', !s.characters[name]);
        $('#cig-seedval').text(s.useCharSeed ? String(seedFor(name)) : '关闭');
        try { renderSeedHint(); } catch { /* 面板没渲染好就算了 */ }

        if (isPlayer(name)) {
            $('#cig-cast-owner').text(`🧍 「${playerLabel()}」是玩家主角（persona），存在独立的玩家窗口里`);
        } else {
            const src = s.characters[name]?.source;
            $('#cig-cast-owner').text(name
                ? `「${name}」来自角色卡：${src || '未分类'}`
                : '当前没有选中角色');
        }

        // 换角色 / 改身份后，外观锁要立刻重新注入
        applyInjection();
    }

    // ---------------- 玩家主角（独立窗口） ----------------
    function renderPlayer() {
        const p = subjectEntry(PLAYER) || { identity: '', outfit: '' };
        $('#cig-player-name').text(playerLabel());
        $('#cig-player-identity').val(p.identity || '');
        const worn = p.outfit && s.outfits[p.outfit] ? p.outfit : '';
        $('#cig-player-outfit').text(worn ? `当前穿着：${worn}` : '当前穿着：（未设置）');
        const $sel = $('#cig-player-outfit-select');
        fillSelect($sel, outfitOptions(), worn);
    }

    /** 服装下拉的公共选项（含分类 optgroup 语义，这里给 fillSelect 用扁平列表 + 缩进）。 */
    function outfitOptions() {
        const entries = [['', '跟随剧情（不锁定服装）']];
        const groups = new Map();
        for (const [k, v] of Object.entries(s.outfits)) {
            const base = outfitBaseOf(k, v);
            if (!groups.has(base)) groups.set(base, []);
            groups.get(base).push(k);
        }
        const byName = (a, b) => a.localeCompare(b, 'zh');
        for (const label of [...groups.keys()].sort(byName)) {
            for (const k of groups.get(label).slice().sort(byName)) {
                entries.push([k, k === label ? `${label}` : `${label} └ ${k}`]);
            }
        }
        return entries;
    }

    // ---------------- 一键换装出图 ----------------
    function renderQuick() {
        const card = currentChar().name;
        fillSelect($('#cig-quick-char'), [
            [FOLLOW, `跟随当前角色卡${card ? '（' + card + '）' : ''}`],
            [PLAYER, `🧍 ${playerLabel()}（我）`],
            ...Object.keys(s.characters).map(n => [n, s.characters[n]?.source ? `${n}（${s.characters[n].source}）` : n]),
        ], s.activeChar && subjectExists(s.activeChar) ? s.activeChar : FOLLOW);
        fillSelect($('#cig-quick-outfit'), outfitOptions(), s.currentOutfit || '');
    }

    function renderOutfit() {
        const $sel = $('#cig-outfit-select');
        const current = s.outfits[s.currentOutfit] !== undefined ? s.currentOutfit : '';
        $sel.empty();
        $sel.append($('<option>').val('').text('跟随剧情（不锁定服装）'));

        // 按分类（base）分组：相近的服装归到同一个 optgroup
        const groups = new Map();
        for (const [k, v] of Object.entries(s.outfits)) {
            const base = outfitBaseOf(k, v);
            if (!groups.has(base)) groups.set(base, []);
            groups.get(base).push(k);
        }
        const byName = (a, b) => a.localeCompare(b, 'zh');
        for (const label of [...groups.keys()].sort(byName)) {
            const items = groups.get(label).slice().sort(byName);
            const $g = $('<optgroup>').attr('label', items.length > 1 ? `${label}（${items.length} 套）` : label);
            for (const k of items) $g.append($('<option>').val(k).text(k === label ? k : `　└ ${k}`));
            $sel.append($g);
        }
        $sel.val(current);

        // 「归到哪套衣服」下拉（自建时分差分用）
        const $base = $('#cig-outfit-base');
        if ($base.length) {
            const keep = String($base.val() || '');
            $base.empty();
            $base.append($('<option>').val('').text('归到哪套衣服：自动判断（推荐）'));
            for (const label of [...groups.keys()].sort(byName)) {
                $base.append($('<option>').val(label).text('归到「' + label + '」当差分'));
            }
            if (keep && $base.find('option[value="' + keep + '"]').length) $base.val(keep);
        }

        $('#cig-outfit').val(outfitTags()).prop('disabled', !s.currentOutfit);
        $('#cig-outfit-delete').prop('disabled', !s.currentOutfit);
        $('#cig-outfit-save').prop('disabled', !String($('#cig-outfit-name').val() || '').trim());

        // 显示当前角色穿的是哪一套
        const me = resolvedName();
        const worn = wornOutfitOf(me);
        $('#cig-outfit-owner').text(
            me ? `${isPlayer(me) ? '🧍 ' : ''}「${isPlayer(me) ? playerLabel() : me}」当前穿着：${worn && s.outfits[worn] ? worn : '（未知）'}`
               : '当前没有选中角色',
        );
        renderLook();
        renderPlayer();
        renderQuick();
        renderCastPick();
        renderLexCheck();
    }

    /** 把真正会被拼进生图提示词的外观锁显示出来，方便确认有没有生效。 */
    function renderLook() {
        const look = buildLookBlock(recentSceneText(2));
        $('#cig-look-preview').text(look || '（未拼入：锁定形象模式，或该角色还没有身份/服装存档）');
    }

    /**
     * 出镜人物列表。
     * 上面一行显示自动识别结果（正文点到名的人 + 玩家），下面是可以强制指定的勾选框 ——
     * 一个都不勾就是全自动。
     */
    function renderCastPick() {
        const $box = $('#cig-cast-pick').empty();
        const $auto = $('#cig-cast-auto').empty();
        const manual = castOverrideOf();
        const auto = autoCastFromText();
        if (S().autoAddPlayer !== false && !auto.includes(PLAYER) && playerLikelyInFrame()) auto.push(PLAYER);
        const arranged = arrangePlayerCenter(auto, PLAYER);

        if (manual.length) {
            $auto.append($('<span></span>').text('手动指定：' + manual.map(n => displayNameOf(n)).join('、')));
        } else if (arranged.length) {
            $auto.append($('<span></span>').text(`自动识别（${arranged.length} 人）：` + arranged.map(n => displayNameOf(n)).join('、')));
        } else {
            $auto.append($('<span></span>').text('自动识别：正文里暂时没认出人 —— 会用模型登记的名单。'));
        }

        const names = [];
        if (subjectExists(PLAYER)) names.push(PLAYER);
        for (const n of Object.keys(s.characters)) names.push(n);
        if (!names.length) {
            $box.append($('<div class="cig-hint"></div>').text('还没有任何角色存档'));
            return;
        }
        for (const n of names) {
            const $c = $('<input type="checkbox" />').prop('checked', manual.includes(n));
            $c.on('change', function () {
                const set = new Set(castOverrideOf());
                if (this.checked) set.add(n); else set.delete(n);
                setCastOverride(names.filter(x => set.has(x)));
                renderLook();
                renderCastPick();
                const now = castOverrideOf();
                setStatus(now.length
                    ? `已改成手动指定：${now.map(x => displayNameOf(x)).join('、')}`
                    : '已改回自动识别', 'cig-ok');
            });
            const $l = $('<label class="cig-check cig-pick-item"></label>');
            $l.append($c).append(document.createTextNode(' ' + (isPlayer(n) ? `🧍 ${displayNameOf(n)}` : n)));
            if (!identityOf(n)) $l.attr('title', '这个角色还没有外观存档，画出来长相会很随机');
            $box.append($l);
        }
    }

    function refreshChar() {
        const c = currentChar();
        $('#cig-charname').text(c.name || '（未选中角色卡）');
        renderCast();
        try { renderMinorNote(); } catch { /* 面板还没建好就算了 */ }
    }

    // ---- 控件初值
    $('#cig-input').val(s.lastInput || '');
    $('#cig-theme').val(s.theme || 'st');
    applyTheme();
    $('#cig-quality').val(s.quality);
    $('#cig-mode').val(s.mode);
    $('#cig-charseed').prop('checked', !!s.useCharSeed);
    $('#cig-seedfix').prop('checked', !!s.seedFixed);
    $('#cig-seed-input').val(s.seedValue);
    $('#cig-usellm').prop('checked', !!s.useLlm);
    $('#cig-autoreg').prop('checked', !!s.autoRegister);
    $('#cig-autofollow').prop('checked', !!s.autoFollow);
    $('#cig-multichar').prop('checked', s.multiChar !== false);
    $('#cig-lex-inject').prop('checked', s.lexInject !== false);
    $('#cig-lex-chat').prop('checked', s.lexFromChat !== false);
    $('#cig-lex-norm').prop('checked', s.lexNormalize !== false);
    $('#cig-lex-hook').prop('checked', s.lexHookNormalize !== false);
    $('#cig-strip-nudity').prop('checked', s.stripNudityInSfw !== false);
    $('#cig-size-mode').val(s.sizeMode || 'auto');
    $('#cig-size-w').val(s.fixedWidth);
    $('#cig-size-h').val(s.fixedHeight);
    $('#cig-size-mp').val(s.maxMegapixels);
    $('#cig-size-mp-val').text(Number(s.maxMegapixels || 1.5).toFixed(1));
    $('#cig-size-strip').prop('checked', s.sizeStripTag !== false);
    $('#cig-free-prompt').val(s.freePrompt || '');
    $('#cig-free-norm').prop('checked', s.freeNorm !== false);
    $('#cig-free-denoise').val(s.img2imgDenoise);
    $('#cig-free-denoise-val').text(Number(s.img2imgDenoise || 0.6).toFixed(2));
    $('#cig-img2img-workflow').val(s.img2imgWorkflow);
    $('#cig-img2img-root').val(s.img2imgRoot);
    renderFreeRef();
    $('#cig-auto-player').prop('checked', s.autoAddPlayer !== false);
    $('#cig-injectpos').val(s.injectPos);
    $('#cig-lockworkflow').val(s.lockWorkflow);
    $('#cig-freeworkflow').val(s.freeWorkflow);
    $('#cig-lora-on').prop('checked', !!s.loraEnabled);
    $('#cig-lora-name').val(s.loraName);
    $('#cig-lora-weight').val(s.loraWeight);
    $('#cig-lora-weight-val').text(Number(s.loraWeight || 0).toFixed(2));
    $('#cig-lora-workflow').val(s.loraWorkflow);
    $('#cig-lora-i2i-workflow').val(s.loraImg2imgWorkflow);
    renderLoraState();
    $('#cig-nude-default').prop('checked', s.nudeAsDefault !== false);
    $('#cig-futa-anatomy').val(s.futaAnatomy);
    $('#cig-futa-neg').val(s.futaNegatives);
    $('#cig-futa-own').prop('checked', s.futaOwnership !== false);
    renderMinorNote();
    $('#cig-denoise').val(s.denoise);
    $('#cig-denoise-val').text(Number(s.denoise).toFixed(2));
    $('#cig-groupth').val(s.groupThreshold);
    $('#cig-groupth-val').text(Number(s.groupThreshold).toFixed(2));
    $('#cig-template').val(s.template);
    // 镜头预设下拉
    fillSelect($('#cig-quick-shot'),
        SHOT_PRESETS.map(([k, label]) => [k, label]), 'bust');
    refreshChar();
    renderOutfit();

    // ---------------- 玩家主角 ----------------
    $('#cig-auto-player').on('change', function () {
        s.autoAddPlayer = !!this.checked;
        save();
        renderLook();
        setStatus(this.checked
            ? '正文提到玩家名字时，会把 {{user}} 也算进画面'
            : '不再自动补 {{user}} —— 只剩手动勾选和模型自己登记两条路', 'cig-ok');
    });
    $('#cig-player-identity').on('input', function () {
        subjectEntry(PLAYER).identity = String(this.value);
        save();
        if (isPlayer(resolvedName())) renderCast();
        renderLook();
    });
    $('#cig-player-outfit-select').on('change', function () {
        const v = String(this.value);
        subjectEntry(PLAYER).outfit = v;
        if (isPlayer(resolvedName())) s.currentOutfit = v;
        save();
        renderOutfit();
    });
    $('#cig-player-apply').on('click', () => {
        s.activeChar = PLAYER;
        const worn = wornOutfitOf(PLAYER);
        if (worn && s.outfits[worn]) s.currentOutfit = worn;
        save();
        renderCast();
        renderOutfit();
        setStatus(`已把「${playerLabel()}」设为当前画面主体`, 'cig-ok');
    });
    $('#cig-player-clear').on('click', () => {
        subjectEntry(PLAYER).identity = '';
        $('#cig-player-identity').val('');
        save();
        renderLook();
        setStatus('已清空玩家主角外观', 'cig-ok');
    });
    $('#cig-player-extract').on('click', () => withBusy(async () => {
        let desc = '';
        try {
            const ctx = getContext();
            desc = String(ctx?.power_user?.persona_description || '').trim();
            if (!desc) {
                const p = ctx?.personas?.[ctx?.user_avatar];
                desc = String(p?.description || '').trim();
            }
        } catch { /* 读不到就算了 */ }
        if (!desc) throw new Error('酒馆里没有 persona 描述可以提取；请在 User Settings → Persona 里填好描述，或手动填写');
        setStatus('正在从 persona 提取外观…（会请求一次模型）');
        const quietPrompt = substituteParams(PLAYER_TEMPLATE.split('{{desc}}').join(desc));
        const out = tidyPrompt(await generateQuietPrompt({ quietPrompt }));
        if (!out) throw new Error('提取结果为空，请手动填写');
        subjectEntry(PLAYER).identity = out;
        $('#cig-player-identity').val(out);
        save();
        if (isPlayer(resolvedName())) renderCast();
        renderLook();
        setStatus('玩家主角外观已更新', 'cig-ok');
    }));

    // ---------------- 一键换装出图 ----------------
    function quickScene() {
        const preset = SHOT_PRESETS.find(p => p[0] === String($('#cig-quick-shot').val()));
        const extra = tidyPrompt($('#cig-quick-extra').val() || '');
        return tidyPrompt([preset ? preset[2] : '', extra].filter(Boolean).join(', '));
    }
    $('#cig-quick-char').on('change', function () {
        const v = String(this.value);
        s.activeChar = v === FOLLOW ? '' : v;
        const worn = wornOutfitOf(resolvedName());
        if (worn && s.outfits[worn]) s.currentOutfit = worn;
        save();
        renderCast();
        renderOutfit();
    });
    $('#cig-quick-outfit').on('change', function () {
        s.currentOutfit = String(this.value);
        const me = resolvedName();
        if (me && subjectEntry(me)) subjectEntry(me).outfit = s.currentOutfit;
        save();
        renderOutfit();
    });
    $('#cig-quick-shot').on('change', () => {
        const preset = SHOT_PRESETS.find(p => p[0] === String($('#cig-quick-shot').val()));
        if (preset) setStatus(`镜头：${preset[1]} — ${preset[2]}`);
    });
    $('#cig-quick-preview').on('click', () => withBusy(async () => {
        const body = quickScene();
        if (!body) throw new Error('先选一个镜头，或写点补充描述');
        $('#cig-preview').val(assemblePrompt(body));
        setStatus('已填入上面的「场景描述」，可以直接改再生成', 'cig-ok');
    }));
    $('#cig-quick-go').on('click', () => withBusy(async () => {
        const me = resolvedName();
        if (!identityOf(me)) {
            setStatus(`提示：「${isPlayer(me) ? playerLabel() : me || '未选中'}」还没有外观存档，出来长相会很随机`);
        }
        const body = quickScene();
        if (!body) throw new Error('先选一个镜头，或写点补充描述');
        $('#cig-preview').val(assemblePrompt(body));
        setStatus('正在出图…（首次加载模型会慢一些）');
        await generate($('#cig-preview').val());
        setStatus('出图完成 ✅', 'cig-ok');
    }));

    // ---------------- 词库 ----------------
    function renderLexStat(extra = '') {
        const st = lex().stats();
        const src = st.sources.length ? `　来源：${st.sources.join('、')}` : '';
        const head = lexIsReal()
            ? `已加载 ${st.tags} 个 tag / 中文 ${st.zh} 条 / ${st.groups} 个一级分类`
            : '还没加载真实词库（现在用的是内置兜底词）—— 导入下面的文件后效果才出得来';
        $('#cig-lex-stat').text(head + src + (extra ? `　${extra}` : ''));
    }

    function lexInsertTag(tag) {
        const cur = tidyPrompt($('#cig-preview').val() || '');
        $('#cig-preview').val(tidyPrompt([cur, tag].filter(Boolean).join(', ')));
        setStatus(`已追加「${tag}」到场景描述`, 'cig-ok');
    }

    function renderLexResults(entries, empty = '没有匹配的词') {
        const $box = $('#cig-lex-results').empty();
        if (!entries.length) {
            $box.append($('<div class="cig-hint"></div>').text(empty));
            return;
        }
        for (const e of entries) {
            const $it = $('<div class="cig-lex-item"></div>');
            if (e.zh) $it.append($('<b></b>').text(e.zh));
            $it.append($('<span></span>').text(e.k));
            if (e.top) $it.append($('<i></i>').text(e.sub ? `${e.top}·${e.sub}` : e.top));
            $it.attr('title', `点击追加到「场景描述」：${e.k}`);
            $it.on('click', () => lexInsertTag(e.k));
            $box.append($it);
        }
    }

    function renderLexBrowse() {
        const top = String($('#cig-lex-cat').val() || '');
        const sub = String($('#cig-lex-sub').val() || '');
        const q = String($('#cig-lex-search').val() || '').trim();
        if (q) {
            renderLexResults(lex().search(q, { limit: 40, top, sub }), `词库里没有匹配「${q}」的词`);
            return;
        }
        if (!top) {
            renderLexResults([], '上面搜一个词，或选个分类翻一翻');
            return;
        }
        renderLexResults(lex().browse(top, sub), '这个分类下没有词');
    }

    function renderLexCats() {
        const cats = lex().categories();
        fillSelect($('#cig-lex-cat'),
            [['', '全部分类'], ...cats.map(c => [c.name, `${c.name}（${c.count}）`])],
            String($('#cig-lex-cat').val() || ''));
        renderLexSubs();
    }

    function renderLexSubs() {
        const top = String($('#cig-lex-cat').val() || '');
        const cat = lex().categories().find(c => c.name === top);
        fillSelect($('#cig-lex-sub'),
            [['', '全部子分类'], ...(cat ? cat.subs.map(x => [x.name, `${x.name}（${x.count}）`]) : [])],
            '');
    }

    /** 身份 / 服装里词库查不到的 tag —— 只提示，不擅自改。 */
    function renderLexCheck() {
        const $box = $('#cig-lex-check');
        if (!lexIsReal()) { $box.text(''); return; }
        const fields = [
            ['角色身份', $('#cig-identity').val()],
            ['服装', $('#cig-outfit').val()],
            ['玩家主角', $('#cig-player-identity').val()],
        ];
        const bits = [];
        for (const [label, text] of fields) {
            const un = lexUnknown(text || '');
            if (un.length) {
                bits.push(`${label}：${un.slice(0, 6).join(', ')}${un.length > 6 ? ` 等 ${un.length} 个` : ''}`);
            }
        }
        $box.text(bits.length ? `⚠ 词库查不到的 tag → ${bits.join('；')}` : '').toggleClass('cig-warn', !!bits.length);
    }

    function lexLoadInto(fn) {
        return withBusy(async () => {
            setStatus('正在解析词库…（大文件第一次会慢一点）');
            const r = await fn();
            renderLexCats();
            renderLexBrowse();
            renderLexStat();
            renderLexCheck();
            if (!r.added) {
                setStatus('没找到可加载的词库文件 —— 用「导入词库文件」直接选 SD-WebUI 里的 csv / yaml', 'cig-err');
            } else {
                setStatus(`已加载 ${r.added} 个词库文件`, 'cig-ok');
            }
        });
    }

    $('#cig-lex-import').on('click', () => $('#cig-lex-file').trigger('click'));
    $('#cig-lex-file').on('change', function () {
        const files = this.files;
        const $input = $(this);
        lexLoadInto(async () => {
            const r = await lexImport(files);
            $input.val('');
            return r;
        });
    });
    $('#cig-lex-auto').on('click', () => lexLoadInto(() => lexAutoLoad()));
    $('#cig-lex-clear').on('click', () => withBusy(async () => {
        await lexClear();
        renderLexCats();
        renderLexBrowse();
        renderLexStat();
        renderLexCheck();
        setStatus('词库已清空，现在只剩内置兜底词', 'cig-ok');
    }));

    let lexSearchTimer = null;
    $('#cig-lex-search').on('input', () => {
        clearTimeout(lexSearchTimer);
        lexSearchTimer = setTimeout(renderLexBrowse, 180);
    });
    $('#cig-lex-cat').on('change', () => { renderLexSubs(); renderLexBrowse(); });
    $('#cig-lex-sub').on('change', renderLexBrowse);

    $('#cig-lex-random').on('click', () => {
        const cat = lex().categories().find(c => c.name === '表情动作');
        const sub = cat?.subs.find(x => /动作/.test(x.name))?.name || cat?.subs[0]?.name || '';
        const tags = lex().randomFrom('表情动作', sub, 3);
        if (!tags.length) {
            setStatus('词库里没有动作词 —— 先导入 SD-WebUI 的词库文件', 'cig-err');
            return;
        }
        lexInsertTag(tags.join(', '));
        setStatus(`随机动作：${tags.join(', ')}`, 'cig-ok');
    });

    $('#cig-lex-inject').on('change', function () { s.lexInject = !!this.checked; save(); });
    $('#cig-lex-chat').on('change', function () { s.lexFromChat = !!this.checked; save(); });
    $('#cig-lex-norm').on('change', function () { s.lexNormalize = !!this.checked; save(); });
    $('#cig-lex-hook').on('change', function () { s.lexHookNormalize = !!this.checked; save(); });
    $('#cig-strip-nudity').on('change', function () {
        s.stripNudityInSfw = !!this.checked;
        save();
        renderLook();
        setStatus(this.checked
            ? '非 NSFW 剧情会自动剥掉服装里的裸露状态'
            : '服装库原样套用（裸露状态会跟到每一张图）', 'cig-ok');
    });
    // 手填身份 / 服装时顺手体检：查不到的 tag 报出来（只提示，不动内容）
    $('#cig-identity, #cig-outfit, #cig-player-identity').on('input', renderLexCheck);

    // ---------------- 尺寸 ----------------
    $('#cig-size-mode').on('change', function () {
        s.sizeMode = String(this.value);
        save();
        setStatus(s.sizeMode === 'auto' ? '尺寸：自动跟提示词里的画幅'
            : s.sizeMode === 'fixed' ? `尺寸：固定 ${s.fixedWidth}×${s.fixedHeight}`
                : '尺寸：不动酒馆的宽高设置', 'cig-ok');
    });
    $('#cig-size-w').on('input', function () { s.fixedWidth = Number(this.value) || s.fixedWidth; save(); });
    $('#cig-size-h').on('input', function () { s.fixedHeight = Number(this.value) || s.fixedHeight; save(); });
    const sizePreset = (w, h) => {
        s.fixedWidth = w;
        s.fixedHeight = h;
        s.sizeMode = 'fixed';
        $('#cig-size-w').val(w);
        $('#cig-size-h').val(h);
        $('#cig-size-mode').val('fixed');
        save();
        setStatus(`尺寸已设为固定 ${w}×${h}`, 'cig-ok');
    };
    $('#cig-size-preset-v').on('click', () => sizePreset(832, 1216));
    $('#cig-size-preset-h').on('click', () => sizePreset(1216, 832));
    $('#cig-size-preset-s').on('click', () => sizePreset(1024, 1024));
    $('#cig-size-mp').on('input', function () {
        s.maxMegapixels = Number(this.value);
        $('#cig-size-mp-val').text(s.maxMegapixels.toFixed(1));
        save();
    });
    $('#cig-size-strip').on('change', function () { s.sizeStripTag = !!this.checked; save(); });

    // ---------------- 绘图区（纯提示词，与角色无关） ----------------
    function freePromptText() {
        const raw = String($('#cig-free-prompt').val() || '').trim();
        if (!raw) throw new Error('先写点提示词');
        return s.freeNorm === false ? raw : lexClean(raw, { dedupe: true });
    }
    $('#cig-free-prompt').on('input', function () { s.freePrompt = String(this.value); save(); });
    $('#cig-free-norm').on('change', function () { s.freeNorm = !!this.checked; save(); });
    $('#cig-free-clean').on('click', () => withBusy(async () => {
        const raw = String($('#cig-free-prompt').val() || '').trim();
        if (!raw) throw new Error('先写点提示词');
        const out = lexClean(raw, { dedupe: true });
        $('#cig-free-prompt').val(out);
        s.freePrompt = out;
        save();
        $('#cig-free-log').text('本地规范化 → ' + out);
        setStatus('已用词库把中文/别名规范化（纯本地，没调模型）', 'cig-ok');
    }));

    function renderFreeRef() {
        const path = String(s.freeRef || '');
        const name = String(s.freeRefName || '');
        const abs = freeRefAbsPath();
        if (path) {
            $('#cig-free-ref-info').text(`参考图：${name}` + (abs ? '' : '　⚠ 还没填「user/files 绝对路径」，图生图会失败（见下面的设置）'));
            $('#cig-free-ref-preview').attr('src', path).show();
        } else {
            $('#cig-free-ref-info').text('没选参考图 → 这次是纯文生图');
            $('#cig-free-ref-preview').attr('src', '').hide();
        }
    }

    $('#cig-free-ref-pick').on('click', () => $('#cig-free-ref-file').trigger('click'));
    $('#cig-free-ref-file').on('change', function () {
        const file = this.files && this.files[0];
        const $input = $(this);
        if (!file) return;
        withBusy(async () => {
            setStatus('正在上传参考图…');
            const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result || ''));
                fr.onerror = () => reject(new Error('读取图片失败'));
                fr.readAsDataURL(file);
            });
            const b64 = dataUrl.split(',')[1] || '';
            if (!b64) throw new Error('图片内容为空');
            const ext = (String(file.name).match(/\.(png|jpe?g|webp|bmp)$/i) || ['.png'])[0].toLowerCase();
            const name = `cig_ref_${Date.now()}${ext}`;
            // 存到酒馆自己的 user/files（同源，不会被 CORS 挡）；绝对路径由设置拼出来给 ComfyUI
            const res = await fetch('/api/files/upload', {
                method: 'POST',
                headers: getContext().getRequestHeaders(),
                body: JSON.stringify({ name, data: b64 }),
            });
            if (!res.ok) throw new Error(`上传失败（${res.status}）：${(await res.text()).slice(0, 120)}`);
            const j = await res.json();
            s.freeRef = String(j.path || '');
            s.freeRefName = name;
            save();
            $input.val('');
            renderFreeRef();
            setStatus(`参考图已就绪：${name}（重绘幅度 ${Number(s.img2imgDenoise).toFixed(2)}）`, 'cig-ok');
        });
    });
    $('#cig-free-ref-clear').on('click', () => {
        s.freeRef = '';
        s.freeRefName = '';
        save();
        renderFreeRef();
        setStatus('已清除参考图 → 回到纯文生图', 'cig-ok');
    });
    $('#cig-free-denoise').on('input', function () {
        s.img2imgDenoise = Number(this.value);
        $('#cig-free-denoise-val').text(s.img2imgDenoise.toFixed(2));
        save();
    });
    $('#cig-img2img-workflow').on('input', function () { s.img2imgWorkflow = String(this.value).trim(); save(); });
    $('#cig-img2img-root').on('input', function () {
        s.img2imgRoot = String(this.value).trim();
        save();
        renderFreeRef();
    });

    // ---- LoRA（开关 = 换工作流；文件名/强度 = 换占位符）
    function loraLabel() {
        return `${s.loraName || '（没填文件名）'} @ ${Number(s.loraWeight || 0).toFixed(2)}`;
    }

    function renderLoraState() {
        const cur = String(extension_settings?.sd?.comfy_workflow || '');
        const mine = [s.loraWorkflow, s.loraImg2imgWorkflow].filter(Boolean);
        const parts = [s.loraEnabled ? `LoRA：开 → ${loraLabel()}` : 'LoRA：关（用不带 LoRA 的工作流）'];
        parts.push(`酒馆当前工作流：${cur || '（空）'}`);
        if (s.loraEnabled && cur && !mine.includes(cur)) {
            parts.push('⚠ 当前工作流不是带 LoRA 的那份 —— 把开关关掉再打开就能切过去');
        }
        $('#cig-lora-state').text(parts.join('　|　'));
    }

    $('#cig-lora-on').on('change', function () {
        s.loraEnabled = !!this.checked;
        applyLoraWorkflow();
        renderLoraState();
        const cur = String(extension_settings?.sd?.comfy_workflow || '');
        setStatus(s.loraEnabled
            ? `LoRA 已开启：${loraLabel()}，工作流已切到 ${cur}`
            : `LoRA 已关闭，工作流切回 ${cur}`, 'cig-ok');
    });
    $('#cig-lora-name').on('input', function () {
        s.loraName = String(this.value).trim();
        save();
        setLoraPlaceholders();
        renderLoraState();
    });
    $('#cig-lora-weight').on('input', function () {
        s.loraWeight = Number(this.value);
        $('#cig-lora-weight-val').text(s.loraWeight.toFixed(2));
        save();
        setLoraPlaceholders();
        renderLoraState();
    });
    $('#cig-lora-workflow').on('input', function () {
        s.loraWorkflow = String(this.value).trim();
        save();
        if (s.loraEnabled) applyLoraWorkflow();
        renderLoraState();
    });
    $('#cig-lora-i2i-workflow').on('input', function () {
        s.loraImg2imgWorkflow = String(this.value).trim();
        save();
        renderLoraState();
    });
    $('#cig-lora-scan').on('click', () => withBusy(async () => {
        setStatus('正在问 ComfyUI 要 LoRA 列表…');
        const list = await fetchComfyLoras();
        const dl = document.getElementById('cig-lora-list');
        if (dl) dl.innerHTML = list.map(n => `<option value="${String(n).replace(/"/g, '&quot;')}"></option>`).join('');
        setStatus(`读到 ${list.length} 个 LoRA：${list.slice(0, 6).join('、')}${list.length > 6 ? ' …' : ''}（在「LoRA 文件名」框里会变成下拉建议）`, 'cig-ok');
        renderLoraState();
    }));

    // ---- 裸体兜底 / 扶她解剖
    function renderMinorNote() {
        const blocked = [];
        const S2 = S();
        for (const n of Object.keys(s.characters || {})) {
            if (S2.characters?.[n]?.minor === true || isMinorIdentity(identityOf(n))) blocked.push(n);
        }
        const nudeName = String(s.nudeOutfitName || '裸体');
        const parts = [
            `未成年拦截（永不默认裸体，兜底 casual clothes）：${blocked.length ? blocked.join('、') : '无'}`,
            `「${nudeName}」这套衣服在「服装」下拉里，可以直接选给任何角色（tag 在服装库里随时能改）`,
        ];
        $('#cig-minor-note').text(parts.join('　|　'));
    }

    $('#cig-nude-default').on('change', function () {
        s.nudeAsDefault = !!this.checked;
        save();
        setStatus(s.nudeAsDefault
            ? '服装未知时默认裸体（未成年角色已自动拦下）'
            : '服装未知时不注入服装（老行为）', 'cig-ok');
    });
    $('#cig-futa-anatomy').on('input', function () {
        s.futaAnatomy = String(this.value).trim();
        save();
    });
    $('#cig-futa-neg').on('input', function () {
        s.futaNegatives = String(this.value).trim();
        s.userNegativePrompt = '';      // 让下一次生成重新取一份基准，免得旧副本卡住
        save();
    });
    $('#cig-futa-own').on('change', function () {
        s.futaOwnership = !!this.checked;
        save();
    });

    $('#cig-free-go').on('click', () => withBusy(async () => {
        const body = freePromptText();
        const useRef = !!s.freeRefName;
        if (useRef && !freeRefAbsPath()) {
            throw new Error('参考图存着，但「user/files 绝对路径」没填 —— 去下面的设置里补上才能图生图');
        }
        $('#cig-free-log').text((useRef
            ? `图生图（denoise ${Number(s.img2imgDenoise).toFixed(2)}，工作流 ${s.img2imgWorkflow}）`
            : '文生图') + '　实际发出：' + body);
        setStatus(useRef ? '图生图重绘中…（首次加载模型会慢一些）' : '绘图区正在出图…（首次加载模型会慢一些）');
        await generateFree(body, useRef);
        setStatus(useRef ? '图生图完成 ✅' : '出图完成 ✅', 'cig-ok');
    }));

    // ---- 持久化
    $('#cig-theme').on('change', function () {
        s.theme = String(this.value);
        save();
        applyTheme();
        setStatus('主题已切换（' + this.options[this.selectedIndex].text + '）', 'cig-ok');
    });
    $('#cig-quality').on('input', function () { s.quality = String(this.value); save(); });
    $('#cig-lockworkflow').on('input', function () { s.lockWorkflow = String(this.value).trim(); save(); });
    $('#cig-freeworkflow').on('input', function () { s.freeWorkflow = String(this.value).trim(); save(); });
    $('#cig-template').on('input', function () { s.template = String(this.value); save(); });
    $('#cig-usellm').on('change', function () { s.useLlm = !!this.checked; save(); });
    $('#cig-mode').on('change', function () { s.mode = String(this.value); save(); renderCast(); });
    $('#cig-charseed').on('change', function () { s.useCharSeed = !!this.checked; save(); renderCast(); });
    $('#cig-seedfix').on('change', function () {
        s.seedFixed = !!this.checked;
        if (s.seedFixed && !(Number(s.seedValue) >= 0)) s.seedValue = 0;
        save();
        renderSeedHint();
        setStatus(s.seedFixed ? ('已固定种子：' + s.seedValue) : '已取消固定种子（改回按角色算 / 随机）', 'cig-ok');
    });
    $('#cig-seed-input').on('input', function () {
        s.seedValue = Math.max(0, Math.floor(Number(this.value) || 0));
        save();
        renderSeedHint();
    });
    $('#cig-seed-dice').on('click', () => {
        s.seedValue = Math.floor(Math.random() * 2000000000);
        s.seedFixed = true;
        $('#cig-seedfix').prop('checked', true);
        $('#cig-seed-input').val(s.seedValue);
        save();
        renderSeedHint();
        setStatus('已随机一个种子并固定：' + s.seedValue, 'cig-ok');
    });
    $('#cig-seed-last').on('click', () => {
        if (!(s.lastSeed >= 0)) { setStatus('还没有出过图，没有「上次的种子」', 'cig-err'); return; }
        s.seedValue = s.lastSeed;
        s.seedFixed = true;
        $('#cig-seedfix').prop('checked', true);
        $('#cig-seed-input').val(s.seedValue);
        save();
        renderSeedHint();
        setStatus('已锁定上次出图的种子：' + s.seedValue, 'cig-ok');
    });
    $('#cig-autoreg').on('change', function () {
        s.autoRegister = !!this.checked;
        save();
        applyInjection();
        setStatus(s.autoRegister ? '已开启自动登记：登记指令会随每次生成一起送出去' : '已关闭自动登记', 'cig-ok');
    });
    $('#cig-autofollow').on('change', function () { s.autoFollow = !!this.checked; save(); });
    $('#cig-multichar').on('change', function () {
        s.multiChar = !!this.checked;
        save();
        renderLook();
    });
    $('#cig-injectpos').on('change', function () {
        s.injectPos = String(this.value);
        save();
        applyInjection();
        setStatus(s.injectPos === 'chat' ? '登记指令已改注入到对话末尾' : '登记指令已改注入到系统提示词', 'cig-ok');
    });
    $('#cig-denoise').on('input', function () {
        s.denoise = Number(this.value);
        $('#cig-denoise-val').text(s.denoise.toFixed(2));
        save();
    });
    $('#cig-groupth').on('input', function () {
        s.groupThreshold = Number(this.value);
        $('#cig-groupth-val').text(s.groupThreshold.toFixed(2));
        save();
    });
    $('#cig-outfit-autogroup').on('click', () => {
        const changed = autoGroupOutfits();
        renderOutfit();
        const groups = new Map();
        for (const [k, v] of Object.entries(s.outfits)) {
            const b = outfitBaseOf(k, v);
            if (!groups.has(b)) groups.set(b, []);
            groups.get(b).push(k);
        }
        const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
        const detail = multi.length
            ? multi.map(([b, v]) => `${b}(${v.length})`).join('、')
            : '没有相近的可以合并';
        setStatus(changed
            ? `归类完成，调整了 ${changed} 条。当前分类：${detail}`
            : `无需调整。当前分类：${detail}`, 'cig-ok');
    });
    $('#cig-reset-template').on('click', () => {
        s.template = DEFAULT_TEMPLATE;
        $('#cig-template').val(DEFAULT_TEMPLATE);
        save();
        setStatus('模板已恢复默认', 'cig-ok');
    });
    $('#cig-install-regex').on('click', () => {
        const n = installRegexes();
        setStatus(n ? `已安装 ${n} 条正则，登记块不会再显示在对话里` : '正则已存在，已修复配置', 'cig-ok');
    });
    $('#cig-copy-instruction').on('click', async () => {
        const text = buildInstruction();
        try {
            await navigator.clipboard.writeText(text);
            setStatus('指令已复制 —— 粘到你预设的系统提示词里即可（不用开上面的开关）', 'cig-ok');
        } catch {
            setStatus('复制失败，请手动从控制台复制', 'cig-err');
            console.log(text);
        }
    });

    // ---- 同人角色库（数据与界面都在 fanchars.js / fanpanel.js 里）
    try {
        fanPanel = mountFanPanel({
            $, S, save, setStatus, withBusy, getContext,
            refresh: () => { renderCast(); try { renderCastPick(); } catch { /* 没渲染就算了 */ } },
        });
    } catch (err) {
        console.error('[CharImageGen] 同人角色库挂载失败', err);
    }

    // ---- 画师画风面板
    try {
        mountArtistPanel({ $, S, save, setStatus, withBusy });
    } catch (err) {
        console.error('[CharImageGen] 画师画风面板挂载失败', err);
    }

    // ---- 角色 / 服装
    $('#cig-char-select').on('change', function () {
        const v = String(this.value);
        s.activeChar = v === FOLLOW ? '' : v;
        save();
        renderCast();
    });
    $('#cig-identity').on('input', function () {
        const n = resolvedName();
        if (!n) return;
        // 玩家主角存到 player 槽位，别在 characters 里建一个叫 __player__ 的假 NPC
        const ent = subjectEntry(n) || (s.characters[n] = { identity: '', source: currentChar().name, outfit: '' });
        ent.identity = String(this.value);
        save();
        renderLook();
    });
    $('#cig-cast-delete').on('click', () => {
        const n = resolvedName();
        if (!n || isPlayer(n) || !s.characters[n]) return;
        delete s.characters[n];
        if (s.activeChar === n) s.activeChar = '';
        save();
        renderCast();
        applyInjection();
        setStatus(`已删除角色「${n}」的存档`, 'cig-ok');
    });

    $('#cig-outfit-select').on('change', function () {
        s.currentOutfit = String(this.value);
        save();
        renderOutfit();
    });
    $('#cig-outfit').on('input', function () {
        if (!s.currentOutfit) return;
        const v = s.outfits[s.currentOutfit];
        const base = outfitBaseOf(s.currentOutfit, v);
        s.outfits[s.currentOutfit] = { tags: String(this.value), base };
        save();
    });
    $('#cig-outfit-name').on('input', function () {
        $('#cig-outfit-save').prop('disabled', !String(this.value).trim());
    });
    $('#cig-outfit-save').on('click', () => {
        const name = String($('#cig-outfit-name').val()).trim();
        const tags = tidyPrompt($('#cig-outfit').val());
        const force = !!$('#cig-outfit-force').prop('checked');
        const basePick = String($('#cig-outfit-base').val() || '');
        const msg = (t, k) => { $('#cig-outfit-msg').text(t); setStatus(t, k || 'cig-ok'); };

        if (!name) { msg('请先填「服装名」—— 这是存进库里的名字', 'cig-err'); return; }
        if (!tags) { msg('请先填服装标签（英文 booru tag，逗号分隔）', 'cig-err'); return; }

        // ① 名字已存在 = 修改那一套（不算新建）
        if (s.outfits[name] && !force) {
            s.outfits[name] = { tags, base: basePick || outfitBaseOf(name, s.outfits[name]) };
            s.currentOutfit = name;
            save(); renderOutfit();
            msg('已更新已有服装「' + name + '」', 'cig-ok');
            return;
        }
        // ② 指定了「归到某套衣服」→ 直接做成那套的差分
        if (basePick) {
            const b = outfitBaseOf(basePick, s.outfits[basePick]);
            const nn = uniqueOutfitName(b);
            s.outfits[nn] = { tags, base: b };
            s.currentOutfit = nn;
            save(); renderOutfit();
            msg('已存入「' + nn + '」，归到「' + b + '」下当差分', 'cig-ok');
            return;
        }
        // ③ 勾了「强制新建」→ 不判相似，直接开新分类
        if (force) {
            const nn = uniqueOutfitName(name);
            s.outfits[nn] = { tags, base: nn };
            s.currentOutfit = nn;
            save(); renderOutfit();
            msg('已强制存为新分类「' + nn + '」', 'cig-ok');
            return;
        }
        // ④ 自动判定：同一套衣服的破损/换部件 → 差分；只是太像 → 不重复存
        const res = addOutfit(name, tags);
        if (!res) { msg('服装内容是空的', 'cig-err'); return; }
        s.currentOutfit = res.name;
        save(); renderOutfit();
        if (res.reused) {
            msg('和已有服装「' + res.name + '」是同一套' + (res.why ? '（' + res.why + '）' : '') + '，没有重复存 —— 真要新建就勾上面的「强制新建分类」', 'cig-ok');
        } else if (res.grouped) {
            msg('「' + res.name + '」收成了「' + res.grouped + '」的差分' + (res.why ? '（' + res.why + '）' : ''), 'cig-ok');
        } else {
            msg('已存为新分类「' + res.name + '」', 'cig-ok');
        }
    });
    $('#cig-outfit-delete').on('click', () => {
        if (!s.currentOutfit) return;
        const n = s.currentOutfit;
        delete s.outfits[n];
        s.currentOutfit = '';
        save();
        renderOutfit();
        setStatus(`已删除服装「${n}」`, 'cig-ok');
    });

    // ---- 开关 / 折叠 / 拖动
    // 启动图标：按住能拖走，松手若是「没怎么动」就当作点击开关面板
    const launcher = document.getElementById('cig-launcher');
    function clampLauncher(x, y) {
        const w = launcher.offsetWidth || 46;
        const h = launcher.offsetHeight || 46;
        return {
            x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
            y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
        };
    }
    function placeLauncher(x, y) {
        const p = clampLauncher(x, y);
        $(launcher).css({ left: p.x, top: p.y, right: 'auto', bottom: 'auto' });
        return p;
    }
    if (s.launcherPos && Number.isFinite(s.launcherPos.x) && Number.isFinite(s.launcherPos.y)) {
        placeLauncher(s.launcherPos.x, s.launcherPos.y);
    }
    let lDrag = null;
    let lJustDragged = false;
    launcher.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const r = launcher.getBoundingClientRect();
        lDrag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, sx: e.clientX, sy: e.clientY };
        try { launcher.setPointerCapture(e.pointerId); } catch { /* 退化成普通拖动 */ }
    });
    launcher.addEventListener('pointermove', (e) => {
        if (!lDrag || e.pointerId !== lDrag.id) return;
        if (!lDrag.moved && Math.abs(e.clientX - lDrag.sx) + Math.abs(e.clientY - lDrag.sy) < 4) return;
        lDrag.moved = true;
        placeLauncher(e.clientX - lDrag.dx, e.clientY - lDrag.dy);
        e.preventDefault();
    });
    function endLauncherDrag(e) {
        if (!lDrag || (e && e.pointerId !== lDrag.id)) return;
        try { launcher.releasePointerCapture(lDrag.id); } catch { /* 已释放 */ }
        const moved = lDrag.moved;
        lDrag = null;
        if (moved) {
            const r = launcher.getBoundingClientRect();
            s.launcherPos = { x: Math.round(r.left), y: Math.round(r.top) };
            save();
            lJustDragged = true;
            setTimeout(() => { lJustDragged = false; }, 250);   // 免得拖完又顺手把面板点开
        }
    }
    launcher.addEventListener('pointerup', endLauncherDrag);
    launcher.addEventListener('pointercancel', endLauncherDrag);
    launcher.addEventListener('click', () => {
        if (lJustDragged) return;
        $panel.toggleClass('cig-hidden');
    });

    function setCollapsed(flag) {
        s.collapsed = !!flag;
        $panel.toggleClass('cig-collapsed', !!flag);
        $('#cig-collapse').text(flag ? '▸' : '▾').attr('title', flag ? '展开' : '折叠');
        save();
        if (s.pos) place(s.pos.x, s.pos.y);
    }
    $('#cig-collapse').on('click', (e) => { e.stopPropagation(); setCollapsed(!s.collapsed); });
    $('#cig-header').on('dblclick', (e) => {
        if ($(e.target).is('#cig-close, #cig-collapse, #cig-fold-all')) return;
        setCollapsed(!s.collapsed);
    });
    $('#cig-close').on('click', () => $panel.addClass('cig-hidden'));

    function panelSize() {
        return { w: $panel.outerWidth() || 560, h: $panel.outerHeight() || 520 };
    }
    // 套用上次拖出来的尺寸（先夹到视口内，别一开就超出屏幕）
    if (s.panelSize && Number.isFinite(s.panelSize.w) && Number.isFinite(s.panelSize.h)) {
        const w = Math.min(Math.max(360, s.panelSize.w), Math.max(360, window.innerWidth - 24));
        const h = Math.min(Math.max(300, s.panelSize.h), Math.max(300, window.innerHeight - 30));
        $panel.css({ width: w + 'px', height: h + 'px' });
    }
    function place(x, y) {
        const { w, h } = panelSize();
        const maxX = Math.max(0, window.innerWidth - w);
        const maxY = Math.max(0, window.innerHeight - h);
        const cx = Math.min(Math.max(0, x), maxX);
        const cy = Math.min(Math.max(0, y), maxY);
        $panel.css({ left: cx, top: cy, right: 'auto', bottom: 'auto' });
        return { x: cx, y: cy };
    }

    // 右下角拖拽改大小
    const resizer = document.getElementById('cig-resize');
    let rDrag = null;
    if (resizer) {
        resizer.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const r = $panel[0].getBoundingClientRect();
            rDrag = { id: e.pointerId, w: r.width, h: r.height, sx: e.clientX, sy: e.clientY };
            try { resizer.setPointerCapture(e.pointerId); } catch { /* 退化成普通拖动 */ }
            e.preventDefault();
            e.stopPropagation();
        });
        resizer.addEventListener('pointermove', (e) => {
            if (!rDrag || e.pointerId !== rDrag.id) return;
            const w = Math.min(Math.max(360, rDrag.w + (e.clientX - rDrag.sx)), Math.max(360, window.innerWidth - 24));
            const h = Math.min(Math.max(300, rDrag.h + (e.clientY - rDrag.sy)), Math.max(300, window.innerHeight - 30));
            $panel.css({ width: w + 'px', height: h + 'px' });
            e.preventDefault();
        });
        function endResize(e) {
            if (!rDrag || (e && e.pointerId !== rDrag.id)) return;
            try { resizer.releasePointerCapture(rDrag.id); } catch { /* 已释放 */ }
            rDrag = null;
            const r = $panel[0].getBoundingClientRect();
            s.panelSize = { w: Math.round(r.width), h: Math.round(r.height) };
            save();
            // 变大后可能顶出屏幕，拉回来
            const p = place(r.left, r.top);
            s.pos = { x: p.x, y: p.y };
            save();
        }
        resizer.addEventListener('pointerup', endResize);
        resizer.addEventListener('pointercancel', endResize);
    }

    const header = document.getElementById('cig-header');
    let drag = null;
    header.addEventListener('pointerdown', (e) => {
        if (e.target instanceof Element && e.target.closest('#cig-close, #cig-collapse, #cig-fold-all')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const r = $panel[0].getBoundingClientRect();
        drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
        try { header.setPointerCapture(e.pointerId); } catch { /* 不支持就退化成普通拖动 */ }
        e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    function endDrag(e) {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        try { header.releasePointerCapture(drag.id); } catch { /* 已释放 */ }
        drag = null;
        const r = $panel[0].getBoundingClientRect();
        s.pos = { x: Math.round(r.left), y: Math.round(r.top) };
        save();
    }
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    $(window).on('resize', () => {
        if (s.launcherPos) placeLauncher(s.launcherPos.x, s.launcherPos.y);
        const r = $panel[0].getBoundingClientRect();
        place(r.left, r.top);
    });

    if (s.collapsed) {
        $panel.addClass('cig-collapsed');
        $('#cig-collapse').text('▸').attr('title', '展开');
    }
    if (s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y)) {
        place(s.pos.x, s.pos.y);
    }

    // ---- 分区折叠：每个主要条目都能单独收起，状态会记住
    const SECTIONS = [
        ['free', '#cig-free-box'],
        ['gen', '#cig-gen-box'],
        ['player', '#cig-player-box'],
        ['quick', '#cig-quick-box'],
        ['fan', '#cig-fan-box'],
        ['artist', '#cig-artist-box'],
        ['lex', '#cig-lex-box'],
        ['cast', '#cig-cast-box'],
        ['auto', '#cig-auto-box'],
        ['settings', '#cig-settings'],
    ];

    // 折叠改变了面板高度，可能把它顶出视口；只在真的越界时才挪
    function reclamp() {
        const r = $panel[0].getBoundingClientRect();
        const { w, h } = panelSize();
        if (r.left < 0 || r.top < 0 || r.left + w > window.innerWidth || r.top + h > window.innerHeight) {
            place(r.left, r.top);
        }
    }

    for (const [key, sel] of SECTIONS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        el.open = s.sections[key];
        el.addEventListener('toggle', () => {
            s.sections[key] = el.open;
            save();
            reclamp();
        });
    }

    $('#cig-fold-all').on('click', () => {
        const anyOpen = SECTIONS.some(([, sel]) => document.querySelector(sel)?.open);
        for (const [key, sel] of SECTIONS) {
            const el = document.querySelector(sel);
            if (!el) continue;
            el.open = !anyOpen;
            s.sections[key] = el.open;
        }
        save();
        setTimeout(reclamp, 0);
    });

    // ---- 从正文捕获登记块
    function handleMessage(messageId) {
        try {
            const s2 = S();
            if (!s2.autoRegister && !s2.autoFollow) return;
            const chat = getContext()?.chat;
            const msg = Array.isArray(chat) ? chat[messageId] : null;
            if (!msg || msg.is_user) return;
            const payload = parseCastBlock(msg.mes);
            if (!payload) return;
            const log = mergeCast(payload);
            const summary = mergeSummary(log);
            if (summary) {
                $('#cig-autolog').text('上次正文捕获：' + summary);
                renderCast();
                renderOutfit();
                renderLook();
                applyInjection();
                console.log('[CharImageGen] 正文登记', log);
            }
        } catch (err) {
            console.warn('[CharImageGen] 解析正文登记块失败', err);
        }
    }

    try {
        eventSource.on(event_types.CHAT_CHANGED, refreshChar);
        eventSource.on(event_types.CHARACTER_EDITED, refreshChar);
        eventSource.on(event_types.MESSAGE_RECEIVED, handleMessage);
        eventSource.on(event_types.MESSAGE_EDITED, handleMessage);
        eventSource.on(event_types.MESSAGE_SWIPED, handleMessage);
        // 外观锁：拦生图提示词，所有生图路径统一生效
        eventSource.on(event_types.SD_PROMPT_PROCESSING, (data) => {
            try {
                setLoraPlaceholders();   // LoRA 开关是全局的，每次生图顺手确认一遍占位符
            } catch (err) {
                console.warn('[CharImageGen] 写入 LoRA 占位符失败', err);
            }
            try {
                if (!data || typeof data.prompt !== 'string') return;
                const before = data.prompt;
                data.prompt = injectLookIntoPrompt(before);
                if (data.prompt !== before) {
                    console.log('[CharImageGen] 已把外观锁拼进生图提示词');
                }
            } catch (err) {
                console.warn('[CharImageGen] 拼接外观锁失败', err);
            }
        });
    } catch { /* 事件名不存在也不影响主流程 */ }

    /** 免 API 的补救：回头扫最近几条角色回复里有没有登记块。 */
    function rescan() {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat) || !chat.length) {
            setStatus('当前没有聊天记录', 'cig-err');
            return;
        }
        let scanned = 0;
        const summaries = [];
        for (let i = chat.length - 1; i >= 0 && scanned < 8; i--) {
            const m = chat[i];
            if (!m || m.is_user) continue;
            scanned++;
            let payload = null;
            try { payload = parseCastBlock(m.mes); } catch { /* 单条解析失败就算了 */ }
            if (!payload) continue;
            const summary = mergeSummary(mergeCast(payload));
            if (summary) summaries.push(summary);
        }
        renderCast();
        renderOutfit();
        renderLook();
        applyInjection();
        if (!summaries.length) {
            setStatus(`扫了最近 ${scanned} 条角色回复，都没找到登记块 —— 模型没按指令输出。`
                + '可以试试：① 注入位置改成「对话末尾」；② 把「复制指令」的内容贴进预设；'
                + '③ 点消息上的小扳手「编辑」，看回复里到底有没有 <!--cast=', 'cig-err');
        } else {
            const text = summaries.join(' / ');
            $('#cig-autolog').text('扫描入库：' + text);
            setStatus(`扫描到 ${summaries.length} 个登记块：` + text, 'cig-ok');
        }
    }

    // ---- 动作
    let busy = false;
    async function withBusy(fn) {
        if (busy) return;
        busy = true;
        $('.cig-btn').prop('disabled', true);
        try {
            await fn();
        } catch (err) {
            console.error('[CharImageGen]', err);
            setStatus(String(err?.message || err), 'cig-err');
        } finally {
            busy = false;
            $('.cig-btn').prop('disabled', false);
            renderCast();
            renderOutfit();
            applyInjection();
        }
    }

    $('#cig-rescan').on('click', () => withBusy(async () => { rescan(); }));

    $('#cig-sync-preset').on('click', () => {
        const r = syncPresetEntry();
        const map = {
            updated: ['已把最新指令写进预设条目「' + CAST_ENTRY_NAME + '」', 'cig-ok'],
            same: ['预设条目已是最新，无需改动', 'cig-ok'],
            'no-entry': [`没找到名为「${CAST_ENTRY_NAME}」的预设条目 —— 先按之前的方式加上，或换回上面的注入开关`, 'cig-err'],
            'no-list': ['读不到运行时提示词列表，请刷新页面后重试', 'cig-err'],
            error: ['同步出错，详见控制台', 'cig-err'],
        };
        const [msg, kind] = map[r] || ['未知结果: ' + r, 'cig-err'];
        setStatus(msg, kind);
    });

    $('#cig-cast-extract').on('click', () => withBusy(async () => {
        const c = currentChar();
        if (!c.name) throw new Error('没有选中角色卡');
        if (!c.desc) throw new Error('当前角色卡的「描述」是空的，没法提取；请手动填写');
        setStatus('正在提取本卡全部角色…（会请求一次模型）');

        const quietPrompt = substituteParams(
            ROSTER_TEMPLATE.split('{{card}}').join(c.name).split('{{desc}}').join(c.desc),
        );
        const reply = await generateQuietPrompt({ quietPrompt });

        let list = [];
        const parsed = parseJsonLoose(reply);
        if (Array.isArray(parsed)) list = parsed;
        else if (parsed && Array.isArray(parsed.characters)) list = parsed.characters;
        if (!list.length) list = parseRosterLines(reply);

        const items = list.map(it => ({
            name: it?.name ?? it?.character,
            identity: it?.identity ?? it?.appearance,
            outfit_name: it?.outfit_name,
            outfit: it?.outfit,
        }));
        const outfits = {};
        for (const it of items) {
            const on = String(it.outfit_name ?? '').trim();
            const ot = tidyPrompt(it.outfit ?? '');
            if (on && ot) outfits[on] = { tags: ot, owner: String(it.name ?? '').trim() };
        }
        if (!items.length) throw new Error('没能解析出角色，换个模型或手动填写试试');

        // 服装先入库（复用/归类的判定和正文登记一致），再合并角色
        const log = mergeCast({ characters: items });
        for (const [on, o] of Object.entries(outfits)) {
            const res = addOutfit(on, o.tags);
            if (!res) continue;
            if (res.reused) {
                if (!log.reusedOutfits.includes(res.name)) log.reusedOutfits.push(res.name);
            } else if (res.grouped) {
                log.newOutfits.push(`${res.name}（归入 ${res.grouped}）`);
            } else {
                log.newOutfits.push(res.name);
            }
            const ownerKey = o.owner && isPlayerName(o.owner) ? PLAYER : o.owner;
            const ownerEnt = ownerKey ? subjectEntry(ownerKey) : null;
            if (ownerEnt) {
                ownerEnt.outfit = res.name;
                log.owned.push(`${isPlayer(ownerKey) ? '🧍' + playerLabel() : ownerKey}→${res.name}`);
            }
        }
        save();

        renderCast();
        renderOutfit();
        applyInjection();
        setStatus('提取完成：' + (mergeSummary(log) || '无新增'), 'cig-ok');
    }));

    $('#cig-outfit-extract').on('click', () => withBusy(async () => {
        const c = currentChar();
        const name = resolvedName();
        if (!name) throw new Error('没有选中角色');
        if (!c.desc) throw new Error('当前角色卡的「描述」是空的，没法提取');
        setStatus('正在提取服装…（会请求一次模型）');

        const quietPrompt = substituteParams(
            OUTFIT_TEMPLATE.split('{{char}}').join(name).split('{{desc}}').join(c.desc),
        );
        const reply = await generateQuietPrompt({ quietPrompt });
        const obj = parseJsonLoose(reply);
        const ot = tidyPrompt(obj?.outfit ?? obj?.tags ?? '');
        if (!ot) throw new Error('没能解析出服装，请手动填写');

        const on = String(obj?.name ?? '').trim() || `${name}的服装`;
        const res = addOutfit(on, ot);
        if (!res) throw new Error('服装内容是空的');
        s.currentOutfit = res.name;
        const ent = subjectEntry(name);
        if (ent) ent.outfit = res.name;
        save();
        renderOutfit();
        renderCast();
        if (res.reused) setStatus(`内容与已有服装「${res.name}」相同，直接复用，没有新建`, 'cig-ok');
        else if (res.grouped) setStatus('「' + res.name + '」收成了「' + res.grouped + '」的差分' + (res.why ? '（' + res.why + '）' : ''), 'cig-ok');
        else setStatus(`已入库服装「${res.name}」`, 'cig-ok');
    }));

    $('#cig-convert').on('click', () => withBusy(async () => {
        const raw = $('#cig-input').val();
        s.lastInput = raw;
        save();
        setStatus(s.useLlm ? '正在改写…' : '正在转换…');
        $('#cig-preview').val(assemblePrompt(await rewriteScene(raw)));
        setStatus('改写完成，可以先生成或再手改', 'cig-ok');
    }));

    $('#cig-generate').on('click', () => withBusy(async () => {
        const raw = $('#cig-input').val();
        s.lastInput = raw;
        save();
        const n = resolvedName();
        if (s.mode === 'free' && s.useLlm && !identityOf(n)) {
            setStatus(`提示：角色「${n || '未选中'}」还没有身份存档，自由构图下长相会很随机`);
        } else {
            setStatus(s.useLlm ? '正在改写…' : '正在转换…');
        }
        $('#cig-preview').val(assemblePrompt(await rewriteScene(raw)));
        setStatus('正在出图…（首次加载模型会慢一些）');
        await generate($('#cig-preview').val());
        setStatus('出图完成 ✅', 'cig-ok');
    }));

    $('#cig-generate-raw').on('click', () => withBusy(async () => {
        setStatus('正在出图…（首次加载模型会慢一些）');
        await generate($('#cig-preview').val());
        setStatus('出图完成 ✅', 'cig-ok');
    }));

    // ---- 启动时把注入、正则、预设条目都对齐
    applyInjection();
    installRegexes();
    const syncResult = syncPresetEntry();
    if (syncResult === 'updated') console.log('[CharImageGen] 已把最新登记指令同步进预设条目');

    // ---- 词库：先把上次导入的重建起来（纯本地），再刷界面
    renderLexStat();
    renderLexCats();
    renderLexBrowse();
    lexRestore().then((ok) => {
        if (!ok) return;
        renderLexStat();
        renderLexCats();
        renderLexBrowse();
        renderLexCheck();
        console.log('[CharImageGen] 词库已恢复', lex().stats());
    }).catch(() => { /* 恢复失败就继续用兜底词库 */ });

    console.log('[CharImageGen] 扩展已加载 v' + CIG_VERSION + '，模式 =', s.mode,
                '| 角色存档', Object.keys(s.characters).length,
                '| 服装库', Object.keys(s.outfits).length,
                '| 自动登记', s.autoRegister,
                '| 预设条目同步', syncResult,
                '| 词库 tag', lex().stats().tags);
}

/**
 * 面板预览 / 传给 ST 的提示词 = 场景描述。
 * 质量前缀由酒馆的 prompt_prefix 提供，身份和服装由 SD_PROMPT_PROCESSING 钩子拼进去，
 * 所以这里都不重复写 —— 避免同一串 tag 出现两遍。
 * 词库开着的话，这里顺手把中文 tag 翻成英文、别名归一（认不出的一律保留）。
 */
function assemblePrompt(scene) {
    return tidyPrompt(lexClean(String(scene ?? '')));
}

async function rewriteScene(raw) {
    const s = S();
    const body = String(raw ?? '').trim();
    if (!body) throw new Error('请先输入你想画的内容');
    if (!s.useLlm) return lexClean(localConvert(body));
    // 词库里捞一批「动作 / 表情 / 镜头」候选，跟着指令一起给模型 ——
    // 让它从规范 tag 里挑，而不是自己编，动作才稳、才丰富
    let quietPrompt = substituteParams(String(s.template).split('{{input}}').join(body));
    const hint = lexHintFor(body);
    if (hint) quietPrompt += `\n\n${hint}`;
    const out = tidyPrompt(await generateQuietPrompt({ quietPrompt }));
    if (!out) throw new Error('改写结果为空，试试关掉「用 LLM 改写」直接用原文');
    return lexClean(out);
}

/**
 * 参考图的绝对路径。
 * ComfyUI 的 LoadImage 只认它自己 input 目录里的文件（校验用 realpath，
 * 目录联接也骗不过去），所以图生图走 VideoHelperSuite 的 VHS_LoadImagePath ——
 * 那个节点吃任意绝对路径。上传的图存在酒馆的 user/files 下，这里把绝对路径拼出来。
 */
function freeRefAbsPath() {
    const s = S();
    const root = String(s.img2imgRoot || '').trim().replace(/[\\/]+$/, '');
    const name = String(s.freeRefName || '').trim();
    if (!root || !name) return '';
    return root + (root.includes('\\') ? '\\' : '/') + name;
}

/** 设置/清除酒馆 ComfyUI 工作流的自定义占位符（%free_ref% → 绝对路径）。 */
function setComfyPlaceholder(find, replace) {
    const sd = extension_settings?.sd;
    if (!sd) return;
    if (!Array.isArray(sd.comfy_placeholders)) sd.comfy_placeholders = [];
    const list = sd.comfy_placeholders;
    const idx = list.findIndex(p => p && p.find === find);
    if (replace) {
        const entry = { find, replace };
        if (idx >= 0) list[idx] = entry; else list.push(entry);
    } else if (idx >= 0) {
        list.splice(idx, 1);
    }
}

/**
 * LoRA 的文件名和强度也是靠占位符喂进去的（工作流里写 "%lora_name%" / "%lora_weight%"）。
 * 酒馆的自定义占位符只能塞字符串，幸运的是 ComfyUI 的 strength_model 会自己把 "0.8"
 * 当数字用 —— 实测强度 0 / 0.45 / 1.0 出图确实不一样，强度 0 和不挂 LoRA 逐像素相同。
 */
function setLoraPlaceholders() {
    const s = S();
    if (s.loraEnabled && s.loraName) {
        setComfyPlaceholder('lora_name', s.loraName);
        setComfyPlaceholder('lora_weight', String(Number(s.loraWeight) || 0));
        return;
    }
    // 只有「我们真的开过 LoRA」时才去清理，免得删掉用户自己加的同名占位符
    if (s.loraBaseWorkflow || s.loraEnabled) {
        setComfyPlaceholder('lora_name', '');
        setComfyPlaceholder('lora_weight', '');
    }
}

/** 这次出图该用哪份工作流（LoRA 开着就换成带 LoRA 的那份）。 */
function workflowFor(useRef) {
    const s = S();
    if (s.loraEnabled) {
        const w = useRef ? s.loraImg2imgWorkflow : s.loraWorkflow;
        if (w) return w;
    }
    return useRef ? s.img2imgWorkflow : s.freeWorkflow;
}

/**
 * LoRA 总开关真正的落点：换掉酒馆当前用的 ComfyUI 工作流（带 LoRA 的那份 ↔ 原来那份）。
 * 关掉时会切回开启前记下的那份，所以「开关」是可逆的，不会把酒馆设置改乱。
 */
function applyLoraWorkflow() {
    const s = S();
    const sd = extension_settings?.sd;
    if (!sd) { setLoraPlaceholders(); save(); return; }
    if (s.loraEnabled) {
        if (!s.loraBaseWorkflow) s.loraBaseWorkflow = String(sd.comfy_workflow || s.freeWorkflow || '');
        if (s.loraWorkflow) sd.comfy_workflow = s.loraWorkflow;
        setLoraPlaceholders();
    } else {
        setLoraPlaceholders();
        const cur = String(sd.comfy_workflow || '');
        const mine = [s.loraWorkflow, s.loraImg2imgWorkflow].filter(Boolean);
        if (s.loraBaseWorkflow && mine.includes(cur)) sd.comfy_workflow = s.loraBaseWorkflow;
        else if (!cur && s.freeWorkflow) sd.comfy_workflow = s.freeWorkflow;
    }
    try {
        const el = document.getElementById('sd_comfy_workflow');
        if (el) $(el).val(sd.comfy_workflow);
    } catch { /* 酒馆的 SD 面板没渲染也无所谓 */ }
    console.log(`[CharImageGen] LoRA ${s.loraEnabled ? '开' : '关'} → 工作流 ${sd.comfy_workflow}`);
    save();
}

/**
 * 问 ComfyUI 要 LoRA 列表。注意：ComfyUI 默认不允许网页跨域读它的接口
 * （带 Origin 的请求直接 403），所以这个按钮失败很正常 —— 手输文件名一样用。
 */
async function fetchComfyLoras() {
    const s = S();
    const url = String(extension_settings?.sd?.comfy_url || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    let res;
    try {
        res = await fetch(`${url}/object_info/LoraLoaderModelOnly`);
    } catch (e) {
        throw new Error(`浏览器读不到 ComfyUI（跨域被挡，ComfyUI 默认不让网页直接读接口）。直接手输文件名就行，例如 ${s.loraName || 'xxx.safetensors'}；` +
            `想用这个按钮的话，给 ComfyUI 加启动参数 --enable-cors-header "*"`);
    }
    if (!res.ok) throw new Error(`ComfyUI 拒绝了（${res.status}）。跨域被挡是正常的，直接手输文件名即可`);
    const j = await res.json();
    const list = j?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0];
    if (!Array.isArray(list)) throw new Error('ComfyUI 没返回 LoRA 列表（可能没装 LoRA 节点）');
    return list;
}

/** 绘图区的出图：同一条酒馆生图链路，但随机种子、且不拼外观锁（见 skipLookOnce）。 */
async function generateFree(prompt, useRef = false) {
    const s = S();
    const body = String(prompt ?? '').trim();
    if (!body) throw new Error('提示词是空的');
    const sd = extension_settings.sd;
    // 生成期间临时改酒馆 SD 设置，跑完必须还原：不然接下来「自动生图」会
    // 继续用图生图工作流，而参考图的占位符早就没了 → 直接报错。
    const keep = sd ? { workflow: sd.comfy_workflow, denoise: sd.denoising_strength } : null;
    if (sd) {
        if (useRef) {
            const wf = workflowFor(true);
            if (wf) sd.comfy_workflow = wf;
            sd.denoising_strength = Math.min(1, Math.max(0.1, Number(s.img2imgDenoise) || 0.6));
            setComfyPlaceholder('free_ref', freeRefAbsPath());
        } else {
            const wf = workflowFor(false);
            if (wf) sd.comfy_workflow = wf;
            sd.denoising_strength = 1.0;
            setComfyPlaceholder('free_ref', '');
        }
        setLoraPlaceholders();
        const fixedSeedFree = seedFixedValue();
        sd.seed = fixedSeedFree !== null ? fixedSeedFree : -1;   // 绘图区默认随机；勾了「固定种子」就照用
        s.lastSeed = sd.seed;
        save();
    }
    const cmd = SlashCommandParser.commands['imagine'];
    if (!cmd || typeof cmd.callback !== 'function') {
        if (keep) { sd.comfy_workflow = keep.workflow; sd.denoising_strength = keep.denoise; }
        throw new Error('找不到 /imagine 命令 —— 请确认「Image Generation」扩展已启用，且 Source 选了 ComfyUI');
    }
    skipLookOnce = true;
    try {
        await cmd.callback({}, body);
    } finally {
        skipLookOnce = false;
        if (keep) {
            sd.comfy_workflow = keep.workflow;
            sd.denoising_strength = keep.denoise;
            setComfyPlaceholder('free_ref', '');   // 用完就摘掉，别留给别的生图
            save();
        }
    }
}

async function generate(prompt) {
    const s = S();
    const body = String(prompt ?? '').trim();
    if (!body) throw new Error('提示词是空的');

    const sd = extension_settings.sd;
    if (sd) {
        // 工作流名留空就沿用酒馆里当前选的那个，不要把它清掉
        const wf = s.mode === 'free' ? workflowFor(false) : s.lockWorkflow;
        if (wf) sd.comfy_workflow = wf;
        sd.denoising_strength = s.mode === 'free' ? 1.0 : Number(s.denoise);
        const fixedSeed = seedFixedValue();
        sd.seed = fixedSeed !== null ? fixedSeed : (s.useCharSeed ? seedFor(resolvedName()) : -1);
        s.lastSeed = sd.seed;
        setLoraPlaceholders();
        save();
        try {
            $('#sd_comfy_workflow').val(sd.comfy_workflow);
            $('#sd_seed').val(sd.seed);
            $('#sd_denoising_strength').val(sd.denoising_strength).trigger('input');
        } catch { /* 界面没渲染出来也无所谓 */ }
    }

    const cmd = SlashCommandParser.commands['imagine'];
    if (!cmd || typeof cmd.callback !== 'function') {
        throw new Error('找不到 /imagine 命令 —— 请确认「Image Generation」扩展已启用，且 Source 选了 ComfyUI');
    }
    await cmd.callback({}, body);
}

jQuery(() => {
    try {
        buildUI();
    } catch (err) {
        console.error('[CharImageGen] 初始化失败', err);
    }
});
