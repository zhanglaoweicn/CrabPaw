/**
 * templates.js — 海报 HTML 模板（双层渲染的上层：确定性文字排版）
 *
 * 每个模板是一个函数 (ctx) => 完整 HTML 字符串。ctx 由 poster 引擎装配：
 *   { W, H, title, subtitle, bullets, price, cta, brand, bgDataUrl, productDataUrl }
 * 设计原则：
 *   - 文字 100% 确定性渲染（电话/价格/日期绝不错字）——酷炫靠背景与光效
 *   - 产品照片原样合成（object-fit: contain + 投影），绝不重绘
 *   - 品牌色贯穿：主色用于标题/色块/CTA，落款固定品牌条
 * 模板以 1080 宽为设计基准，随 W/H 等比缩放（根字号 = W/1080*16）。
 */
const { escapeHtml } = require('./escape');

function bulletsHtml(bullets, accent) {
  if (!bullets || bullets.length === 0) return '';
  return `<ul class="bullets">${bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
}

/** 品牌落款条（所有模板共用——品牌一致性的载体） */
function brandFooter(brand) {
  const b = brand || {};
  const parts = [b.companyName, b.slogan, b.contact && b.contact.phone].filter(Boolean);
  if (parts.length === 0) return '';
  return `<div class="brand-footer"><span>${parts.map(p => escapeHtml(p)).join('</span><span class="dot">·</span><span>')}</span></div>`;
}

/** 产品图层（原样合成 + CSS 投影/倒影，不改像素） */
function productLayer(productDataUrl, accent) {
  if (!productDataUrl) return '';
  return `<img class="product" src="${productDataUrl}" alt="" style="--accent:${accent}" />`;
}

/** 产品促销海报：大标题 + 卖点 + 价格 + CTA */
function productPromo(ctx) {
  const { W, H, title, subtitle, bullets, price, cta, brand, bgDataUrl, productDataUrl, accent } = ctx;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${W}px; height:${H}px; overflow:hidden;
    font-family:'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif; }
  .stage { position:relative; width:${W}px; height:${H}px; }
  .bg { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .bg::after { content:''; position:absolute; inset:0;
    background:linear-gradient(180deg, rgba(0,0,0,.05) 0%, rgba(0,0,0,.55) 72%); }
  .product { position:absolute; right:${W * 0.055}px; bottom:${H * 0.24}px;
    width:${Math.round(W * 0.34)}px; max-height:${Math.round(H * 0.34)}px; object-fit:contain;
    filter: drop-shadow(0 18px 28px rgba(0,0,0,.45)); }
  .content { position:absolute; left:${W * 0.07}px; top:${H * 0.09}px; width:${Math.round(W * 0.62)}px; }
  .title { color:#fff; font-weight:800; line-height:1.18;
    font-size:${Math.round(W / 15)}px; text-shadow:0 4px 18px rgba(0,0,0,.5); }
  .title em { color:${accent}; font-style:normal; }
  .subtitle { color:#e8eef7; margin-top:${Math.round(H * 0.02)}px;
    font-size:${Math.round(W / 28)}px; line-height:1.5; }
  .bullets { list-style:none; margin-top:${Math.round(H * 0.028)}px; }
  .bullets li { color:#f4f7fb; font-size:${Math.round(W / 36)}px; line-height:1.75;
    padding-left:1.2em; position:relative; }
  .bullets li::before { content:'▸'; color:${accent}; position:absolute; left:0; }
  .price { margin-top:${Math.round(H * 0.025)}px; color:${accent};
    font-size:${Math.round(W / 12)}px; font-weight:800;
    text-shadow:0 3px 14px rgba(0,0,0,.45); }
  .cta { display:inline-block; margin-top:${Math.round(H * 0.02)}px; padding:${Math.round(W * 0.014)}px ${Math.round(W * 0.032)}px;
    background:${accent}; color:#fff; border-radius:999px;
    font-size:${Math.round(W / 30)}px; font-weight:700; letter-spacing:2px; }
  .brand-footer { position:absolute; left:0; right:0; bottom:0; padding:${Math.round(H * 0.018)}px ${W * 0.07}px;
    background:rgba(0,0,0,.5); color:#dfe6ef; font-size:${Math.round(W / 40)}px;
    display:flex; gap:8px; align-items:center; }
  .brand-footer .dot { opacity:.5 }
  </style></head><body>
  <div class="stage">
    ${bgDataUrl ? `<img class="bg" src="${bgDataUrl}" />` : `<div class="bg" style="background:linear-gradient(160deg,#101c33 0%,#182b4d 60%,#1f3a6e 100%)"></div>`}
    ${productLayer(productDataUrl, accent)}
    <div class="content">
      <div class="title">${escapeHtml(title || '')}</div>
      ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ''}
      ${bulletsHtml(bullets, accent)}
      ${price ? `<div class="price">${escapeHtml(price)}</div>` : ''}
      ${cta ? `<div class="cta">${escapeHtml(cta)}</div>` : ''}
    </div>
    ${brandFooter(brand)}
  </div>
  </body></html>`;
}

