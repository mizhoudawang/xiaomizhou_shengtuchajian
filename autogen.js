/*!
 * CharImageGen · 自动出图：从消息里解析图片提示词（纯逻辑，可单测）
 * Copyright (c) 2026 小米粥大王 · MIT License
 *
 * 世界书（例如某个「文生图世界书」）会让模型在回复里写提示词块，两种形态都认：
 *   1. image###英文 tag，逗号分隔###
 *   2. <!--img-prompt="英文 tag，逗号分隔"-->      ← 酒馆正则把上一种转成这种
 */

const MAX_LEN = 2000;

/** 反转义酒馆正则写进去的 \" 与 \\ */
function unescapePrompt(s) {
    return String(s ?? '').replace(/\\(["\\])/g, '$1');
}

/** 去掉两头的空白/引号/换行，并压成一行（ComfyUI 那边换行没意义） */
function tidyPromptText(s) {
    return String(s ?? '')
        .replace(/\r?\n/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .trim();
}

/**
 * 从一条消息里抽出所有图片提示词（保序、去重、过滤明显不是提示词的）。
 * @returns {string[]}
 */
export function extractPrompts(text) {
    const t = String(text ?? '');
    if (!t) return [];
    const found = [];

    // ① <!--img-prompt="..." -->（酒馆转换后的形态）
    for (const m of t.matchAll(/<!--\s*img-prompt\s*=\s*"([\s\S]*?)"\s*-->/gi)) {
        const v = tidyPromptText(unescapePrompt(m[1]));
        if (v) found.push(v);
    }
    // ② 其它已知外壳（不同世界书/正则用的写法都不一样，全认）
    const SHELLS = [
        /image###([\s\S]*?)###/gi,                                  // 世界书：image###…###
        /\[IMG_GEN\]([\s\S]*?)\[\/IMG_GEN\]/gi,                     // 生图助手锚点： [IMG_GEN]…[/IMG_GEN]
        /<img_prompt\s*=\s*"([\s\S]*?)"\s*>/gi,                      // <img_prompt="…">
        /<image>([\s\S]*?)<\/image>/gi,                            // <image>…</image>
        /\[image\]([\s\S]*?)\[\/image\]/gi,                        // [image]…[/image]
        /(?:^|\n)\s*prompt\s*[:：]\s*(.+)/gi,                         // prompt: xxx
    ];
    for (const re of SHELLS) {
        for (const m of t.matchAll(re)) {
            // <image> 里可能还套着别的外壳，递归再拆一次
            const inner = /image###|\[IMG_GEN\]|<img_prompt/i.test(m[1]) ? '' : m[1];
            const v = tidyPromptText(unescapePrompt(inner));
            if (v) found.push(v);
        }
    }

    // 去重（同一条消息里重复写同一段提示词很常见）
    const seen = new Set();
    const out = [];
    for (const v of found) {
        if (v.length < 8 || v.length > MAX_LEN) continue;      // 太短/太长都不像提示词
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}

/**
 * 决定这次要出几张、出哪几张。
 * @param {string[]} prompts extractPrompts 的结果
 * @param {{max?:number, last?:string[]}} opts max = 一条消息最多出几张；last = 刚才出过的提示词
 */
export function planPrompts(prompts, opts = {}) {
    const max = Math.max(1, Math.min(Number(opts.max) || 2, 6));
    const last = Array.isArray(opts.last) ? opts.last.map(x => String(x).toLowerCase()) : [];
    const fresh = (prompts || []).filter(p => !last.includes(String(p).toLowerCase()));
    const use = (fresh.length ? fresh : (prompts || [])).slice(0, max);
    return { prompts: use, skipped: Math.max(0, (prompts || []).length - use.length) };
}

/** 提示词是不是"长句小说"而不是 tag 列表 —— 这种喂给模型效果差，面板上提醒一下。 */
export function looksLikeProse(prompt) {
    const p = String(prompt ?? '');
    const words = p.split(/\s+/).filter(Boolean).length;
    const commas = (p.match(/,/g) || []).length;
    return (words > 45 && commas < 12) || /\.\s+[A-Z]/.test(p);
}
