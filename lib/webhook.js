import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const privateAddress = address => {
  if (address.toLowerCase().startsWith('::ffff:')) return privateAddress(address.slice(7));
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (!isIP(address)) return true;
  if (isIP(address) === 4) { const [a, b] = address.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  return false;
};

export const webhookSignature = (body, secret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export async function validateWebhookUrl(value, { allowPrivate = false } = {}) {
  let url; try { url = new URL(value); } catch { throw Object.assign(new Error('Webhook URL 无效'), { status: 400 }); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Object.assign(new Error('Webhook 必须使用无凭据的 HTTPS URL'), { status: 400 });
  if (!allowPrivate) {
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw Object.assign(new Error('Webhook 不能指向本机或私有网络'), { status: 400 });
  }
  return url.toString();
}

export async function sendWebhook({ url, secret, event, deliveryId, payload }) {
  await validateWebhookUrl(url);
  const body = JSON.stringify(payload); const signature = webhookSignature(body, secret);
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', 'user-agent': 'ShipWitness', 'x-shipwitness-event': event, 'x-shipwitness-delivery': deliveryId, 'x-shipwitness-signature': signature }, body });
  if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
  return { status: response.status };
}
