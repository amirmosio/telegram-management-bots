// Process + Buffer shim for browser — must run before GramJS loads
import { Buffer as _Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = _Buffer;
if (typeof globalThis.process === 'undefined') {
    globalThis.process = { env: {}, version: '', platform: 'browser', nextTick: (fn) => setTimeout(fn, 0) };
}
