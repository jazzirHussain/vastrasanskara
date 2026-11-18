import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the module at `url` is the script node was started with (not imported by a test). */
export const isMain = (url) => Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url);
