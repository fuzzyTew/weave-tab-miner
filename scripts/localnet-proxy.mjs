// scripts/localnet-proxy.mjs — lets a browser page reach an Arweave localnet node. The node
// wants X-Network: arweave.localnet on every request, and a page adding that header must
// first pass a CORS preflight the node refuses (it allows only Content-Type). This proxy
// adds the header and answers CORS itself. Run by the localnet workflow's page mode:
//   node scripts/localnet-proxy.mjs [listen port, default 1985] [node URL, default http://127.0.0.1:1984]
import { createServer, request } from 'node:http';

class LocalnetProxy {
  static NETWORK_NAME = 'arweave.localnet';
  static CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': '*',
  };

  constructor({ port, nodeUrl }) {
    Object.assign(this, { port, nodeUrl: new URL(nodeUrl) });
  }

  /** Forwards one request, streaming both ways; a node failure becomes a 502 saying why. */
  forward(incoming, outgoing) {
    if (incoming.method === 'OPTIONS') {
      outgoing.writeHead(204, LocalnetProxy.CORS_HEADERS).end();
      return;
    }
    const headers = { ...incoming.headers, host: this.nodeUrl.host, 'x-network': LocalnetProxy.NETWORK_NAME };
    delete headers.origin; // the node needs no CORS of its own here
    const upstream = request({ hostname: this.nodeUrl.hostname, port: this.nodeUrl.port, path: incoming.url, method: incoming.method, headers }, (reply) => {
      const replyHeaders = { ...reply.headers, ...LocalnetProxy.CORS_HEADERS };
      outgoing.writeHead(reply.statusCode, replyHeaders);
      reply.pipe(outgoing);
    });
    upstream.on('error', (error) => {
      console.log(`${incoming.method} ${incoming.url}: ${error.message}`);
      if (!outgoing.headersSent) outgoing.writeHead(502, LocalnetProxy.CORS_HEADERS);
      outgoing.end(`localnet proxy: ${error.message}`);
    });
    incoming.pipe(upstream);
  }

  run() {
    createServer((incoming, outgoing) => this.forward(incoming, outgoing)).listen(this.port, '127.0.0.1', () => {
      console.log(`localnet proxy on http://127.0.0.1:${this.port} → ${this.nodeUrl.href}`);
    });
  }
}

new LocalnetProxy({ port: Number(process.argv[2] ?? 1985), nodeUrl: process.argv[3] ?? 'http://127.0.0.1:1984' }).run();
