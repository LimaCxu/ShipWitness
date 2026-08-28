const localHostname = hostname => hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);

export function targetOrigins(value = process.env.SHIPWITNESS_ALLOWED_TARGET_ORIGINS || '') {
  return [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`允许的目标来源格式无效：${item}`);
    return url.origin;
  }))];
}

export function validateTargetUrl(value, allowedOrigins = []) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw Object.assign(new Error('测试网址无效'), { status: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('测试网址必须使用无凭据的 HTTP 或 HTTPS'), { status: 400 });
  if (!localHostname(url.hostname) && !allowedOrigins.includes(url.origin)) throw Object.assign(new Error('测试网址来源未获管理员允许，请配置 SHIPWITNESS_ALLOWED_TARGET_ORIGINS'), { status: 400 });
  return url;
}

export async function fetchTarget(value, { allowedOrigins = [], timeoutMs = 5000, maxRedirects = 5 } = {}) {
  let current = validateTargetUrl(value, allowedOrigins);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(current, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === maxRedirects) throw Object.assign(new Error('测试网址重定向次数过多'), { status: 400 });
    const location = response.headers.get('location');
    if (!location) throw Object.assign(new Error('测试网址返回无目标重定向'), { status: 400 });
    current = validateTargetUrl(new URL(location, current).href, allowedOrigins);
  }
}

export function browserAllowedOrigins(projectUrl, configuredOrigins = []) {
  return new Set([validateTargetUrl(projectUrl, configuredOrigins).origin, ...configuredOrigins]);
}
