import { chromium } from 'playwright';
import { marked } from 'marked';
import fs from 'fs';
import os from 'os';
import path from 'path';

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const STATE_PATH = process.env.STATE_PATH;
const START_URL = process.env.START_URL || 'https://editor.note.com/new';
const rawTitle = process.env.TITLE || '';
const rawFinal = JSON.parse(fs.readFileSync('final.json', 'utf8'));
const rawBody = String(rawFinal.body || '');
const TAGS = process.env.TAGS || '';
const IS_PUBLIC = String(process.env.IS_PUBLIC || 'false') === 'true';

if (!fs.existsSync(STATE_PATH)) {
  console.error('storageState not found:', STATE_PATH);
  process.exit(1);
}

const screenshotDir = path.join(os.tmpdir(), 'note-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
const workspaceDir = process.cwd();

let browser;
let context;
let page;
let cleaned = false;
let tracingStopped = false;

async function copyToWorkspace(file) {
  if (!file) return null;
  const workspaceFile = path.join(workspaceDir, path.basename(file));
  if (workspaceFile === file) return file;
  try {
    await fs.promises.copyFile(file, workspaceFile);
    return workspaceFile;
  } catch (error) {
    try {
      fs.copyFileSync(file, workspaceFile);
      return workspaceFile;
    } catch (fallbackError) {
      console.error('Failed to copy screenshot to workspace:', fallbackError);
      return file;
    }
  }
}

async function snap(tag = 'snapshot') {
  const safeTag = String(tag || 'snapshot').replace(/[^a-z0-9_-]+/gi, '-');
  const tmpFile = path.join(screenshotDir, `note-post-${nowStr()}-${safeTag}.png`);
  if (page) {
    try {
      await page.screenshot({ path: tmpFile, fullPage: true });
      const finalPath = (await copyToWorkspace(tmpFile)) || tmpFile;
      console.log('SCREENSHOT=' + finalPath);
      return finalPath;
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
    }
  }
  try {
    const fallback = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(tmpFile, fallback);
    const finalPath = (await copyToWorkspace(tmpFile)) || tmpFile;
    console.warn('Saved placeholder screenshot:', finalPath);
    console.log('SCREENSHOT=' + finalPath);
    return finalPath;
  } catch (error) {
    console.error('Failed to capture screenshot fallback:', error);
    return null;
  }
}

async function logPageState(tag = 'error') {
  if (!page) {
    console.warn(`No page available to log state for ${tag}`);
    return;
  }
  try {
    const currentUrl = page.url();
    console.log(`PAGE_URL[${tag}]=${currentUrl}`);
    const html = await page.content();
    const snippet = String(html || '').slice(0, 2000);
    console.log(`PAGE_HTML_SNIPPET[${tag}]=${snippet}`);
  } catch (error) {
    console.error('Failed to log page state:', error);
  }
}

async function stopTracing() {
  if (tracingStopped) return;
  tracingStopped = true;
  try {
    await context?.tracing.stop({ path: 'trace.zip' });
  } catch (error) {
    console.error('Failed to stop tracing:', error);
  }
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await stopTracing();
  try {
    await page?.close();
  } catch {}
  try {
    await context?.close();
  } catch {}
  try {
    await browser?.close();
  } catch {}
}

process.on('uncaughtException', (error) => {
  console.error('uncaughtException', error);
  (async () => {
    await logPageState('uncaught').catch(() => {});
    await snap('uncaught').catch(() => {});
  })()
    .finally(() => {
      cleanup().finally(() => process.exit(1));
    });
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  (async () => {
    await logPageState('unhandled').catch(() => {});
    await snap('unhandled').catch(() => {});
  })()
    .finally(() => {
      cleanup().finally(() => process.exit(1));
    });
});

function sanitizeTitle(t) {
  let s = String(t || '').trim();
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*$/, '').replace(/^```$/, '');
  s = s.replace(/^#+\s*/, '');
  s = s.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  s = s.replace(/^`+|`+$/g, '');
  s = s.replace(/^json$/i, '').trim();
  // タイトルが波括弧や記号のみの時は無効として扱う
  if (/^[\{\}\[\]\(\)\s]*$/.test(s)) s = '';
  if (!s) s = 'タイトル（自動生成）';
  return s;
}

function deriveTitleFromMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    const m = l.match(/^#{1,3}\s+(.+)/);
    if (m) return sanitizeTitle(m[1]);
    if (!/^```|^>|^\* |^- |^\d+\. /.test(l)) return sanitizeTitle(l);
  }
  return '';
}

