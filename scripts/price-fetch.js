#!/usr/bin/env node
// price-fetch.js —— 双源抓取：ZOL(主) + PConline(备)，按 scripts/*-links.json 精确抓参考价，生成 web/data.js
// 设计：data/parts.js 为唯一数据源；本脚本把「有链接」的配件价格刷新为公开参考价，其余保留手动价。
//   合并策略（双源互为备份 + 交叉校验）：
//     - 两源都成功：差异 <15% 取均值(priceSource='dual')；≥15% 取主源 ZOL 并告警(priceSource='zol', priceConflict=true)
//     - 仅 ZOL：priceSource='zol'（单源）
//     - 仅 PConline：priceSource='pconline'（ZOL 失败时备用源兜底）
//     - 都无：保留手动价 priceSource='manual'
//   防覆盖：任一自动源成功的比例 <0.5 时不覆盖 web/data.js（疑似限流/网络异常）。
// 代理：优先 ZOL_PROXY/HTTPS_PROXY 代理隧道（CI/境外 IP 被限流时必须），无代理回退直连。SKIP_PROXY=1 强制直连。
// 用法: node scripts/price-fetch.js
const fs = require('fs');
const path = require('path');
const { fetchZol } = require('./zol-fetch');
const { fetchPconline } = require('./pconline-fetch');

const ROOT = process.env.REPO_ROOT || path.resolve(__dirname, '..');

const data = require(path.join(ROOT, 'data/parts.js'));
const util = require(path.join(ROOT, 'utils/format.js'));

function loadLinks(file) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8')); }
  catch (e) { console.warn(`[warn] 读取 scripts/${file} 失败（该源将全部退化为手动/单源）:`, e.message); return {}; }
}
const zolLinks = loadLinks('zol-links.json');
const pconlineLinks = loadLinks('pconline-links.json'); // { partId: pconlineUrl }，可为空（退化为 ZOL 单源）

async function fetchZolPrice(url) {
  try {
    const r = await fetchZol(url, { timeout: 15000 });
    if (!r.ok) { console.warn('  [zol] 响应异常:', r.status || (r.netErr ? '网络错误:' + r.err : ''), url); return null; }
    if (r.price == null) { console.warn('  [zol] 未解析到参考价:', url); return null; }
    return r.price;
  } catch (e) { console.warn('  [zol] 请求失败:', url, e.message); return null; }
}

async function fetchPcPrice(url) {
  try {
    const r = await fetchPconline(url, { timeout: 15000 });
    if (!r.ok) { console.warn('  [pconline] 响应异常:', r.status || (r.netErr ? '网络错误:' + r.err : ''), url); return null; }
    if (r.price == null) { console.warn('  [pconline] 未解析到参考价:', url); return null; }
    return r.price;
  } catch (e) { console.warn('  [pconline] 请求失败:', url, e.message); return null; }
}

