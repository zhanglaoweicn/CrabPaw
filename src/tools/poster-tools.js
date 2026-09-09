/**
 * poster-tools.js — 海报生成工具（P0）
 *
 * PosterGenerate : 生成营销海报（模板 × 品牌包 × AI 底图 × 产品照片合成 → PNG）
 * PosterBrandKit : 品牌资产包读写（企业名/slogan/联系方式/品牌色）
 *
 * 设计要点见 docs/海报生成能力方案.md：
 *  - 双层渲染：AI 底图（无文字）+ HTML 模板确定性排版（电话/价格 100% 精确）
 *  - 产品保真：产品照片原样合成，AI 不重绘产品本体
 *  - 产物落 data/workspace/posters（发送企微白名单内）
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { registry } = require('./registry');
const poster = require('../core/poster');
const { getImageGenerator } = require('../core/image-gen');
const { registerArtifact } = require('../core/doc-artifacts/registry');
const filegen = require('../core/filegen-events');

// ─── 产品抠图（rembg 可用时启用，否则回退原图合成）───
function rembgAvailable() {
  return new Promise((resolve) => {
    const py = process.env.POSTER_PYTHON || 'python';
    const p = spawn(py, ['-c', 'import rembg'], { windowsHide: true });
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

function rembgCutout(inputPath, outPath) {
  return new Promise((resolve) => {
    const py = process.env.POSTER_PYTHON || 'python';
    const script = `from rembg import remove;from PIL import Image;` +
      `open(r'${outPath}','wb').write(remove(open(r'${inputPath}','rb').read()))`;
    const p = spawn(py, ['-c', script], { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      if (code === 0 && fsSync.existsSync(outPath)) resolve({ ok: true, path: outPath });
      else resolve({ ok: false, error: (stderr || '').split('\n').slice(-2).join(' ').substring(0, 160) });
    });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

async function prepareProductImage(productImagePath) {
  if (!productImagePath) return { path: '', note: '' };
  if (!fsSync.existsSync(productImagePath)) {
    throw new Error(`产品照片不存在: ${productImagePath}`);
  }
  const cutPath = productImagePath.replace(/\.[^.]+$/, '') + '_cutout.png';
  if (await rembgAvailable()) {
    const r = await rembgCutout(productImagePath, cutPath);
    if (r.ok) return { path: r.path, note: '产品已自动抠图（透明底合成）' };
    return { path: productImagePath, note: `抠图失败已回退原图合成: ${r.error || '未知原因'}` };
  }
  return { path: productImagePath, note: '未安装 rembg（pip install rembg），产品以原图区块合成；如需透明底抠图请安装' };
}

// ─── PosterGenerate ───
async function handlePosterGenerate(params) {
  const {
    template_id = 'product',
    aspect = '1:1',
    title = '',
    subtitle = '',
    bullets = [],
    price = '',
    cta = '',
    bg_prompt = '',
    bg_image_path = '',
    product_image_path = '',
    brand = {},
    variants = [],
  } = params;

  if (!title || !String(title).trim()) {
    return { success: false, error: 'title 必填（海报主标题）' };
  }

  // 0. 文件生成卡生命周期——海报流程在卡片中可视化（①需求理解 → ②文案与底图 → ③排版合成 → ④成品）
  const fgTask = filegen.ensureFileGenTask({
    title: `海报：${title}`.substring(0, 40),
    format: 'poster',
    phase: 'collect',
    label: '需求理解与文案准备…',
    fresh: true,
  });

  // 1. AI 底图（可选但推荐——"酷炫"的主要来源）
  let bgImagePath = '';
  let bgFailReason = '';
  // 2026-09-08 P1: 底图复用——传入 bg_image_path 时跳过生成（"改文案/换模板不重生成底图"的独立重跑）
  if (bg_image_path && fsSync.existsSync(bg_image_path)) {
    bgImagePath = bg_image_path;
    console.log('[poster] 复用既有底图:', bgImagePath);
  } else if (bg_image_path) {
    bgFailReason = `bg_image_path 不存在: ${bg_image_path}`;
    console.warn('[poster]', bgFailReason);
  }
  if (!bgImagePath && bg_prompt && String(bg_prompt).trim()) {
    filegen.phaseFileGen(fgTask.taskId, 'writing', '生成 AI 底图…');
    const bgSize = poster.ASPECT_BG_SIZE[aspect] || '2048x2048';
    const gen = getImageGenerator();
    const bgResult = await gen.generate(
      `${String(bg_prompt).trim()}。画面中不要出现任何文字、字母、数字、水印。`,
      { size: bgSize, style: 'vivid', count: 1 },
    );
    const firstImg = bgResult.success && bgResult.images && bgResult.images[0];
    const bgLocalPath = firstImg && (firstImg.filePath || firstImg.path || firstImg.localPath);
    if (bgLocalPath && fsSync.existsSync(bgLocalPath)) {
      bgImagePath = bgLocalPath;
    } else {
      // 2026-09-08: 失败原因完整透传（含 provider/逐提供商错误），不再吞成'未知'
      const detail = JSON.stringify({ error: bgResult.error, provider: bgResult.provider, images: (bgResult.images || []).length });
      console.warn('[poster] 底图生成失败，回退纯色渐变底:', detail);
      bgFailReason = detail;
    }
  }

  // 2. 产品照预处理（抠图/回退）
  let productNote = '';
  let productPath = '';
  if (product_image_path) {
    const prepared = await prepareProductImage(product_image_path);
    productPath = prepared.path;
    productNote = prepared.note;
  }

  // 2.5 文案就绪 → ③排版合成
  filegen.phaseFileGen(fgTask.taskId, 'converting', '排版合成（HTML 渲染截图）中…');

  // 3. 渲染（主规格 + variants 多规格：同一内容/底图/产品照，仅版式随比例重排）
  const brandOverride = brand && Object.keys(brand).length ? {
    ...brand,
    accent: brand.accent || (brand.colors && brand.colors.primary),
  } : undefined;

  async function renderOne(aspectId) {
    const rr = await poster.renderPoster({
      templateId: template_id,
      aspect: aspectId,
      title,
      subtitle,
      bullets,
      price,
      cta,
      bgImagePath,
      productImagePath: productPath,
      brandOverride,
    });
    registerArtifact({
      path: rr.path,
      name: path.basename(rr.path),
      size: rr.bytes,
      format: 'poster',
      title: `海报：${title}（${aspectId}）`.substring(0, 60),
    });
    return rr;
  }

  const renderResult = await renderOne(aspect);
  filegen.artifactFileGen(fgTask.taskId, {
    path: renderResult.path,
    name: path.basename(renderResult.path),
    size: renderResult.bytes,
    format: 'poster',
    url: filegen.previewUrlFor('poster', renderResult.path),
  });
  const posters = [{ aspect: renderResult.aspect, path: renderResult.path, bytes: renderResult.bytes }];
  const variantResults = [];
  for (const vAspect of (Array.isArray(variants) ? variants : [])) {
    if (!poster.ASPECT_SIZES[vAspect] || vAspect === aspect) continue;
    try {
      const vr = await renderOne(vAspect);
      posters.push({ aspect: vr.aspect, path: vr.path, bytes: vr.bytes });
      variantResults.push(vr);
    } catch (e) {
      console.warn(`[poster] 变体 ${vAspect} 渲染失败(不阻塞):`, e.message);
    }
  }

  filegen.doneFileGen(fgTask.taskId, {
    path: renderResult.path,
    name: path.basename(renderResult.path),
    size: renderResult.bytes,
    format: 'poster',
    url: filegen.previewUrlFor('poster', renderResult.path),
  });

  return {
    success: true,
    data: {
      path: renderResult.path,
      width: renderResult.width,
      height: renderResult.height,
      bytes: renderResult.bytes,
      template: renderResult.templateId,
      aspect: renderResult.aspect,
      posters,
      bg_used: Boolean(bgImagePath),
      // 回传实际使用的底图路径——"只改文案/换模板"时把它作为 bg_image_path 传入即可跳过重新生成
      bg_image_path: bgImagePath || undefined,
      bg_fail_reason: bgFailReason || undefined,
      note: productNote,
    },
    message: `海报已生成（${posters.map(p => p.aspect).join(' + ')}，${renderResult.templateId} 模板）: ${renderResult.path}`,
  };
}

// ─── PosterBrandKit ───
async function handlePosterBrandKit(params) {
  const action = params.action || 'get';
  if (action === 'get') {
    return { success: true, data: poster.loadBrandKit() };
  }
  if (action === 'set') {
    const data = {};
    for (const k of ['companyName', 'slogan', 'logo']) {
      if (params[k] !== undefined) data[k] = String(params[k]);
    }
    if (params.accent !== undefined) data.colors = { primary: String(params.accent) };
    if (params.phone !== undefined || params.address !== undefined || params.wechat !== undefined) {
      data.contact = {};
      if (params.phone !== undefined) data.contact.phone = String(params.phone);
      if (params.address !== undefined) data.contact.address = String(params.address);
      if (params.wechat !== undefined) data.contact.wechat = String(params.wechat);
    }
    const saved = poster.saveBrandKit(data);
    return { success: true, data: saved, message: '品牌资产包已保存，后续海报自动携带' };
  }
  return { success: false, error: `未知 action: ${action}（支持 get/set）` };
}

// ─── 注册 ───
registry.register({
  name: 'PosterGenerate',
  toolset: 'media',
  category: 'media',
  description: '生成营销海报（产品宣传/节日营销/客户问候）。双层渲染：AI 底图 + HTML 确定性排版——价格/电话/日期等文字 100% 精确。支持 1:1、9:16、16:9、3:4、4:3 比例与产品照片合成（产品像素原样保留）。产物为 PNG，自动登记文件卡，可直接发送企业微信。',
  schema: {
    type: 'object',
    properties: {
      template_id: { type: 'string', enum: ['product', 'festival', 'greeting'], description: '模板：product=产品/业务宣传，festival=节日营销，greeting=客户问候' },
      aspect: { type: 'string', enum: ['1:1', '9:16', '16:9', '3:4', '4:3'], description: '画面比例，默认 1:1（朋友圈）。9:16=抖音/视频号，3:4=小红书' },
      title: { type: 'string', description: '主标题（必填，如"GPT-6 来了"）' },
      subtitle: { type: 'string', description: '副标题/一句话卖点' },
      bullets: { type: 'array', items: { type: 'string' }, description: '卖点列表（最多 4 条，每条一句话）' },
      price: { type: 'string', description: '价格/优惠信息（如"限时 ¥1999"）' },
      cta: { type: 'string', description: '行动号召（如"立即咨询"）' },
      bg_prompt: { type: 'string', description: 'AI 底图描述（无文字的背景氛围，如"深蓝科技感渐变，霓虹光斑"）。省略则用纯色渐变底' },
      bg_image_path: { type: 'string', description: '复用既有底图的本地路径（传入则跳过底图生成——"只改文案/换模板"的独立重跑）。上一次调用结果 data.bg_image_path 可直接回传' },
      variants: { type: 'array', items: { type: 'string', enum: ['1:1', '9:16', '16:9', '3:4', '4:3'] }, description: '多规格变体：在主比例外额外生成的比例列表（同一内容一次出多规格）' },
      product_image_path: { type: 'string', description: '产品照片的本地路径（可选；有则原样合成进海报，rembg 可用时自动抠图）' },
      brand: {
        type: 'object',
        description: '品牌信息覆盖（省略时自动使用品牌资产包）。仅当本次需要临时覆盖时传入',
        properties: {
          companyName: { type: 'string' }, slogan: { type: 'string' },
          phone: { type: 'string' }, address: { type: 'string' }, accent: { type: 'string' },
        },
      },
    },
    required: ['title'],
  },
  whenNotToUse: ['普通文章配图/简单插图（用 ImageGenerate）', '需要 AI 重绘产品本体的场景（产品保真红线）', '表情包/头像等非营销图'],
  handler: handlePosterGenerate,
  checkFn: (params) => params.title,
  timeout: 300000,
  isReadOnly: false,
});

registry.register({
  name: 'PosterBrandKit',
  toolset: 'media',
  category: 'media',
  description: '品牌资产包读写——企业名/slogan/联系方式/品牌主色。设置一次，之后所有海报自动携带品牌一致性。用户说"记住我的联系方式/把海报电话改成xx"时用 set。',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'get=读取当前品牌包；set=更新（只传需要改的字段）' },
      companyName: { type: 'string', description: '企业名称' },
      slogan: { type: 'string', description: '品牌口号' },
      phone: { type: 'string', description: '联系电话' },
      address: { type: 'string', description: '地址' },
      wechat: { type: 'string', description: '微信号' },
      accent: { type: 'string', description: '品牌主色（HEX，如 #C8102E）' },
    },
    required: ['action'],
  },
  whenNotToUse: ['不要用它生成海报（用 PosterGenerate）'],
  handler: handlePosterBrandKit,
  checkFn: (params) => params.action,
  timeout: 15000,
  isReadOnly: false,
});

module.exports = { handlePosterGenerate, handlePosterBrandKit };
