<#
    一键把 SD-WebUI 的词库复制到酒馆的 CharImageGen 扩展里。

    复制哪几个文件（存在才复制，缺了不报错）：
      · group_tags/zh_CN.yaml              —— 中文分类词库（动作/表情/镜头等 11 大类）
      · group_tags/custom.yaml             —— 你自己的自定义分类（有就复制）
      · tags/danbooru.csv                  —— danbooru 标签表（10 万 tag + 热度 + 别名）
      · tags/danbooru.zh_CN_SFW.csv        —— 中文 → 英文 对照表（GBK 编码也能读）
      · tags/danbooru.zh_CN.csv            —— 同上（全量版，有就一起复制）

    用法（三种都行）：
      1) 直接双击  导入词库.bat
      2) powershell -ExecutionPolicy Bypass -File 导入词库.ps1
      3) 自动找不到时手动指定：
         ... -SdWebUi "D:\你的sd-webui路径" -Tavern "D:\你的酒馆路径"

    可选开关：
      -WithE621    额外复制 e621.csv（兽向标签表）。默认不复制 ——
                   它不是 danbooru 那套 tag，对二次元模型基本是噪声。

    注意：这不是必须的。打开酒馆 🎨 面板 → 词库 →「导入词库文件」，直接选那几个 csv / yaml
    也一样，而且任何系统都能用。这个脚本只是省掉每次手选文件。
#>
param(
    [string]$SdWebUi = '',
    [string]$Tavern = '',
    [switch]$WithE621
)

$ErrorActionPreference = 'Stop'
function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Test-SdWebUi($dir) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { return $false }
    foreach ($sub in 'extensions\a1111-sd-webui-tagcomplete', 'extensions\sd-webui-prompt-all-in-one') {
        if (Test-Path -LiteralPath (Join-Path $dir $sub)) { return $true }
    }
    return $false
}

function Test-Tavern($dir) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $dir 'data\default-user\extensions'))
}

# 在固定磁盘里按目录名找：BFS + 深度上限 + 跳过系统目录，不扫全盘
$script:SkipNames = @(
    'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin',
    'System Volume Information', 'node_modules', '.git', '.cache', 'AppData', 'Recovery',
    'PerfLogs', 'MSOCache', 'Windows.old', 'anaconda3', 'miniconda3', 'models',
    'outputs', 'temp', 'tmp', 'cache', '__pycache__', 'venv', '.venv', 'site-packages',
    'dist-packages', 'Lib', 'DLLs', 'include', 'share'
)
function Find-Dir {
    param([string[]]$Patterns, [scriptblock]$Verify, [int]$MaxDepth = 3, [int]$MaxVisit = 20000)
    $drives = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' } | ForEach-Object { $_.Name })
    foreach ($d in $drives) {
        $queue = New-Object System.Collections.Queue
        $queue.Enqueue([pscustomobject]@{ Path = $d; Depth = 0 })
        $visited = 0
        while ($queue.Count -gt 0 -and $visited -lt $MaxVisit) {
            $visited++
            $cur = $queue.Dequeue()
            if ($cur.Depth -ge $MaxDepth) { continue }
            $children = @()
            try { $children = @(Get-ChildItem -LiteralPath $cur.Path -Directory -Force -ErrorAction SilentlyContinue) } catch { continue }
            foreach ($c in $children) {
                if ($script:SkipNames -contains $c.Name) { continue }
                try { if ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue } } catch { }
                foreach ($p in $Patterns) {
                    if ($c.Name -like $p -and (& $Verify $c.FullName)) { return $c.FullName }
                }
                $queue.Enqueue([pscustomobject]@{ Path = $c.FullName; Depth = $cur.Depth + 1 })
            }
        }
    }
    return ''
}

# 先浅扫（绝大多数安装就在 1-3 层），找不到再深扫
function Find-Deep {
    param([string[]]$Patterns, [scriptblock]$Verify, [string]$What)
    Say "  浅扫（3 层内）…" 'DarkGray'
    $hit = Find-Dir -Patterns $Patterns -Verify $Verify -MaxDepth 3 -MaxVisit 20000
    if ($hit) { return $hit }
    Say "  没找到，深扫（7 层内，可能要一两分钟）…" 'DarkGray'
    return (Find-Dir -Patterns $Patterns -Verify $Verify -MaxDepth 7 -MaxVisit 200000)
}

Say ""
Say "=== CharImageGen 词库导入 ===" 'Cyan'