/** 节日营销海报：节日氛围头图 + 促销信息块 */
function festival(ctx) {
  const { W, H, title, subtitle, bullets, price, cta, brand, bgDataUrl, accent } = ctx;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${W}px; height:${H}px; overflow:hidden;
    font-family:'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif; }
  .stage { position:relative; width:${W}px; height:${H}px; }
  .bg { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .bg::after { content:''; position:absolute; inset:0;
    background:linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.62) 78%); }
  .head { position:absolute; top:${H * 0.08}px; left:0; right:0; text-align:center; }
  .festival-tag { display:inline-block; padding:${Math.round(W * 0.012)}px ${Math.round(W * 0.03)}px;
    border:1px solid ${accent}; color:${accent}; border-radius:999px;
    font-size:${Math.round(W / 34)}px; letter-spacing:6px; }
  .title { color:#fff; font-weight:800; margin-top:${Math.round(H * 0.022)}px;
    font-size:${Math.round(W / 11)}px; text-shadow:0 4px 20px rgba(0,0,0,.55); }
  .panel { position:absolute; left:${W * 0.07}px; right:${W * 0.07}px; bottom:${H * 0.13}px;
    background:rgba(255,255,255,.94); border-radius:${Math.round(W * 0.03)}px;
    padding:${Math.round(W * 0.045)}px ${Math.round(W * 0.05)}px; }
  .subtitle { color:#1c2733; font-size:${Math.round(W / 26)}px; line-height:1.6; font-weight:700; }
  .bullets { list-style:none; margin-top:${Math.round(W * 0.02)}px; }
  .bullets li { color:#3a4653; font-size:${Math.round(W / 34)}px; line-height:1.8;
    padding-left:1.2em; position:relative; }
  .bullets li::before { content:'◆'; color:${accent}; position:absolute; left:0; font-size:.7em; top:.45em; }
  .price { color:${accent}; font-size:${Math.round(W / 13)}px; font-weight:800; margin-top:${Math.round(W * 0.018)}px; }
  .cta { position:absolute; right:${Math.round(W * 0.05)}px; bottom:${Math.round(W * 0.045)}px;
    background:${accent}; color:#fff; border-radius:999px; padding:${Math.round(W * 0.012)}px ${Math.round(W * 0.03)}px;
    font-size:${Math.round(W / 32)}px; font-weight:700; }
  .brand-footer { position:absolute; left:0; right:0; bottom:0; padding:${Math.round(H * 0.014)}px ${W * 0.07}px;
    background:#10151c; color:#dfe6ef; font-size:${Math.round(W / 40)}px;
    display:flex; gap:8px; align-items:center; }
  .brand-footer .dot { opacity:.5 }
  </style></head><body>
  <div class="stage">
    ${bgDataUrl ? `<img class="bg" src="${bgDataUrl}" />` : `<div class="bg" style="background:linear-gradient(165deg,#3b1a2e 0%,#7a2334 55%,#c8102e 120%)"></div>`}
    <div class="head">
      <div class="festival-tag">限时 · 节日献礼</div>
      <div class="title">${escapeHtml(title || '')}</div>
    </div>
    <div class="panel">
      ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ''}
      ${bulletsHtml(bullets, accent)}
      ${price ? `<div class="price">${escapeHtml(price)}</div>` : ''}
    </div>
    ${cta ? `<div class="cta">${escapeHtml(cta)}</div>` : ''}
    ${brandFooter(brand)}
  </div>
  </body></html>`;
}

/** 客户问候海报：轻文重情，产品位弱化 */
function greeting(ctx) {
  const { W, H, title, subtitle, bullets, brand, bgDataUrl, accent } = ctx;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${W}px; height:${H}px; overflow:hidden;
    font-family:'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif; }
  .stage { position:relative; width:${W}px; height:${H}px; }
  .bg { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .bg::after { content:''; position:absolute; inset:0;
    background:linear-gradient(180deg, rgba(6,10,20,.25) 0%, rgba(6,10,20,.68) 100%); }
  .content { position:absolute; inset:0; display:flex; flex-direction:column;
    justify-content:center; align-items:center; text-align:center; padding:0 ${W * 0.09}px; }
  .title { color:#fff; font-weight:800; font-size:${Math.round(W / 12)}px;
    letter-spacing:8px; text-shadow:0 4px 22px rgba(0,0,0,.55); }
  .divider { width:${Math.round(W * 0.16)}px; height:3px; background:${accent};
    margin:${Math.round(H * 0.03)}px auto; border-radius:2px; }
  .subtitle { color:#eef2f8; font-size:${Math.round(W / 26)}px; line-height:1.9; }
  .bullets { list-style:none; margin-top:${Math.round(H * 0.025)}px; }
  .bullets li { color:#e7ecf4; font-size:${Math.round(W / 34)}px; line-height:1.8; }
  .brand-footer { position:absolute; left:0; right:0; bottom:0; padding:${Math.round(H * 0.016)}px ${W * 0.07}px;
    background:rgba(0,0,0,.5); color:#dfe6ef; font-size:${Math.round(W / 40)}px;
    display:flex; gap:8px; justify-content:center; align-items:center; }
  .brand-footer .dot { opacity:.5 }
  </style></head><body>
  <div class="stage">
    ${bgDataUrl ? `<img class="bg" src="${bgDataUrl}" />` : `<div class="bg" style="background:linear-gradient(170deg,#0e1a2f 0%,#17325c 55%,#2a5fa8 120%)"></div>`}
    <div class="content">
      <div class="title">${escapeHtml(title || '')}</div>
      <div class="divider"></div>
      ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ''}
      ${bulletsHtml(bullets, accent)}
    </div>
    ${brandFooter(brand)}
  </div>
  </body></html>`;
}

const TEMPLATES = {
  product: { label: '产品/业务宣传', render: productPromo },
  festival: { label: '节日营销', render: festival },
  greeting: { label: '客户问候', render: greeting },
};

module.exports = { TEMPLATES, productPromo, festival, greeting, brandFooter, productLayer, bulletsHtml };
