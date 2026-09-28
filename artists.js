/**
 * 画师画风库（artist style library）
 * ------------------------------------------------------------------
 * 用途：把 **booru 画师 tag** 加进生图提示词，让模型往那个画师的风格偏。
 * 和 LoRA 是两条独立的路：LoRA 改模型权重，这个只改提示词 —— 所以**互不冲突、可以叠加**，
 * 想用自己 LoRA 的用户完全不受影响（LoRA 那套工作流一个字没动）。
 *
 * 每条字段：
 *   id     内部唯一键
 *   tag    画师 booru tag（**最关键的一格**，模型只认这个）
 *   zh/en  中文名 / 英文名（面板显示与搜索用）
 *   style  风格关键词（英文，可直接被模型理解；不用也可以，留着给你参考）
 *   note   一句话中文说明（辨认这个画师风格靠什么）
 *   rating sfw | nsfw（成人向画师会标出来，面板可按这个筛）
 *
 * ⚠ 诚实说明两点：
 *   1. 下面每个 tag 都在 safebooru 上**实测存在**（抓得到作品）。safebooru 是 SFW 站，
 *      所以只在 danbooru 上的画师（ask (artist)、lif (artist)、notti…）我**没收**，
 *      也没法替你验证 —— 想加就照格式加，tag 去 booru 上搜一下确认为准。
 *   2. `style` 里的英文词是我按画风给的关键词（**不是**该画师的官方 tag），
 *      只是可选的助推词；真正起作用的是 `tag`。不确定的那些我只写了保守描述。
 */

