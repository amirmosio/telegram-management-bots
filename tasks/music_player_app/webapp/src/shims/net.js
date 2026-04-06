// Minimal net shim — GramJS uses WebSocket in browser, not net.Socket
class Socket {
    constructor() { this.destroyed = false; }
    connect() { return this; }
    write() {}
    end() {}
    destroy() { this.destroyed = true; }
    on() { return this; }
    once() { return this; }
    removeListener() { return this; }
    setTimeout() {}
    setNoDelay() {}
    setKeepAlive() {}
}

module.exports = { Socket, createConnection: () => new Socket() };