// 双源合并：返回 { price, source, conflict }
function mergePrice(zol, pc) {
  if (zol && pc) {
    const diff = Math.abs(zol - pc) / Math.min(zol, pc);
    if (diff < 0.15) return { price: Math.round((zol + pc) / 2), source: 'dual', conflict: false };
    // 差异过大：以主源 ZOL 为准，标记冲突供人工复核
    return { price: zol, source: 'zol', conflict: true };
  }
  if (zol) return { price: zol, source: 'zol', conflict: false };
  if (pc) return { price: pc, source: 'pconline', conflict: false }; // ZOL 缺失，备用源兜底
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const updated = data.parts.map((p) => ({ ...p }));
  let autoCount = 0, dualCount = 0, pcFallbackCount = 0, manualCount = 0;
  let expectedAuto = 0; // 有任一链接（应被自动抓取）的配件数
  const report = [];
  const conflicts = [];
  const zolCache = {};
  const pcCache = {};

  for (const part of updated) {
    const zolUrl = zolLinks[part.id];
    const pcUrl = pconlineLinks[part.id];
    if (!zolUrl && !pcUrl) {
      part.priceSource = 'manual';
      manualCount++;
      report.push(`[手动] ${part.name} -> 保留 ¥${part.price}`);
      continue;
    }
    expectedAuto++;

    let zolPrice = null, pcPrice = null;
    if (zolUrl) {
      zolPrice = zolCache[zolUrl];
      if (zolPrice === undefined) { zolPrice = await fetchZolPrice(zolUrl); zolCache[zolUrl] = zolPrice; await sleep(800); }
    }
    if (pcUrl) {
      pcPrice = pcCache[pcUrl];
      if (pcPrice === undefined) { pcPrice = await fetchPcPrice(pcUrl); pcCache[pcUrl] = pcPrice; await sleep(1500); } // PConline 频率敏感，加大间隔
    }

    const merged = mergePrice(zolPrice, pcPrice);
    if (merged) {
      part.price = merged.price;
      part.priceSource = merged.source;
      if (merged.conflict) part.priceConflict = true;
      // 保留主链接（优先 ZOL），便于前端「参考报价/详情页跳转」
      part.url = zolUrl || pcUrl;
      if (zolPrice) part.priceZol = zolPrice;
      if (pcPrice) part.pricePconline = pcPrice;
      autoCount++;
      if (merged.source === 'dual') dualCount++;
      if (merged.source === 'pconline') pcFallbackCount++;
      const tag = merged.source === 'dual' ? '双源' : (merged.source === 'pconline' ? 'PCon' : 'ZOL ');
      let line = `[${tag}] ${part.name} -> ¥${merged.price}`;
      if (zolPrice) line += ` (ZOL¥${zolPrice}`;
      if (zolPrice && pcPrice) line += ` / PConline¥${pcPrice}`;
      else if (pcPrice) line += ` (PConline¥${pcPrice}`;
      if (zolPrice || pcPrice) line += `)`;
      if (merged.conflict) { line += ' ⚠️双源差异≥15%，取ZOL'; conflicts.push(`${part.name}: ZOL¥${zolPrice} vs PConline¥${pcPrice}`); }
      report.push(line);
    } else {
      part.priceSource = 'manual';
      manualCount++;
      report.push(`[手动] ${part.name} -> 保留 ¥${part.price}  (两源均抓取失败)`);
    }
  }

  // 防覆盖保护：任一自动源成功的比例过低（疑似限流/网络异常），不覆盖 web/data.js。
  const ratio = expectedAuto > 0 ? autoCount / expectedAuto : 1;
  if (ratio < 0.5) {
    console.error(`\n[price-fetch] ⚠️ 仅成功抓取 ${autoCount}/${expectedAuto} 款（比例 ${ratio.toFixed(2)} < 0.5）`);
    console.error('[price-fetch] 疑似被限流或网络异常；为保留上次完整数据，本次不覆盖 web/data.js。');
    process.exit(1);
  }

  const meta = {
    updatedAt: new Date().toISOString(),
    source: '中关村在线(ZOL)+太平洋科技(PConline)公开参考价',
    autoCount,
    dualCount,
    pcFallbackCount,
    manualCount,
    total: updated.length,
    note: '价格随行情波动，仅供参考；双源(差异<15%)取均值，未匹配到公开报价的配件保留原价。',
  };
  if (conflicts.length) meta.priceConflicts = conflicts;

  // 生成 web/data.js（复用 utils/format.js 的函数，注入更新后的 parts 与 meta）
  let evSrc = util.evaluateBuild.toString().replace(/data\./g, '');
  let fmSrc = util.formatMoney.toString();
  let rwSrc = util.roundWatt.toString();
  const out = `// 本文件由 scripts/price-fetch.js 自动生成（复用 data/parts.js 与 utils/format.js）
window.PC = (function () {
  const categories = ${JSON.stringify(data.categories, null, 2)};
  const parts = ${JSON.stringify(updated, null, 2)};
  const presets = ${JSON.stringify(data.presets, null, 2)};
  const meta = ${JSON.stringify(meta, null, 2)};

  function categoryOf(key) { return categories.find(c => c.key === key); }
  function partsOfCategory(key) { return parts.filter(p => p.category === key); }
  function partById(id) { return parts.find(p => p.id === id); }

  ${fmSrc}
  ${rwSrc}
  ${evSrc}

  return { categories, parts, presets, meta, categoryOf, partsOfCategory, partById, formatMoney, roundWatt, evaluateBuild };
})();
`;
  const dest = path.join(ROOT, 'web', 'zjds', 'data.js');
  fs.writeFileSync(dest, out, 'utf8');
  console.log(`\n写入 ${dest}`);
  console.log(`更新统计: 自动 ${autoCount} 款(双源 ${dualCount} / PConline兜底 ${pcFallbackCount} / 仅ZOL ${autoCount - dualCount - pcFallbackCount}), 手动保留 ${manualCount} 款, 共 ${updated.length} 款`);
  if (conflicts.length) { console.log('⚠️ 双源差异≥15%（取ZOL，建议复核）:'); conflicts.forEach(c => console.log('   ' + c)); }
  console.log('--- 明细 ---');
  console.log(report.join('\n'));
})();
