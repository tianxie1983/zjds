#!/usr/bin/env node
// scripts/pconline-links.js —— 抓 PConline 报价库列表页，按「型号」匹配 data/parts.js 配件，生成/更新 scripts/pconline-links.json
// 作为第二数据源链接映射（双源互为备份 + 交叉校验）。列表页价格虽是动态加载，但「产品名 + 详情页链接」是静态的，可稳定提取。
// 特性：
//   - 断点续跑：pconline-links.json 已有映射的配件跳过，可反复运行补全。
//   - 抗限流：请求间延时(默认 2.5s) + 503/429 重试；PConline 对连续请求会 503。
//   - 型号校验：产品名(去空格/连字符)包含配件型号核心才采用，降低误配。
//   - 覆盖率取决于 PConline 列表页当前展示的产品；未覆盖配件保持 ZOL 单源（不影响）。
// 用法: node scripts/pconline-links.js   （可加 REPO_ROOT 环境变量）
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const ROOT = process.env.REPO_ROOT || path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parts = require(path.join(ROOT, 'data/parts.js')).parts;
let zolLinks = {};
try { zolLinks = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/zol-links.json'), 'utf8')); } catch (e) {}

const outFile = path.join(ROOT, 'scripts/pconline-links.json');
let outLinks = {};
try { outLinks = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) {}

const argv = process.argv.slice(2);
function argOf(flag, def) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; }
const RESET = argv.includes('--reset');
if (RESET) { outLinks = {}; console.log('[reset] 清空已有映射，重新生成'); }

// 仅对「型号唯一、不易跨品牌/跨型号混淆」的类别自动建图。
// 主板(芯片组如B760M)、内存(频率如6000)、电源(功率如650W)、机箱的"型号"不够唯一，易误配，暂不自动建（保持 ZOL 单源）。
const AUTO_CATS = ['cpu', 'gpu'];

// 各类别对应的 PConline 列表页（类别 slug 已实测）
const LIST_PAGES = {
  cpu: ['cpu', 'cpu/intel', 'cpu/amd'],
  gpu: ['vga'],
  motherboard: ['mb'],
  memory: ['memory'],
  ssd: ['ssd'],
  psu: ['power'],
  chassis: ['case'],
};

// 型号核心：最长的、含≥3位数字的字母数字 token
function modelKey(name) {
  const toks = (name.toUpperCase().match(/[A-Z]*\d[A-Z0-9]*/g) || [])
    .filter((t) => (t.match(/\d/g) || []).length >= 3)
    .sort((a, b) => b.length - a.length);
  return toks[0] || '';
}
// 完整 token 边界匹配：型号需作为独立 token 出现（前后为非字母数字），
// 避免 "7600" 误配 "7600X3D"、"4060" 误配 "4060Ti" 这类子串错配。
function tokenMatch(name, key) {
  const up = name.toUpperCase();
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^A-Z0-9])' + k + '([^A-Z0-9]|$)').test(up);
}

async function grab(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9', 'Referer': 'https://product.pconline.com.cn/' }, redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 503 || res.status === 429) { await sleep(3500 * attempt); continue; }
      if (res.status !== 200) return new Map();
      const html = new TextDecoder('gbk').decode(buf);
      const map = new Map();
      let m;
      const re = /<a[^>]*href="(\/\/product\.pconline\.com\.cn\/[\w-]+\/[\w-]+\/\d+\.html)"[^>]*>([^<]{2,60})<\/a>/g;
      while ((m = re.exec(html)) !== null) { const link = 'https:' + m[1]; if (!map.has(link)) map.set(link, m[2].trim()); }
      if (map.size < 20) {
        const re2 = /href="(\/\/product\.pconline\.com\.cn\/[\w-]+\/[\w-]+\/\d+\.html)"[^>]*(?:title|alt)="([^"]{2,60})"/g;
        while ((m = re2.exec(html)) !== null) { const link = 'https:' + m[1]; if (!map.has(link)) map.set(link, m[2].trim()); }
      }
      return map;
    } catch (e) { await sleep(2000 * attempt); }
  }
  return new Map();
}

(async () => {
  // 1) 抓各类别列表页，汇总 产品名->链接
  const byCat = {}; // category -> [{link,name}]
  for (const [cat, pages] of Object.entries(LIST_PAGES)) {
    const acc = new Map();
    for (const p of pages) {
      const url = `https://product.pconline.com.cn/${p}/`;
      const map = await grab(url);
      console.log(`[list] ${url} -> ${map.size} 个产品`);
      for (const [l, n] of map) if (!acc.has(l)) acc.set(l, n);
      await sleep(2500);
    }
    byCat[cat] = [...acc.entries()].map(([link, name]) => ({ link, name }));
  }

  // 2) 型号匹配
  let hit = 0;
  for (const part of parts) {
    if (outLinks[part.id]) continue;          // 已有映射，跳过（断点续跑）
    if (!zolLinks[part.id]) continue;          // 只处理有 ZOL 链接的配件
    if (!AUTO_CATS.includes(part.category)) continue; // 仅对型号唯一的类别自动建图
    const key = modelKey(part.name);
    if (!key) continue;
    const cand = (byCat[part.category] || []).find((it) => tokenMatch(it.name, key));
    if (cand) { outLinks[part.id] = cand.link; hit++; console.log(`[hit ] ${part.name} <${key}> -> ${cand.name}`); }
  }

  fs.writeFileSync(outFile, JSON.stringify(outLinks, null, 2) + '\n', 'utf8');
  const total = Object.keys(outLinks).length;
  const zolTotal = Object.keys(zolLinks).length;
  console.log(`\n本次新映射 ${hit} 个；pconline-links.json 共 ${total} 个映射（ZOL 有 ${zolTotal} 个，双源覆盖率 ${(total / zolTotal * 100).toFixed(0)}%）。`);
  console.log('未覆盖配件将保持 ZOL 单源，不影响站点。可反复运行本脚本补全（PConline 列表页会更新）。');
})();