// ★ここに置き換え
async function fillTitleInput(page, value) {
  // 1. よくあるパターンを順番に試す
  const selectors = [
    'textarea[placeholder*="タイトル"]',
    'input[placeholder*="タイトル"]',
    'textarea[aria-label*="タイトル"]',
    'input[aria-label*="タイトル"]',
    '[data-testid*="title"] textarea',
    '[data-testid*="title"] input',
    'div[contenteditable="true"][data-placeholder*="タイトル"]',
    'div[contenteditable="true"][aria-label*="タイトル"]',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 7000 });
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const editable = await loc.isEditable().catch(() => false);
      if (editable) {
        await loc.fill(value);
        return;
      }
      const isCE = await loc.evaluate(el => !!(el && el.isContentEditable)).catch(() => false);
      if (isCE) {
        await loc.click({ force: true });
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.type(value);
        return;
      }
      // 子に textarea/input がいるタイプ
      const inner = loc.locator('textarea, input').first();
      if (await inner.count()) {
        await inner.waitFor({ state: 'visible', timeout: 3000 });
        if (await inner.isEditable().catch(() => false)) {
          await inner.fill(value);
          return;
        }
      }
    } catch (_) {
      // 見つからなかったら次
    }
  }

  // 2. それでも見つからないときはページ全部を見て「タイトルっぽい」ものを取る
  const ok = await page.evaluate((val) => {
    const nodes = Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"]'));

    // placeholder / aria-label に「タイトル」
    let target =
      nodes.find(n => {
        const ph = (n.getAttribute('placeholder') || '').toLowerCase();
        const al = (n.getAttribute('aria-label') || '').toLowerCase();
        return ph.includes('タイトル') || al.includes('タイトル') || ph.includes('title') || al.includes('title');
      }) ||
      // 画面の上の方にある大きめの入力をタイトル扱いする
      nodes.find(n => {
        const r = n.getBoundingClientRect();
        return r.top >= 0 && r.top < 320 && r.height > 30;
      });

    if (!target) return false;

    if (target.isContentEditable) {
      target.focus();
      target.innerText = val;
    } else {
      target.focus();
      target.value = val;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }, value);

  if (!ok) {
    throw new Error('TITLE_INPUT_NOT_FOUND_AFTER_FALLBACK');
  }
}

function normalizeBullets(md) {
  // 先頭の中黒・ビュレットを箇条書きに正規化
  return String(md || '')
    .replace(/^\s*[•・]\s?/gm, '- ')
    .replace(/^\s*◦\s?/gm, '  - ');
}

