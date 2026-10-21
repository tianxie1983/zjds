#!/usr/bin/env node
// scripts/pconline-fetch.js —— PConline(太平洋科技)产品详情页「参考报价」抓取，作为第二数据源。
// 与 zol-fetch.js 同风格：代理隧道优先 / 直连回退、编码自适应(UTF-8 详情页 / GBK 列表页)、抗限流重试。
// 关键点：
//   - 详情页 URL 形如 https://product.pconline.com.cn/{类别}/{品牌}/{id}.html，价格在「参考报价：￥数字」处。
//   - 必须带 Referer: https://product.pconline.com.cn/ 且控制请求频率，否则国内/境外 IP 都可能被 503 限流。
//   - CI(美国机房 IP)与 ZOL 一样可能被限流，走同一 ZOL_PROXY/HTTPS_PROXY 代理隧道；SKIP_PROXY=1 强制直连。
// 用法: const { fetchPconline } = require('./pconline-fetch'); const r = await fetchPconline(url, { timeout: 15000 });
// 返回 { ok, status, limited, netErr, price, title, html, via }
const http = require('http');
const tls = require('tls');
const { TextDecoder } = require('util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function getProxy() {
  if (process.env.SKIP_PROXY === '1') return null;
  const p = process.env.ZOL_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy ||
            process.env.HTTP_PROXY || process.env.http_proxy;
  if (!p) return null;
  try {
    const u = new URL(p);
    const auth = (u.username || u.password) ? `${u.username}:${u.password}` : null;
    return { host: u.hostname, port: parseInt(u.port, 10) || 80, auth };
  } catch { return null; }
}

// 按 content-type / meta charset 选择编码（详情页多为 UTF-8，列表页为 GBK）
function decodeHtml(buf, contentType) {
  let cs = '';
  const m = (contentType || '').match(/charset=["']?([\w-]+)/i);
  if (m) cs = m[1].toLowerCase();
  if (!cs) {
    const head = buf.slice(0, 3000).toString('latin1').match(/charset=["']?([\w-]+)/i);
    if (head) cs = head[1].toLowerCase();
  }
  if (cs.indexOf('gb') === 0 || cs === 'gb2312' || cs === 'gbk') cs = 'gbk';
  else if (!cs) cs = 'utf-8';
  try { return new TextDecoder(cs, { fatal: false }).decode(buf); } catch (e) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch (e2) { return ''; }
  }
}

function extractTitle(html) {
  const i = html.indexOf('<title>');
  return i >= 0 ? html.slice(i + 7, html.indexOf('</title>', i)).trim() : '';
}

// 「参考报价」后取首个 2 位以上数字为参考价（详情页结构：参考报价：￥3799）
function extractRefPrice(html) {
  const i = html.indexOf('参考报价');
  if (i < 0) return null;
  const seg = html.slice(i, i + 260);
  const m = seg.match(/(\d[\d,]{2,})/);
  if (!m) return null;
  const v = parseInt(m[1].replace(/,/g, ''), 10);
  return v > 0 ? v : null;
}

function jitter(ms) { return ms + Math.floor(Math.random() * 800); }

// 经 HTTP CONNECT 隧道走代理抓取（支持代理 Basic 认证）
function tunnelGet(url, proxy, timeout) {
  return new Promise((resolve) => {
    const u = new URL(url);
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const onErr = (msg) => done({ ok: false, status: 0, limited: false, netErr: true, price: null, title: '', html: '', via: 'proxy', err: msg });
    const headers = proxy.auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') } : {};
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${u.hostname}:443`, headers });
    req.setTimeout(timeout, () => { req.destroy(); onErr('proxy connect timeout'); });
    req.on('connect', (res, sock) => {
      if (res.statusCode !== 200) { onErr('proxy CONNECT ' + res.statusCode); return; }
      const sock2 = tls.connect({ socket: sock, servername: u.hostname }, () => {
        const reqStr =
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.hostname}\r\n` +
          `User-Agent: ${UA}\r\n` +
          `Accept: text/html,application/xhtml+xml\r\n` +
          `Accept-Language: zh-CN,zh;q=0.9\r\n` +
          `Referer: https://product.pconline.com.cn/\r\n` +
          `Connection: close\r\n\r\n`;
        sock2.write(reqStr);
        const chunks = [];
        sock2.on('data', (d) => chunks.push(d));
        sock2.on('end', () => {
          const buf = Buffer.concat(chunks);
          const he = buf.indexOf('\r\n\r\n');
          const header = buf.slice(0, he).toString('latin1');
          const sm = header.match(/HTTP\/1\.[01] (\d+)/);
          const status = sm ? parseInt(sm[1], 10) : 0;
          const ct = (header.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || '';
          const body = he >= 0 ? buf.slice(he + 4) : buf;
          // 处理 chunked 之外的简单情况：若为 gzip 则 tunnel 路径少见，此处以明文为主
          const html = decodeHtml(body, ct);
          const limited = [403, 429, 503].includes(status);
          const price = extractRefPrice(html);
          done({ ok: price != null && !limited, status, limited, netErr: false, price, title: extractTitle(html), html, via: 'proxy' });
        });
        sock2.on('error', (e) => onErr(e.message));
      });
      sock2.setTimeout(timeout, () => { sock2.destroy(); onErr('tls timeout'); });
    });
    req.on('error', (e) => onErr(e.message));
    req.end();
  });
}

// Node 内置 fetch 直连，抗限流：完整头 + 失败重试（指数退避 + 抖动）
async function directGet(url, timeout, attempt = 1) {
  const MAX = 3;
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Referer': 'https://product.pconline.com.cn/',
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    const buf = Buffer.from(await res.arrayBuffer());
    const html = decodeHtml(buf, res.headers.get('content-type'));
    const limited = [403, 429, 503].includes(res.status);
    const price = extractRefPrice(html);
    // 成功标准：解析到参考价且未被限流（PConline 详情页常返 302 但响应体仍含完整页面+价格）
    if ((limited || !res.ok) && price == null && attempt < MAX) {
      await new Promise((r) => setTimeout(r, jitter(1200 * attempt)));
      return directGet(url, timeout, attempt + 1);
    }
    return { ok: price != null && !limited, status: res.status, limited, netErr: false, price, title: extractTitle(html), html, via: 'direct' };
  } catch (e) {
    if (attempt < MAX) {
      await new Promise((r) => setTimeout(r, jitter(1200 * attempt)));
      return directGet(url, timeout, attempt + 1);
    }
    return { ok: false, status: 0, limited: false, netErr: true, price: null, title: '', html: '', via: 'direct', err: e.message };
  }
}

async function fetchPconline(url, { timeout = 15000 } = {}) {
  const proxy = getProxy();
  if (proxy) {
    const r = await tunnelGet(url, proxy, timeout);
    if (r.netErr) {
      const d = await directGet(url, timeout);
      d.via = 'proxy-unreachable→direct';
      return d;
    }
    return r;
  }
  return await directGet(url, timeout);
}

module.exports = { getProxy, fetchPconline, extractRefPrice, extractTitle, decodeHtml };
