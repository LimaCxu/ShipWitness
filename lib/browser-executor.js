import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserAllowedOrigins } from './target-policy.js';

const allowedActions = new Set(['goto', 'click', 'fill', 'expectVisible', 'expectText', 'expectUrl']);
const assertionActions = new Set(['expectVisible', 'expectText', 'expectUrl']);

const cleanError = error => String(error?.message || error || '未知错误').split('\n')[0].slice(0, 240);

export async function checkBrowserAvailability() {
  try {
    const executable = chromium.executablePath();
    await stat(executable);
    return { status: 'ready', detail: 'Chromium 执行器已安装' };
  } catch {
    return { status: 'warning', detail: '需要运行 npx playwright install chromium' };
  }
}

export function normalizeSteps(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw Object.assign(new Error('浏览器步骤必须是数组'), { status: 400 });
  if (input.length > 20) throw Object.assign(new Error('每条标准最多允许 20 个浏览器步骤'), { status: 400 });
  return input.map((raw, index) => {
    if (!raw || !allowedActions.has(raw.action)) throw Object.assign(new Error(`第 ${index + 1} 步动作无效`), { status: 400 });
    const step = { action: raw.action };
    if (raw.action === 'goto') {
      if (typeof raw.path !== 'string' || !raw.path.trim()) throw Object.assign(new Error(`第 ${index + 1} 步缺少路径`), { status: 400 });
      if (raw.path.length > 2048) throw Object.assign(new Error(`第 ${index + 1} 步路径过长`), { status: 400 });
      step.path = raw.path.trim();
    } else if (raw.action === 'expectUrl') {
      if (typeof raw.value !== 'string' || !raw.value.trim()) throw Object.assign(new Error(`第 ${index + 1} 步缺少网址特征`), { status: 400 });
      if (raw.value.length > 2048) throw Object.assign(new Error(`第 ${index + 1} 步网址特征过长`), { status: 400 });
      step.value = raw.value.trim();
    } else {
      if (typeof raw.selector !== 'string' || !raw.selector.trim()) throw Object.assign(new Error(`第 ${index + 1} 步缺少元素定位`), { status: 400 });
      if (raw.selector.length > 1000) throw Object.assign(new Error(`第 ${index + 1} 步元素定位过长`), { status: 400 });
      step.selector = raw.selector.trim();
      if (raw.action === 'fill' || raw.action === 'expectText') {
        if (typeof raw.value !== 'string') throw Object.assign(new Error(`第 ${index + 1} 步缺少内容`), { status: 400 });
        if (raw.value.length > 10_000) throw Object.assign(new Error(`第 ${index + 1} 步内容过长`), { status: 400 });
        step.value = raw.value;
      }
    }
    return step;
  });
}

const safeTarget = (base, path) => {
  const baseUrl = new URL(base);
  const target = new URL(path, baseUrl);
  if (target.origin !== baseUrl.origin) throw new Error('禁止跳转到项目以外的网站');
  return target.href;
};

async function performStep(page, projectUrl, step) {
  if (step.action === 'goto') {
    const response = await page.goto(safeTarget(projectUrl, step.path), { waitUntil: 'domcontentloaded', timeout: 12_000 });
    if (new URL(page.url()).origin !== new URL(projectUrl).origin) throw new Error('页面被重定向到项目以外的网站');
    return `打开 ${new URL(page.url()).pathname} · HTTP ${response?.status() ?? '未知'}`;
  }
  if (step.action === 'click') { await page.locator(step.selector).click({ timeout: 8_000 }); return `点击 ${step.selector}`; }
  if (step.action === 'fill') { await page.locator(step.selector).fill(step.value, { timeout: 8_000 }); return `填写 ${step.selector}`; }
  if (step.action === 'expectVisible') { await page.locator(step.selector).waitFor({ state: 'visible', timeout: 8_000 }); return `${step.selector} 可见`; }
  if (step.action === 'expectText') {
    const actual = await page.locator(step.selector).innerText({ timeout: 8_000 });
    if (!actual.includes(step.value)) throw new Error(`${step.selector} 未出现预期文字“${step.value}”`);
    return `${step.selector} 包含预期文字`;
  }
  if (!page.url().includes(step.value)) throw new Error(`当前网址不包含“${step.value}”`);
  return '网址符合预期';
}