function unwrapParagraphs(md) {
  // 段落中の不必要な改行をスペースへ（見出し/リスト/引用/コードは除外）
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let buf = '';
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\u200B/g, '');
    if (/^```/.test(line)) {
      inFence = !inFence;
      buf += line + '\n';
      continue;
    }
    if (inFence) {
      buf += line + '\n';
      continue;
    }
    if (/^\s*$/.test(line)) {
      if (buf) out.push(buf.trim());
      out.push('');
      buf = '';
      continue;
    }
    // 箇条書きや番号付きの字下げ改行を一行に連結
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(line)) {
      if (buf) {
        out.push(buf.trim());
        buf = '';
      }
      // 次の数行が連続して単語単位の改行の場合は連結
      out.push(line.replace(/\s+$/, ''));
      continue;
    }
    // 行頭が1文字や数文字で改行されているケース（縦伸び）を連結
    if (buf) {
      buf += (/[。.!?)]$/.test(buf) ? '\n' : ' ') + line.trim();
    } else {
      buf = line.trim();
    }
  }
  if (buf) out.push(buf.trim());
  return out.join('\n');
}

function preferBareUrls(md) {
  const embedDomains = [
    'openai.com',
    'youtube.com',
    'youtu.be',
    'x.com',
    'twitter.com',
    'speakerdeck.com',
    'slideshare.net',
    'google.com',
    'maps.app.goo.gl',
    'gist.github.com',
  ];
  return String(md || '').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      const isEmbed =
        embedDomains.some((d) => host.endsWith(d) || (url.includes('google.com/maps') && d.includes('google.com')));
      return isEmbed ? `${text}\n${url}\n` : `${text} (${url})`;
    } catch {
      return `${text} ${url}`;
    }
  });
}

function isGarbageLine(line) {
  return /^[\s\{\}\[\]\(\)`]+$/.test(line || '');
}

