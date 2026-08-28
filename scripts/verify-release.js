import { resolve } from 'node:path';
import { verifyReleaseDirectory } from '../lib/release.js';

const folder = process.argv[2];
if (!folder) { console.error('用法：npm run release:verify -- <解压后的发布目录>'); process.exit(2); }
try { console.log(JSON.stringify(await verifyReleaseDirectory(resolve(folder)), null, 2)); }
catch (error) { console.error(JSON.stringify({ valid: false, error: error.message })); process.exit(1); }