if (-not (Test-SdWebUi $SdWebUi)) {
    Say "[1/3] 没指定 SD-WebUI 路径，自动找…"
    $SdWebUi = Find-Deep -Patterns @('*webui*', 'stable-diffusion*') -Verify { param($p) Test-SdWebUi $p } -What 'SD-WebUI'
}
if (-not (Test-SdWebUi $SdWebUi)) {
    Say "  ✗ 没找到 SD-WebUI 目录" 'Red'
    Say "    要找的是带 extensions\a1111-sd-webui-tagcomplete 或 extensions\sd-webui-prompt-all-in-one 的那个目录" 'DarkGray'
    Say "    请手动指定：  .\导入词库.ps1 -SdWebUi ""D:\你的sd-webui路径""" 'Yellow'
    exit 1
}
Say "  SD-WebUI : $SdWebUi" 'Green'

if (-not (Test-Tavern $Tavern)) {
    Say "[2/3] 没指定酒馆路径，自动找…"
    $Tavern = Find-Deep -Patterns @('sillytavern', 'SillyTavern*', '*酒馆*') -Verify { param($p) Test-Tavern $p } -What '酒馆'
}
if (-not (Test-Tavern $Tavern)) {
    Say "  ✗ 没找到酒馆目录" 'Red'
    Say "    要找的是带 data\default-user\extensions 的那个目录（就是有 server.js / Start.bat 的那层）" 'DarkGray'
    Say "    请手动指定：  .\导入词库.ps1 -Tavern ""D:\你的酒馆路径""" 'Yellow'
    exit 1
}
$ext = Join-Path $Tavern 'data\default-user\extensions\CharImageGen'
if (-not (Test-Path -LiteralPath $ext)) {
    Say "  ✗ 酒馆里还没装 CharImageGen：$ext" 'Red'
    Say "    先把 CharImageGen 插件文件夹放进 data\default-user\extensions\ 再跑这个脚本" 'Yellow'
    exit 1
}
Say "  酒馆扩展 : $ext" 'Green'

Say "[3/3] 开始复制词库文件…"
$dest = Join-Path $ext 'tags'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$map = @(
    @{ Src = 'extensions\sd-webui-prompt-all-in-one\group_tags\zh_CN.yaml'; Dst = 'zh_CN.yaml'; Label = '中文分类词库' },
    @{ Src = 'extensions\sd-webui-prompt-all-in-one\group_tags\custom.yaml'; Dst = 'custom.yaml'; Label = '自定义分类词库' },
    @{ Src = 'extensions\a1111-sd-webui-tagcomplete\tags\danbooru.csv'; Dst = 'danbooru.csv'; Label = 'danbooru 标签表' },
    @{ Src = 'extensions\a1111-sd-webui-tagcomplete\tags\danbooru.zh_CN.csv'; Dst = 'danbooru.zh_CN.csv'; Label = '中文对照(全量)' },
    @{ Src = 'extensions\a1111-sd-webui-tagcomplete\tags\danbooru.zh_CN_SFW.csv'; Dst = 'danbooru.zh_CN_SFW.csv'; Label = '中文对照(SFW)' }
)
if ($WithE621) {
    $map += @{ Src = 'extensions\a1111-sd-webui-tagcomplete\tags\e621.csv'; Dst = 'e621.csv'; Label = 'e621 标签表(兽向)' }
}

$copied = 0
foreach ($m in $map) {
    $from = Join-Path $SdWebUi $m.Src
    if (-not (Test-Path -LiteralPath $from)) { Say ("  · 跳过 " + $m.Label + "（SD-WebUI 里没有这个文件）") 'DarkGray'; continue }
    $to = Join-Path $dest $m.Dst
    Copy-Item -LiteralPath $from -Destination $to -Force
    $size = [math]::Round((Get-Item -LiteralPath $to).Length / 1MB, 2)
    Say ("  ✓ " + $m.Label + " → tags\" + $m.Dst + "  (" + $size + " MB)") 'Green'
    $copied++
}

# 之前如果复制过 e621 而这次没开开关，把旧的挪走，免得混进词库
$oldE621 = Join-Path $dest 'e621.csv'
if (-not $WithE621 -and (Test-Path -LiteralPath $oldE621)) {
    Remove-Item -LiteralPath $oldE621 -Force
    Say "  · 移除了旧版留下的 e621.csv（不想混进兽向标签；要的话加 -WithE621）" 'DarkGray'
}

Say ""
if ($copied -eq 0) {
    Say "一个文件都没复制到，请确认 SD-WebUI 路径。" 'Red'
    exit 1
}
Say "完成，共 $copied 个文件。" 'Cyan'
Say "接下来：刷新酒馆页面（F5）→ 打开 🎨 面板 → 词库 →「从插件 tags/ 加载」。" 'Cyan'
Say ""
