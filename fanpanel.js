/*!
 * CharImageGen · 角色一致性生图（SillyTavern 扩展）
 * Copyright (c) 2026 小米粥大王
 * MIT License — 完整协议见仓库根目录 LICENSE 文件
 * 仓库: https://github.com/mizhoudawang/xiaomizhou_shengtuchajian
 */
/**
 * 同人角色库面板（独立模块）
 * ------------------------------------------------------------------
 * 由 index.js 在面板里挂一个容器，再把需要的上下文（S/save/setStatus/…）传进来。
 * 这样拆开写的好处：角色库的玩法（建档、锁外观、补词）跟主面板的逻辑互不干扰。
 */
import { FANCHARS, FANCHAR_SERIES, fanIdentityTags } from './fanchars.js';
import {
    parseCustomChars, mergeCustomChars, toExportText, TEMPLATE_OBJECT, AI_PROMPT_TEXT,
} from './customchars.js';

const PER_PAGE = 24;

export function mountFanPanel(ctx) {
    const $ = ctx.$;
    const root = document.getElementById('cig-fan-body');
    if (!root) return;
    const $root = $(root);


    // ------------------------------------------------------------------ 小工具
    const norm = t => String(t ?? '').trim().toLowerCase();

    function fanRefOf(name) {
        const r = ctx.S().fanRefs?.[name];
        return r && r.name ? r : null;
    }

    function adoptedNames() {
        const s = ctx.S();
        const out = new Set();
        for (const [n, v] of Object.entries(s.characters || {})) {
            if (String(v?.source || '').startsWith('同人库')) out.add(n);
        }
        return out;
    }

    /** 内置库 + 用户自己导入的角色 */
    function allChars() {
        const cus = Array.isArray(ctx.S().customChars) ? ctx.S().customChars : [];
        // 自定义的排前面：内置库有 94 个、列表只显示前 24 行，不排前面的话刚导入的根本看不见
        return [...cus, ...FANCHARS];
    }
    function seriesList() {
        return [...new Set(allChars().map(c => c.series))];
    }

    /** 下载一个 JSON 文件（纯前端，不经过服务器） */
    function downloadJson(filename, obj) {
        try {
            const blob = new Blob([typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            ctx.setTimeout ? ctx.setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000) : setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
        } catch (e) {
            ctx.setStatus('下载失败：' + e.message, 'cig-err');
        }
    }

    function matches(c) {
        const s = ctx.S();
        if (s.fanSeries && c.series !== s.fanSeries) return false;
        if (s.fanRating && s.fanRating !== 'all' && c.rating !== s.fanRating) return false;
        const q = norm(s.fanQuery);
        if (!q) return true;
        const hay = [c.zh, c.en, c.jp, c.series, c.seriesTag, c.booru, ...(c.aliases || []), c.note].map(norm).join(' ');
        return q.split(/\s+/).every(w => hay.includes(w));
    }

    async function uploadImage(file) {
        const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(new Error('读取图片失败'));
            fr.readAsDataURL(file);
        });
        const b64 = dataUrl.split(',')[1] || '';
        if (!b64) throw new Error('图片内容为空');
        const ext = (String(file.name).match(/\.(png|jpe?g|webp|bmp)$/i) || ['.png'])[0].toLowerCase();
        const name = `cig_fan_${Date.now()}${ext}`;
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: ctx.getContext().getRequestHeaders(),
            body: JSON.stringify({ name, data: b64 }),
        });
        if (!res.ok) throw new Error(`上传失败（${res.status}）：${(await res.text()).slice(0, 120)}`);
        const j = await res.json();
        return { path: String(j.path || ''), name };
    }

    // ------------------------------------------------------------------ 动作
    function adopt(c, quiet = false) {
        const s = ctx.S();
        s.characters[c.zh] = {
            identity: fanIdentityTags(c),
            // 原作里就是小孩的角色：建档时把标记一起写进去，裸体兜底会自动跳过她们
            ...(c.minor ? { minor: true } : {}),
            source: `同人库·${c.series}`,
            outfit: s.characters[c.zh]?.outfit && s.outfits[s.characters[c.zh].outfit] ? s.characters[c.zh].outfit : c.outfitName,
        };
        if (!s.outfits[c.outfitName]) s.outfits[c.outfitName] = { tags: c.outfit, base: c.outfitName };
        s.fanSavedIds = [...new Set([...(s.fanSavedIds || []), c.id])];
        // 顺手把名字映射补上（词库不认识中文名，映射让提示词里的「胡桃」变成 booru tag）
        if (!s.fanNameMap || typeof s.fanNameMap !== 'object') s.fanNameMap = {};
        for (const a of [c.zh, c.en, ...(c.aliases || [])]) {
            const k = norm(a);
            if (k) s.fanNameMap[k] = c.booru;
        }
        // 外号单独存一份：正文里出现外号时要能认出「是同一个人」，而不只是改写提示词
        if (!s.fanAliases || typeof s.fanAliases !== 'object') s.fanAliases = {};
        s.fanAliases[c.zh] = [...new Set([c.zh, c.en, ...(c.aliases || [])].map(x => String(x).trim()).filter(x => x.length >= 2))];
        ctx.save();
        if (!quiet) {
            ctx.refresh();
            render();
        }
    }

    function removeAdopt(c) {
        const s = ctx.S();
        delete s.characters[c.zh];
        delete s.fanRefs[c.zh];
        delete s.fanAliases[c.zh];
        s.fanSavedIds = (s.fanSavedIds || []).filter(x => x !== c.id);
        // 没人再穿这套就把服装也删掉，免得服装库越堆越多
        const used = Object.values(s.characters || {}).some(v => v?.outfit === c.outfitName);
        if (!used) delete s.outfits[c.outfitName];
        ctx.save();
        ctx.refresh();
        render();
    }

    function removeRef(c) {
        const s = ctx.S();
        delete s.fanRefs[c.zh];
        ctx.save();
        render();
        ctx.setStatus(`已删除「${c.zh}」的参考图（图还留在酒馆的 user/files 里，不影响使用）`, 'cig-ok');
    }

    function setActive(c) {
        if (!ctx.S().characters[c.zh] && !fanRefOf(c.zh)) { adopt(c, true); }
        ctx.S().activeChar = c.zh;
        ctx.save();
        ctx.refresh();
        render();
        ctx.setStatus(`「${c.zh}」已设为当前出镜人物（也可以在「出图 → 出镜人物」里手动勾）`, 'cig-ok');
    }

    function refAbsOf(name) {
        const s = ctx.S();
        const root2 = String(s.img2imgRoot || '').trim().replace(/[\\/]+$/, '');
        const r = fanRefOf(name);
        if (!root2 || !r) return '';
        return root2 + (root2.includes('\\') ? '\\' : '/') + r.name;
    }

    // ------------------------------------------------------------------ 渲染
    function render() {
        const s = ctx.S();
        const all = allChars();
        const list = all.filter(matches);
        const shown = list.slice(0, PER_PAGE);
        const adopted = adoptedNames();
        // 每次输入都整体重建，所以先把焦点和光标位置记下来，建完再还回去（否则打一个字就被踢出输入框）
        const focused = document.activeElement && document.activeElement.id === 'cig-fan-q';
        const caret = focused ? document.activeElement.selectionStart : 0;
        $root.empty();

        // 顶部：搜索与筛选
        const bar = $('<div class="cig-fan-bar"></div>');
        const $q = $('<input type="text" id="cig-fan-q" placeholder="搜角色 / 作品 / 外号（中英日都行）" />').val(s.fanQuery || '');
        const $series = $('<select id="cig-fan-series"></select>');
        $series.append($('<option>').val('').text('全部作品'));
        for (const ser of seriesList()) $series.append($('<option>').val(ser).text(ser));
        $series.val(s.fanSeries || '');
        const $rating = $('<select id="cig-fan-rating"></select>');
        for (const [v, t] of [['all', '全部尺度'], ['sfw', '一般向'], ['nsfw', '成人向'], ['galgame', 'galgame']]) {
            $rating.append($('<option>').val(v).text(t));
        }
        $rating.val(s.fanRating || 'all');
        bar.append($q, $series, $rating);
        $root.append(bar);

        const stat = $('<div class="cig-hint"></div>').text(
            `共 ${all.length} 个角色（内置 ${FANCHARS.length} + 自定义 ${all.length - FANCHARS.length}）/ ${seriesList().length} 个作品，匹配 ${list.length} 个` +
            (list.length > PER_PAGE ? `（只显示前 ${PER_PAGE} 个，用搜索缩小范围）` : '') +
            `　|　已建档 ${adopted.size} 个`
        );
        $root.append(stat);

        // ---- 自定义角色：模板 / 导入 / 导出 ----
        const cus = $('<div class="cig-fan-refbox"></div>');
        cus.append($('<div class="cig-sub"></div>').text('自己加角色（导入 / 模板）'));
        cus.append($('<div class="cig-hint"></div>').text(
            '三条路都行：① 点「复制给 AI 的指令」丢给 ChatGPT/DeepSeek，让它按格式吐 JSON，再把结果粘到下面点「识别」；' +
            '② 点「下载模板」自己填好再导入；③ 直接把 AI 输出的 JSON / CSV /「中文名: … 外观: …」段落粘进来。'
        ));
        const mkCusBtn = (id, label, fn) => {
            const b = $('<button class="cig-btn" id="' + id + '"></button>').text(label);
            b.on('click', () => ctx.withBusy(async () => fn()));
            return b;
        };
        const cusRow1 = $('<div class="cig-row"></div>');
        cusRow1.append(mkCusBtn('cig-cus-tpl', '下载模板', () => {
            downloadJson('同人角色模板.json', TEMPLATE_OBJECT);
            ctx.setStatus('模板已下载 —— 填好保存成 .json 再导入；也可以把这个文件丢给别的 AI 让它照格式生成', 'cig-ok');
        }));
        cusRow1.append(mkCusBtn('cig-cus-ai', '复制给 AI 的指令', async () => {
            try {
                await navigator.clipboard.writeText(AI_PROMPT_TEXT);
                ctx.setStatus('已复制指令 —— 粘到任意 AI 里，把「【这里填你要的角色】」换成你想要的角色，它会吐 JSON 给你', 'cig-ok');
            } catch (e) {
                console.log(AI_PROMPT_TEXT);
                ctx.setStatus('复制失败（浏览器不给权限），已把指令打到控制台，手动复制即可', 'cig-err');
            }
        }));
        cus.append(cusRow1);

        const cusRow2 = $('<div class="cig-row"></div>');
        const $cusFile = $('<input type="file" id="cig-cus-file" accept=".json,.csv,.tsv,.txt,application/json,text/plain" style="display:none" />');
        cusRow2.append(mkCusBtn('cig-cus-import', '导入文件', () => $cusFile.trigger('click')));
        cusRow2.append(mkCusBtn('cig-cus-export', '导出我的自定义角色', () => {
            const mine = ctx.S().customChars || [];
            if (!mine.length) { ctx.setStatus('还没有自定义角色可导出', 'cig-err'); return; }
            downloadJson('我的同人角色.json', toExportText(mine));
            ctx.setStatus(`已导出 ${mine.length} 个自定义角色`, 'cig-ok');
        }));
        cus.append(cusRow2, $cusFile);

        const $paste = $('<textarea id="cig-cus-paste" rows="3" placeholder="把 AI 给的 JSON（或 CSV、或「中文名: … 外观: …」段落）粘到这里"></textarea>').val(s.fanPaste || '');
        cus.append($paste);
        const $preview = $('<div id="cig-cus-preview" class="cig-hint"></div>');
        if (Array.isArray(s.fanPreview) && s.fanPreview.length) {
            $preview.text(`识别到 ${s.fanPreview.length} 个角色：${s.fanPreview.map(x => x.zh).join('、')}` +
                (Array.isArray(s.fanPreviewErrors) && s.fanPreviewErrors.length ? `　（另有 ${s.fanPreviewErrors.length} 条问题）` : ''));
        } else if (Array.isArray(s.fanPreviewErrors) && s.fanPreviewErrors.length) {
            $preview.text('没识别到角色：' + s.fanPreviewErrors.join('；'));
        }
        cus.append($preview);

        const cusRow3 = $('<div class="cig-row"></div>');
        cusRow3.append(mkCusBtn('cig-cus-parse', '识别', () => {
            const text = String($paste.val() || '');
            const r = parseCustomChars(text);
            s.fanPaste = text;
            s.fanPreview = r.entries;
            s.fanPreviewErrors = r.errors;
            ctx.save();
            render();
            ctx.setStatus(r.entries.length
                ? `识别到 ${r.entries.length} 个角色${r.errors.length ? `（${r.errors.length} 条有问题，看下方提示）` : ''} —— 确认无误就点「确认导入」`
                : '没识别到角色：' + (r.errors[0] || ''), r.entries.length ? 'cig-ok' : 'cig-err');
        }));
        if (Array.isArray(s.fanPreview) && s.fanPreview.length) {
            cusRow3.append(mkCusBtn('cig-cus-confirm', `确认导入 ${s.fanPreview.length} 个`, () => {
                const merged = mergeCustomChars(ctx.S().customChars || [], s.fanPreview);
                s.customChars = merged.list;
                s.fanPreview = [];
                s.fanPreviewErrors = [];
                s.fanPaste = '';
                ctx.save();
                render();
                ctx.setStatus(`导入完成：新增 ${merged.added} 个、更新 ${merged.updated} 个自定义角色（列表里带「自定义」标记）`, 'cig-ok');
            }));
        }
        cus.append(cusRow3);
        if (Array.isArray(s.fanPreviewErrors) && s.fanPreviewErrors.length) {
            cus.append($('<div class="cig-hint"></div>').text('问题：' + s.fanPreviewErrors.join('；')));
        }
        $root.append(cus);

        $cusFile.on('change', function () {
            const f = this.files && this.files[0];
            if (!f) return;
            const el = this;
            ctx.withBusy(async () => {
                try {
                    const text = await f.text();
                    const r = parseCustomChars(text);
                    s.fanPaste = text.slice(0, 20000);
                    s.fanPreview = r.entries;
                    s.fanPreviewErrors = r.errors;
                    ctx.save();
                    render();
                    ctx.setStatus(r.entries.length
                        ? `从文件里识别到 ${r.entries.length} 个角色 —— 点「确认导入」写进库`
                        : '文件里没识别到角色：' + (r.errors[0] || ''), r.entries.length ? 'cig-ok' : 'cig-err');
                } catch (e) {
                    ctx.setStatus('读文件失败：' + e.message, 'cig-err');
                }
                $(el).val('');
            });
        });
        $paste.on('input', function () { s.fanPaste = String(this.value); ctx.save(); });

        // 本次出图用参考图
        const refBox = $('<div class="cig-fan-refbox"></div>');
        const $refNow = $('<input type="checkbox" id="cig-fan-refnow" />').prop('checked', !!s.refNow);
        refBox.append($('<label class="cig-check"></label>').append($refNow, $('<span></span>').text(' 本次出图用「参考图」重绘（img2img，只对存了参考图的角色生效）')));
        const $dn = $('<input type="range" min="0.15" max="1" step="0.05" id="cig-fan-dn" />').val(s.fanRefDenoise ?? 0.6);
        refBox.append($('<label class="cig-label"></label>').text(`参考图重绘幅度 denoise ${Number(s.fanRefDenoise ?? 0.6).toFixed(2)}（越低越像参考图）`));
        refBox.append($dn);
        const withRef = all.filter(c => fanRefOf(c.zh)).map(c => c.zh);
        refBox.append($('<div class="cig-hint"></div>').text(
            withRef.length ? `已有参考图：${withRef.join('、')}` : '还没有任何角色存参考图 —— 点角色右边的「参考图」上传一张，之后出图就能照着它画'
        ));
        $root.append(refBox);

        // 角色列表
        const listBox = $('<div class="cig-fan-list"></div>');
        for (const c of shown) {
            const row = $('<div class="cig-fan-row"></div>');
            const info = $('<div class="cig-fan-info"></div>');
            const badges = [];
            if (adopted.has(c.zh)) badges.push('已建档');
            if (fanRefOf(c.zh)) badges.push('有参考图');
            if (s.activeChar === c.zh) badges.push('当前出镜');
            if (c.minor) badges.push('未成年·不默认裸体');
            if (c.custom) badges.push('自定义');
            info.append($('<div class="cig-fan-name"></div>').text(`${c.zh}　${c.en}`));
            info.append($('<div class="cig-fan-sub"></div>').text(`${c.series}　${c.booru}${badges.length ? '　[' + badges.join('·') + ']' : ''}`));
            info.append($('<div class="cig-fan-note"></div>').text(c.note));
            const acts = $('<div class="cig-fan-acts"></div>');
            const mk = (id, label, fn, cls = '') => {
                const b = $(`<button class="cig-btn ${cls}" id="${id}"></button>`).text(label);
                b.on('click', () => ctx.withBusy(async () => fn()));
                return b;
            };
            acts.append(mk(`cig-fan-adopt-${c.id}`, adopted.has(c.zh) ? '重建档' : '一键建档', () => {
                adopt(c);
                ctx.setStatus(`已建档「${c.zh}」：身份=${fanIdentityTags(c).slice(0, 60)}…　标志性服装=${c.outfitName}`, 'cig-ok');
            }));
            acts.append(mk(`cig-fan-active-${c.id}`, '设为出镜', () => setActive(c)));
            const $file = $(`<input type="file" id="cig-fan-file-${c.id}" accept="image/*" style="display:none" />`);
            acts.append(mk(`cig-fan-ref-${c.id}`, '参考图', () => { $file.trigger('click'); }));
            acts.append($file);
            $file.on('change', function () {
                const f = this.files && this.files[0];
                if (!f) return;
                const el = this;
                ctx.withBusy(async () => {
                    if (!ctx.S().characters[c.zh]) adopt(c, true);
                    const up = await uploadImage(f);
                    ctx.S().fanRefs[c.zh] = { path: up.path, name: up.name };
                    ctx.save();
                    $(el).val('');
                    render();
                    ctx.setStatus(`「${c.zh}」参考图已就绪（勾上「本次出图用参考图重绘」就会走图生图）`, 'cig-ok');
                });
            });
            if (fanRefOf(c.zh)) acts.append(mk(`cig-fan-refdel-${c.id}`, '删参考图', () => removeRef(c)));
            if (c.custom) acts.append(mk(`cig-fan-delcus-${c.id}`, '删除自定义', () => {
                const s = ctx.S();
                s.customChars = (s.customChars || []).filter(x => (x.booru || x.zh) !== (c.booru || c.zh));
                ctx.save();
                render();
                ctx.setStatus(`已从自定义库里删除「${c.zh}」`, 'cig-ok');
            }));
            if (adopted.has(c.zh)) acts.append(mk(`cig-fan-del-${c.id}`, '删档案', () => {
                removeAdopt(c);
                ctx.setStatus(`已删除「${c.zh}」的角色档案${fanRefOf(c.zh) ? '与参考图' : ''}`, 'cig-ok');
            }));
            row.append(info, acts);
            listBox.append(row);
        }
        if (!shown.length) listBox.append($('<div class="cig-hint"></div>').text('没有匹配的角色 —— 换个关键词，或者把筛选调回「全部作品」。'));
        $root.append(listBox);

        const tail = $('<div class="cig-hint"></div>').text(
            '建档 = 把 booru 角色 tag + 外观 tag 写进「角色档案」、把标志性服装写进「服装库」；' +
            '之后正文/世界书里出现她的名字（或外号）就会自动套用。想换装就在「一键换装出图」里选别的衣服。'
        );
        $root.append(tail);

        // 事件
        $q.on('input', function () { ctx.S().fanQuery = String(this.value); ctx.save(); render(); });
        $series.on('change', function () { ctx.S().fanSeries = String(this.value); ctx.save(); render(); });
        $rating.on('change', function () { ctx.S().fanRating = String(this.value); ctx.save(); render(); });
        $refNow.on('change', function () {
            ctx.S().refNow = !!this.checked;
            ctx.save();
            ctx.setStatus(this.checked
                ? '本次出图会尝试用「参考图」重绘（只有存了参考图、且她是画面主体时才生效）'
                : '已关掉参考图重绘，回到普通文生图', 'cig-ok');
        });
        $dn.on('input', function () {
            ctx.S().fanRefDenoise = Number(this.value);
            ctx.save();
            $dn.prev('label').text(`参考图重绘幅度 denoise ${Number(this.value).toFixed(2)}（越低越像参考图）`);
        });
        if (focused) {
            const el = document.getElementById('cig-fan-q');
            if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* 无所谓 */ } }
        }
    }

    render();
    console.log(`[CharImageGen] 同人角色库已挂载：${FANCHARS.length} 个角色 / ${FANCHAR_SERIES.length} 个作品`);
    return { render, adopt, removeAdopt, refAbsOf, fanRefOf };
}