export const ARTISTS = [
    { id: 'wlop', tag: 'wlop', zh: 'WLOP', en: 'WLOP', style: 'painterly, dramatic lighting, oil painting texture, realistic shading', note: '厚涂油画感、强光影、半写实（中国画师）', rating: 'sfw' },
    { id: 'yoneyama_mai', tag: 'yoneyama mai', zh: '米山舞', en: 'Yoneyama Mai', style: 'vivid lighting, glossy highlights, dynamic pose, cyberpunk colors', note: '强透视与动态、赛博霓虹、发丝高光（你现有 LoRA 就是她）', rating: 'sfw' },
    { id: 'fuzichoco', tag: 'fuzichoco', zh: '藤ちょこ', en: 'Fuzichoco', style: 'vibrant colors, jewel tones, ornate details, glossy', note: '华丽鲜艳、宝石质感、细节繁复', rating: 'sfw' },
    { id: 'kantoku', tag: 'kantoku', zh: 'カントク', en: 'Kantoku', style: 'clean lines, soft shading, cute girls, pastel', note: '清透美少女、柔和上色', rating: 'sfw' },
    { id: 'mika_pikazo', tag: 'mika pikazo', zh: 'mika pikazo', en: 'Mika Pikazo', style: 'high saturation, neon colors, glossy skin, pop art', note: '高饱和霓虹、光泽皮肤、波普感', rating: 'sfw' },
    { id: 'mochizuki_kei', tag: 'mochizuki kei', zh: '望月けい', en: 'Mochizuki Kei', style: 'flat colors, bold composition, graphic design, minimal shading', note: '平涂强构成、设计感、色块分明', rating: 'sfw' },
    { id: 'saitom', tag: 'saitom', zh: 'さいとむ', en: 'Saitom', style: 'sharp lines, light novel illustration, clean', note: '轻小说插画、线条锐利干净', rating: 'sfw' },
    { id: 'kuroboshi_kouhaku', tag: 'kuroboshi kouhaku', zh: '黒星紅白', en: 'Kuroboshi Kouhaku', style: 'light novel illustration, soft colors, detailed clothing', note: '轻小说插画（奇诺之旅）、柔和细致', rating: 'sfw' },
    { id: 'tsunako', tag: 'tsunako', zh: 'つなこ', en: 'Tsunako', style: 'light novel illustration, glossy, sharp highlights', note: '轻小说插画（约会大作战）、光泽高光', rating: 'sfw' },
    { id: 'so-bin', tag: 'so-bin', zh: 'so-bin', en: 'so-bin', style: 'dark fantasy, heavy rendering, ornate armor', note: '暗黑奇幻厚涂（Overlord）、重质感', rating: 'sfw' },
    { id: 'huke', tag: 'huke', zh: 'huke', en: 'huke', style: 'mecha, dark palette, glowing eyes, hard edges', note: '硬朗机甲风（黑岩射手）、冷色发光', rating: 'sfw' },
    { id: 'redjuice', tag: 'redjuice', zh: 'redjuice', en: 'redjuice', style: 'cyberpunk, sci-fi, glitch, neon', note: '赛博科幻、冷调科技感', rating: 'sfw' },
    { id: 'guweiz', tag: 'guweiz', zh: 'Guweiz', en: 'Guweiz', style: 'digital painting, cinematic lighting, semi-realistic', note: '电影感厚涂、半写实（新加坡画师）', rating: 'sfw' },
    { id: 'ross_tran', tag: 'ross tran', zh: 'Ross Tran', en: 'Ross Tran', style: 'digital painting, warm lighting, concept art', note: '概念设计厚涂、暖光', rating: 'sfw' },
    { id: 'ilya_kuvshinov', tag: 'ilya kuvshinov', zh: 'Ilya Kuvshinov', en: 'Ilya Kuvshinov', style: 'painterly, soft lighting, stylized faces', note: '俄系厚涂、独特脸型与柔光', rating: 'sfw' },
    { id: 'sakimichan', tag: 'sakimichan', zh: 'Sakimichan', en: 'Sakimichan', style: 'semi-realistic, glossy skin, pin-up', note: '半写实、光泽皮肤、海报感', rating: 'sfw' },
    { id: 'ciloranko', tag: 'ciloranko', zh: 'ciloranko', en: 'Ciloranko', style: 'soft lighting, korean illustration, muted palette', note: '韩系插画、柔光低饱和', rating: 'sfw' },
    { id: 'rella', tag: 'rella', zh: 'rella', en: 'rella', style: 'korean illustration, glossy, dramatic lighting', note: '韩系插画、光泽与戏剧光', rating: 'sfw' },
    { id: 'hyulla', tag: 'hyulla', zh: 'hyulla', en: 'Hyulla', style: 'korean illustration, soft, elegant', note: '韩系插画（作品较少，风格描述保守）', rating: 'sfw' },
    { id: 'modare', tag: 'modare', zh: 'modare', en: 'modare', style: 'anime, soft shading, expressive', note: '日系插画（风格描述保守，以 tag 效果为准）', rating: 'sfw' },
    { id: 'ke-ta', tag: 'ke-ta', zh: 'ke-ta', en: 'Ke-ta', style: 'soft colors, delicate lines, gentle shading', note: '淡雅柔和、线条纤细（东方系画师）', rating: 'sfw' },
    { id: 'hiten', tag: 'hiten', zh: 'hiten', en: 'hiten', style: 'glossy highlights, transparent skin, romantic', note: '透亮高光、浪漫氛围', rating: 'sfw' },
    { id: 'hoshino_lily', tag: 'hoshino lily', zh: 'ほしのりりぃ', en: 'Hoshino Lily', style: 'moe, soft, round faces', note: '萌系圆脸、柔和上色', rating: 'sfw' },
    { id: 'fkey', tag: 'fkey', zh: 'fkey', en: 'fkey', style: 'anime, clean lines, vivid', note: '日系（成人向画师，SFW 站也有作品）', rating: 'nsfw' },
    { id: 'as109', tag: 'as109', zh: 'as109', en: 'as109', style: 'anime, glossy, detailed', note: '成人向画师', rating: 'nsfw' },
    { id: 'raita', tag: 'raita', zh: 'RAITA', en: 'RAITA', style: 'retro anime, bold lines, exaggerated', note: '成人向老牌画师、复古粗线', rating: 'nsfw' },
    { id: 'toosaka_asagi', tag: 'toosaka asagi', zh: '遠坂あさぎ', en: 'Toosaka Asagi', style: 'anime, glossy skin, soft shading', note: '成人向画师、光泽柔和', rating: 'nsfw' },
    { id: 'ebifurya', tag: 'ebifurya', zh: 'ebifurya', en: 'ebifurya', style: 'anime, bold shading, vivid', note: '成人向画师', rating: 'nsfw' },
    { id: 'konya_karasue', tag: 'konya karasue', zh: 'こにゃ', en: 'Konya Karasue', style: 'anime, soft, expressive', note: '成人向画师（风格描述保守）', rating: 'nsfw' },
    { id: 'mika_pikazo_style', tag: 'mika pikazo (style)', zh: 'mika pikazo（风格向）', en: 'Mika Pikazo (style)', style: 'high saturation, pop, neon', note: '上面那位画师的「风格」类 tag，泛化更强、更像画风本身', rating: 'sfw' },
];

/** 注入写法：模型真正吃的是 tag，前缀只是各前端的约定。 */
export const ARTIST_SYNTAXES = [
    ['@', '@画师名', '你提到的那种写法'],
    ['artist:', 'artist:画师名', 'booru 惯例写法（很多动漫模型对这个最敏感）'],
    ['', '纯画师名', '什么都不加，直接写 tag'],
];

/** 把选中的画师拼成一段注入文本（纯函数，方便单测）。 */
export function buildArtistBlock(styles, syntax = '@') {
    const list = Array.isArray(styles) ? styles : [];
    const parts = [];
    for (const s of list) {
        if (!s || !s.tag) continue;
        const w = Number(s.weight);
        let one = `${syntax}${s.tag}`;
        if (Number.isFinite(w) && w > 0 && Math.abs(w - 1) > 0.001) one = `(${one}:${w.toFixed(2)})`;
        parts.push(one);
    }
    return parts.join(', ');
}

/** 面板显示用：把选中项整理成 [{tag, weight}] */
export function normalizeStyles(list) {
    return (Array.isArray(list) ? list : [])
        .filter(x => x && x.tag)
        .map(x => ({ tag: String(x.tag), weight: Number(x.weight) > 0 ? Number(x.weight) : 1 }));
}
