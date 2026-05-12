import { build } from 'esbuild';
import { readFileSync } from 'fs';

// APP_TOKEN is the shared secret baked into the bundle so the deployed
// proxy can verify the caller is this exact build of the webapp. Set the
// SAME value on the server (the corsproxy systemd unit reads APP_TOKEN
// from its env). Production deploys should rotate it on every build —
// generate a fresh one with:
//
//     APP_TOKEN=$(openssl rand -hex 32) node build.mjs
//
// Dev / local builds can omit the var; the resulting bundle is harmless
// (only useful against a proxy that has APP_TOKEN unset too — and that
// proxy refuses to start, so dev runs need APP_TOKEN set somewhere on
// both sides).
const APP_TOKEN = process.env.APP_TOKEN || '';
if (!APP_TOKEN) {
    console.warn('[build] APP_TOKEN env var not set — built bundle will not authenticate to the proxy.');
    console.warn('[build] For a production build run: APP_TOKEN=$(openssl rand -hex 32) node build.mjs');
}

await build({
    entryPoints: ['src/main.js'],
    bundle: true,
    outfile: 'app.bundle.js',
    format: 'iife',
    platform: 'browser',
    define: {
        'global': 'window',
        'process.env.NODE_ENV': '"production"',
        'process.env': '{}',
        '__APP_TOKEN__': JSON.stringify(APP_TOKEN),
    },
    alias: {
        'crypto': 'crypto-browserify',
        'stream': 'stream-browserify',
        'net': './src/shims/net.js',
        'fs': './src/shims/empty.js',
        'path': './src/shims/empty.js',
        'os': './src/shims/os.js',
        'child_process': './src/shims/empty.js',
        'worker_threads': './src/shims/empty.js',
        'assert': './src/shims/empty.js',
        'constants': './src/shims/empty.js',
        'graceful-fs': './src/shims/empty.js',
        'socks': './src/shims/socks.js',
    },
    inject: ['./src/shims/process.js'],
    logLevel: 'info',
});
