import { build } from 'esbuild';
import { readFileSync } from 'fs';

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
