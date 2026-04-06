// Stub for socks — not needed in browser (GramJS uses WebSocket)
module.exports = { SocksClient: { createConnection: async () => { throw new Error('SOCKS not available in browser'); } } };