function normalizeListItemSoftBreaks(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inItem = false;
  const listStartRe = /^(\s*)(?:[-*+]\s|\d+\.\s)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (listStartRe.test(line)) {
      inItem = true;
      out.push(line.replace(/\s+$/, ''));
      continue;
    }
    if (inItem) {
      // 空行 or 次のリスト開始でアイテム終端
      if (!line.trim()) {
        out.push(line);
        inItem = false;
        continue;
      }
      if (listStartRe.test(line)) {
        inItem = false;
        out.push(line);
        continue;
      }
      // 継続行は1行へ連結
      const last = out.pop() || '';
      out.push(last + ' ' + line.trim());
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function splitMarkdownBlocks(md) {
  const lines = String(md || '').split(/\r?\n/);
  const blocks = [];
  let cur = [];
  let inFence = false;
  for (const line of lines) {
    const m = line.match(/^```(.*)$/);
    if (m) {
      if (!inFence) {
        inFence = true;
        cur.push(line);
      } else {
        inFence = false;
        cur.push(line);
        blocks.push(cur.join('\n'));
        cur = [];
        continue;
      }
    } else if (!inFence && line.trim() === '') {
      if (cur.length) {
        blocks.push(cur.join('\n'));
        cur = [];
        continue;
      }
    } else if (!inFence && isGarbageLine(line)) {
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.filter((b) => {
    const t = b.trim();
    return t.length > 0 && !isGarbageLine(t);
  });
}

function mdToHtml(block) {
  const trimmed = block.trim();
  const isList = /^(?:[-*+]\s|\d+\.\s)/.test(trimmed.split(/\r?\n/, 1)[0] || '');
  if (isList) {
    const normalized = trimmed.replace(/\n(?![-*+]\s|\d+\.\s)/g, ' ');
    return String(marked.parse(normalized, { gfm: true, breaks: false, mangle: false, headerIds: false }) || '');
  }
  return String(marked.parse(block, { gfm: true, breaks: !isList, mangle: false, headerIds: false }) || '');
}

function htmlFromMarkdown(md) {
  // 全文を一括でHTML化（段落ベース）。リスト中の意図しない <br> を避けるため breaks=false
  return String(marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false }) || '');
}

async function insertHTML(page, locator, html) {
  await locator.click();
  await locator.evaluate((el, html) => {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertHTML', false, html);
  }, html);
}

let TITLE = sanitizeTitle(rawTitle);
let preBody = preferBareUrls(rawBody);
preBody = normalizeBullets(preBody);
preBody = normalizeListItemSoftBreaks(preBody);
preBody = unwrapParagraphs(preBody);
if (!TITLE || TITLE === 'タイトル（自動生成）') {
  const d = deriveTitleFromMarkdown(preBody);
  if (d) TITLE = d;
}
const blocks = splitMarkdownBlocks(preBody);

async function run() {
  try {
    browser = await chromium.launch({ headless: true, args: ['--lang=ja-JP'] });
    context = await browser.newContext({
      storageState: STATE_PATH,
      locale: 'ja-JP',
      recordHar: { path: 'network.har', content: 'embed', mode: 'minimal' },
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.on('pageerror', async () => {
      try {
        await page.screenshot({ path: `pageerror-${nowStr()}.png`, fullPage: true });
      } catch {}
    });

    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await fillTitleInput(TITLE);

    const bodyBox = page.locator('div[contenteditable="true"][role="textbox"]').first();
    try {
      await bodyBox.waitFor({ state: 'visible', timeout: 30000 });
    } catch (e) {
      try {
        await page.screenshot({ path: `note_error-${nowStr()}.png`, fullPage: true });
      } catch {}
      throw e;
    }
    const htmlAll = htmlFromMarkdown(preBody);
    let pasted = false;
    try {
      const origin = new URL(START_URL).origin;
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await page.evaluate(async (html, plain) => {
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
      }, htmlAll, preBody);
      await bodyBox.click();
      await page.keyboard.press('Control+V');
      await page.waitForTimeout(200);
      pasted = true;
    } catch (e) {
      // クリップボード権限が無い場合のフォールバック
    }
    if (!pasted) {
      // 一括HTML挿入フォールバック
      await insertHTML(page, bodyBox, htmlAll);
      await page.waitForTimeout(100);
    }

    if (!IS_PUBLIC) {
      const saveBtn = page.locator('button:has-text("下書き保存"), [aria-label*="下書き保存"]').first();
      await saveBtn.waitFor({ state: 'visible' });
      if (await saveBtn.isEnabled()) {
        await saveBtn.click();
        await page.locator('text=保存しました').waitFor({ timeout: 4000 }).catch(() => {});
      }
      await snap('draft');
      console.log('DRAFT_URL=' + page.url());
      return;
    }

    const proceed = page.locator('button:has-text("公開に進む")').first();
    await proceed.waitFor({ state: 'visible' });
    for (let i = 0; i < 20; i++) {
      if (await proceed.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await proceed.click({ force: true });

    await Promise.race([
      page.waitForURL(/\/publish/i).catch(() => {}),
      page.locator('button:has-text("投稿する")').first().waitFor({ state: 'visible' }).catch(() => {}),
    ]);

    const tags = (TAGS || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (tags.length) {
      let tagInput = page.locator('input[placeholder*="ハッシュタグ"]');
      if (!(await tagInput.count())) tagInput = page.locator('input[role="combobox"]').first();
      await tagInput.waitFor({ state: 'visible' });
      for (const t of tags) {
        await tagInput.click();
        await tagInput.fill(t);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
      }
    }

    const publishBtn = page.locator('button:has-text("投稿する")').first();
    await publishBtn.waitFor({ state: 'visible' });
    for (let i = 0; i < 20; i++) {
      if (await publishBtn.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await publishBtn.click({ force: true });

    await Promise.race([
      page.waitForURL((u) => !/\/publish/i.test(typeof u === 'string' ? u : u.toString()), { timeout: 20000 }).catch(() => {}),
      page.locator('text=投稿しました').first().waitFor({ timeout: 8000 }).catch(() => {}),
      page.waitForTimeout(5000),
    ]);

    await snap('published');
    const finalUrl = page.url();
    console.log('PUBLISHED_URL=' + finalUrl);
  } catch (error) {
    try {
      await logPageState('run-error');
    } catch {}
    try {
      await snap('error');
    } catch {}
    throw error;
  } finally {
    await cleanup();
  }
}

run().catch((error) => {
  console.error('POST_MJS_ERROR', error?.stack || error);
  process.exitCode = 1;
});