export async function executeBrowserRun({ project, run, artifactsDir, allowedOrigins = [], launch = options => chromium.launch(options) }) {
  const startedAt = new Date().toISOString();
  const runDir = join(artifactsDir, run.id);
  await mkdir(runDir, { recursive: true });
  let browser;
  try {
    browser = await launch({ headless: true });
  } catch (error) {
    return {
      executor: 'shipwitness-browser-v1', startedAt, finishedAt: new Date().toISOString(), browser: { status: 'unavailable', error: cleanError(error) },
      criteriaResults: run.criteria.map((criterion, index) => ({ id: `criterion-${index + 1}`, title: criterion.title, description: criterion.description, result: 'evidence_insufficient', reason: '浏览器运行环境不可用，未执行任何业务步骤。', steps: [] })),
      verdict: 'evidence_insufficient', summary: '浏览器运行环境不可用；没有标准被误判为通过。'
    };
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
  const outboundOrigins = browserAllowedOrigins(project.url, allowedOrigins);
  await context.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (['data:', 'blob:'].includes(requestUrl.protocol) || outboundOrigins.has(requestUrl.origin)) return route.continue();
    return route.abort('blockedbyclient');
  });
  const results = [];
  try {
    for (let criterionIndex = 0; criterionIndex < run.criteria.length; criterionIndex += 1) {
      const criterion = run.criteria[criterionIndex];
      const steps = normalizeSteps(criterion.steps);
      if (!steps.length) {
        results.push({ id: `criterion-${criterionIndex + 1}`, title: criterion.title, description: criterion.description, result: 'evidence_insufficient', reason: '该标准尚未配置浏览器步骤。', steps: [] });
        continue;
      }
      const page = await context.newPage();
      const network = [];
      page.on('response', response => {
        if (network.length < 60) network.push({ method: response.request().method(), status: response.status(), url: response.url().slice(0, 500) });
      });
      const stepResults = [];
      let failure = null;
      const started = Date.now();
      try {
        await page.goto(project.url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
        for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
          const stepStarted = Date.now();
          try {
            const detail = await performStep(page, project.url, steps[stepIndex]);
            stepResults.push({ index: stepIndex + 1, action: steps[stepIndex].action, status: 'passed', detail, durationMs: Date.now() - stepStarted, url: page.url() });
          } catch (error) {
            failure = cleanError(error);
            stepResults.push({ index: stepIndex + 1, action: steps[stepIndex].action, status: 'failed', detail: failure, durationMs: Date.now() - stepStarted, url: page.url() });
            break;
          }
        }
        const screenshotName = `criterion-${criterionIndex + 1}.png`;
        await page.screenshot({ path: join(runDir, screenshotName), fullPage: true });
        const hasAssertion = steps.some(step => assertionActions.has(step.action));
        results.push({
          id: `criterion-${criterionIndex + 1}`, title: criterion.title, description: criterion.description,
          result: failure ? 'failed' : hasAssertion ? 'passed' : 'evidence_insufficient',
          reason: failure || (hasAssertion ? '全部浏览器步骤和明确断言均已通过。' : '步骤已执行，但没有配置结果断言。'),
          durationMs: Date.now() - started, finalUrl: page.url(), screenshotUrl: `/api/evidence/${run.id}/${screenshotName}`, steps: stepResults, network
        });
      } finally { await page.close(); }
    }
  } finally { await context.close(); await browser.close(); }

  const verdict = results.some(item => item.result === 'failed') ? 'failed' : results.every(item => item.result === 'passed') && results.length ? 'passed' : 'evidence_insufficient';
  return { executor: 'shipwitness-browser-v1', startedAt, finishedAt: new Date().toISOString(), browser: { status: 'ready', engine: 'chromium' }, criteriaResults: results, verdict, summary: verdict === 'passed' ? '全部验收标准均有真实浏览器断言证据。' : verdict === 'failed' ? '至少一条真实业务路径未达到验收标准。' : '部分标准缺少可执行步骤或明确断言。' };
}
