const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const baseUrl = (value('--url') || process.env.SHIPWITNESS_URL || '').replace(/\/$/, '');
const runId = value('--run') || process.env.SHIPWITNESS_RUN_ID;
const token = value('--token') || process.env.SHIPWITNESS_API_KEY;

if (!baseUrl || !runId || !token) { console.error('用法：shipwitness-gate --url <地址> --run <任务ID> --token <API Key>'); process.exit(2); }
try {
  const response = await fetch(`${baseUrl}/api/gates/${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const result = await response.json();
  if (!response.ok) { console.error(JSON.stringify(result)); process.exit(2); }
  console.log(JSON.stringify(result, null, 2)); process.exit(result.exitCode);
} catch (error) { console.error(JSON.stringify({ error: error.name === 'TimeoutError' ? '门禁请求超时' : '门禁服务不可用' })); process.exit(2); }
