/**
 * 画师画风面板（独立模块，和同人角色库一个套路）
 * 只改提示词，不动模型权重 —— 所以和 LoRA 互不干扰，可以叠加。
 */
import { ARTISTS, ARTIST_SYNTAXES, buildArtistBlock } from './artists.js';

export function mountArtistPanel(ctx) {
    const $ = ctx.$;
    const root = document.getElementById('cig-artist-body');
    if (!root) return null;
    const $root = $(root);
    const norm = t => String(t ?? '').trim().toLowerCase();

    function S() { return ctx.S(); }
    function styles() {
        const s = S();
        if (!Array.isArray(s.artistStyles)) s.artistStyles = [];
        return s.artistStyles;
    }
    const has = tag => styles().some(x => x.tag === tag);
    const preview = () => buildArtistBlock(styles(), S().artistSyntax ?? '@');

    function render() {
        const s = S();
        const focused = document.activeElement && document.activeElement.id === 'cig-artist-q';
        const caret = focused ? document.activeElement.selectionStart : 0;
        $root.empty();

        // 顶部：开关 + 写法 + 预览
        const box = $('<div class="cig-fan-refbox"></div>');
        const $on = $('<input type="checkbox" id="cig-artist-on" />').prop('checked', s.artistOn !== false);
        box.append($('<label class="cig-check"></label>').append($on, $('<span></span>').text(' 启用画师画风（只改提示词，和 LoRA 互不影响，可叠加）')));
        const $syn = $('<select id="cig-artist-syntax"></select>');
        for (const [v, label, tip] of ARTIST_SYNTAXES) $syn.append($('<option>').val(v).text(`${label}　—　${tip}`));
        $syn.val(s.artistSyntax ?? '@');
        box.append($('<label class="cig-label"></label>').text('注入写法（模型认的是画师 tag，前缀只是约定写法，可以都试试）'));
        box.append($syn);
        const $inFree = $('<input type="checkbox" id="cig-artist-free" />').prop('checked', !!s.artistInFree);
        box.append($('<label class="cig-check"></label>').append($inFree, $('<span></span>').text(' 绘图区（纯提示词出图）也套用')));
        const pv = preview();
        box.append($('<div class="cig-hint"></div>').text(pv ? `本次会注入：${pv}` : '还没选画师 —— 下面列表里点「加上」'));
        $root.append(box);

        // 已选列表
        const selBox = $('<div class="cig-fan-refbox"></div>');
        selBox.append($('<div class="cig-sub"></div>').text(`已选画风（${styles().length}）— 顺序就是注入顺序，靠前的权重感更强`));
        if (!styles().length) selBox.append($('<div class="cig-hint"></div>').text('（空）'));
        styles().forEach((st, i) => {
            const row = $('<div class="cig-artist-sel"></div>');
            row.append($('<span class="cig-artist-tag"></span>').text(st.tag));
            const $w = $('<input type="number" min="0.1" max="2" step="0.05" class="cig-artist-w" />').val(st.weight ?? 1);
            row.append($('<label class="cig-hint"></label>').text('权重 '), $w);
            const mk = (label, fn) => { const b = $('<button class="cig-btn"></button>').text(label); b.on('click', () => ctx.withBusy(async () => fn())); return b; };
            row.append(mk('上移', () => { if (i > 0) { const a = styles(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; ctx.save(); render(); } }));
            row.append(mk('移除', () => { S().artistStyles = styles().filter(x => x.tag !== st.tag); ctx.save(); render(); }));
            $w.on('input', function () { const v = Number(this.value); st.weight = Number.isFinite(v) && v > 0 ? v : 1; ctx.save(); const p = preview(); $root.find('.cig-hint').last().text(`本次会注入：${p}`); });
            selBox.append(row);
        });
        if (styles().length) {
            const b = $('<button class="cig-btn cig-wide"></button>').text('清空已选画风');
            b.on('click', () => ctx.withBusy(async () => { S().artistStyles = []; ctx.save(); render(); }));
            selBox.append(b);
        }
        $root.append(selBox);

        // 可选列表
        const bar = $('<div class="cig-fan-bar"></div>');
        const $q = $('<input type="text" id="cig-artist-q" placeholder="搜画师（中文名/英文名/tag/风格词）" />').val(s.artistQuery || '');
        const $rating = $('<select id="cig-artist-rating"></select>');
        for (const [v, t] of [['all', '全部'], ['sfw', '一般向'], ['nsfw', '成人向']]) $rating.append($('<option>').val(v).text(t));
        $rating.val(s.artistRating || 'all');
        bar.append($q, $rating);
        $root.append(bar);

        const q = norm(s.artistQuery);
        const list = ARTISTS.filter(a => {
            if (s.artistRating && s.artistRating !== 'all' && a.rating !== s.artistRating) return false;
            if (!q) return true;
            const hay = [a.zh, a.en, a.tag, a.style, a.note].map(norm).join(' ');
            return q.split(/\s+/).every(w => hay.includes(w));
        });
        $root.append($('<div class="cig-hint"></div>').text(`画师库 ${ARTISTS.length} 个，匹配 ${list.length} 个（都已实测在 booru 上有作品）`));
        const listBox = $('<div class="cig-fan-list"></div>');
        for (const a of list.slice(0, 40)) {
            const row = $('<div class="cig-fan-row"></div>');
            const info = $('<div class="cig-fan-info"></div>');
            info.append($('<div class="cig-fan-name"></div>').text(`${a.zh}　${a.tag}`));
            info.append($('<div class="cig-fan-sub"></div>').text(`${a.style}${a.rating === 'nsfw' ? '　[成人向]' : ''}`));
            info.append($('<div class="cig-fan-note"></div>').text(a.note));
            const acts = $('<div class="cig-fan-acts"></div>');
            const b = $('<button class="cig-btn"></button>').text(has(a.tag) ? '已选' : '加上');
            b.on('click', () => ctx.withBusy(async () => {
                if (!has(a.tag)) styles().push({ tag: a.tag, weight: 1 });
                ctx.save();
                render();
                ctx.setStatus(`已加入画风：${a.tag}（注入：${preview()}）`, 'cig-ok');
            }));
            acts.append(b);
            row.append(info, acts);
            listBox.append(row);
        }
        if (!list.length) listBox.append($('<div class="cig-hint"></div>').text('没有匹配的画师 —— 换个词，或把筛选调回「全部」。'));
        $root.append(listBox);

        $root.append($('<div class="cig-hint"></div>').text(
            '提示：画师 tag 喜欢放提示词**靠前**（插件会插在质量词之后、角色外观之前）。' +
            '多个画师混用会让风格打架，一般 1~2 个最稳；想更强就把权重调到 1.2~1.5 试试。'
        ));

        $on.on('change', function () { S().artistOn = !!this.checked; ctx.save(); ctx.setStatus(this.checked ? '已启用画师画风' : '已关闭画师画风（LoRA 不受影响）', 'cig-ok'); });
        $syn.on('change', function () { S().artistSyntax = String(this.value); ctx.save(); render(); });
        $inFree.on('change', function () { S().artistInFree = !!this.checked; ctx.save(); });
        $q.on('input', function () { S().artistQuery = String(this.value); ctx.save(); render(); });
        $rating.on('change', function () { S().artistRating = String(this.value); ctx.save(); render(); });
        if (focused) { const el = document.getElementById('cig-artist-q'); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* 无所谓 */ } } }
    }

    render();
    console.log(`[CharImageGen] 画师画风已挂载：${ARTISTS.length} 个画师`);
    return { render, preview };
}
