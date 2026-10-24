// 把 Word / PPT / Excel / PDF 渲染成每页一张图片（评测"文档好不好看"用）。
// 只在装了 Microsoft Office（或兼容的 WPS）的 Windows 上能用：PPT 用 PowerPoint 直接导出图片；
// Word / Excel 先转成 PDF，再用 PyMuPDF（python -m pip install pymupdf）把每页转成图片。
// 用法：node evals/render.js <文件> <输出文件夹> [最多几页]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PS = `param($in, $out, $kind, $max)
$ErrorActionPreference = 'Stop'
if ($kind -eq 'pptx') {
  $p = New-Object -ComObject PowerPoint.Application
  $p.AutomationSecurity = 3
  try {
    $pr = $p.Presentations.Open($in, $true, $false, $false)
    $n = [Math]::Min($pr.Slides.Count, [int]$max)
    for ($i = 1; $i -le $n; $i++) { $pr.Slides($i).Export((Join-Path $out ("p{0:d2}.png" -f $i)), 'PNG', 1280, 720) }
    Write-Output ("total=" + $pr.Slides.Count)
    $pr.Close()
  } finally { $p.Quit() }
} elseif ($kind -eq 'docx') {
  $w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0; $w.AutomationSecurity = 3
  try { $d = $w.Documents.Open($in, $false, $true); $d.ExportAsFixedFormat((Join-Path $out 'doc.pdf'), 17); $d.Close($false) } finally { $w.Quit() }
} elseif ($kind -eq 'xlsx') {
  $x = New-Object -ComObject Excel.Application; $x.Visible = $false; $x.DisplayAlerts = $false; $x.AutomationSecurity = 3
  try { $b = $x.Workbooks.Open($in, 0, $true); $b.ExportAsFixedFormat(0, (Join-Path $out 'doc.pdf')); $b.Close($false) } finally { $x.Quit() }
}`;

const PY = `import sys
import pymupdf as fitz
pdf, out, mx = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = fitz.open(pdf)
print('total=%d' % d.page_count)
for i, page in enumerate(d):
    if i >= mx: break
    page.get_pixmap(dpi=80).save('%s/p%02d.png' % (out, i + 1))`;

// 这次渲染开的 Office 进程（渲染前后对比进程号）：卡住时只结束它们，不动老板自己开着的 Word / Excel
const OFFICE = ['WINWORD', 'POWERPNT', 'EXCEL'];
const PWSH = (() => { try { execFileSync('pwsh', ['-NoProfile', '-Command', '1'], { windowsHide: true, stdio: 'ignore' }); return 'pwsh'; } catch (_) { return 'powershell'; } })();
// Python：先找装在用户目录里的（有的终端 PATH 里只有微软商店的占位 python），找不到再用 PATH 里的
const PYTHON = (() => {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
  try {
    const dirs = fs.readdirSync(base).filter((d) => /^Python3\d+$/.test(d)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
    for (const d of dirs) { const exe = path.join(base, d, 'python.exe'); if (fs.existsSync(exe)) return exe; }
  } catch (_) {}
  return 'python';
})();
function officePids() {
  try { return new Set(execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process ${OFFICE.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`], { encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean)); } catch (_) { return new Set(); }
}

function render(file, outDir, maxPages = 8) {
  file = path.resolve(file);
  fs.mkdirSync(outDir, { recursive: true });
  const ext = path.extname(file).slice(1).toLowerCase();
  const kind = { pptx: 'pptx', ppt: 'pptx', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', pdf: 'pdf' }[ext];
  if (!kind) throw new Error('不支持的格式：' + ext);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-render-'));
  try {
    let total = 0;
    if (kind !== 'pdf') {
      const ps = path.join(tmp, 'r.ps1');
      fs.writeFileSync(ps, '﻿' + PS);
      const before = officePids();
      try {
        // 用 PowerShell 7（pwsh）：在 Windows 自带的 PowerShell 5 里调 Word 会卡住（2026-10-24 实测）
        const out = execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, file, path.resolve(outDir), kind, String(maxPages)], { encoding: 'utf8', timeout: 120000, windowsHide: true });
        total = Number((out.match(/total=(\d+)/) || [])[1]) || 0;
      } catch (e) {
        for (const pid of officePids()) if (!before.has(pid)) { try { execFileSync('taskkill', ['/pid', pid, '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
        throw new Error('渲染失败或超时：' + path.basename(file));
      }
    }
    if (kind !== 'pptx') {
      const pdf = kind === 'pdf' ? file : path.join(path.resolve(outDir), 'doc.pdf');
      const py = path.join(tmp, 'r.py');
      fs.writeFileSync(py, PY);
      const out = execFileSync(PYTHON, ['-I', py, pdf, path.resolve(outDir), String(maxPages)], { encoding: 'utf8', timeout: 120000, windowsHide: true });
      total = Number((out.match(/total=(\d+)/) || [])[1]) || 0;
    }
    const pages = fs.readdirSync(outDir).filter((f) => /^p\d+\.png$/.test(f)).sort().map((f) => path.join(outDir, f));
    return { pages, total };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (require.main === module) {
  const [f, out, mx] = process.argv.slice(2);
  console.log(JSON.stringify(render(f, out, Number(mx) || 8), null, 2));
}
module.exports = { render };
