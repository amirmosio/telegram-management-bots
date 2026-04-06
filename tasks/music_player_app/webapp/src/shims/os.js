// OS shim for browser — GramJS uses os.type() and os.release()
module.exports = {
    type: () => 'Browser',
    release: () => navigator.userAgent || '1.0',
    platform: () => 'browser',
    arch: () => 'wasm',
    hostname: () => 'localhost',
    homedir: () => '/',
    tmpdir: () => '/tmp',
};
