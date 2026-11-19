// scripts/gather-sources.mjs — writes data/sources.json: Arweave gateways and nodes that answered from
// this machine, for the page to embed as seeds. Meant for GitHub's runners, which can reach
// Arweave; on a machine that cannot, it keeps the existing file. Run:
//   node scripts/gather-sources.mjs [data/sources.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { SourceGatherer } from '../src/network/peers.js';
import { VdfServerClient } from '../src/network/vdf-client.js';

class GatherSourcesApp {
  constructor(outputPath = new URL('../data/sources.json', import.meta.url)) {
    this.outputPath = outputPath;
  }

  /** The public VDF servers by IP address, port 1984, for pages a browser forces to https by name. */
  async publicVdfServersByAddress() {
    const hosts = [...new Set(VdfServerClient.PUBLIC_SERVER_URLS.map((url) => new URL(url).hostname))];
    const urls = [];
    for (const host of hosts) {
      try {
        for (const { address, family } of await lookup(host, { all: true })) {
          if (family === 4) urls.push(`http://${address}:1984`);
        }
      } catch (error) {
        console.log(`could not look up ${host}: ${error.message}`);
      }
    }
    console.log(`public VDF servers by address: ${urls.join(', ') || 'none'}`);
    return urls;
  }

  async run() {
    const gathered = await new SourceGatherer({ log: (message) => console.log(message) }).gather({ extraVdfCandidates: await this.publicVdfServersByAddress() });
    if (!gathered.gateways.length && !gathered.nodes.length) {
      // Writing an empty list would replace a useful one with nothing.
      console.log(`nothing answered; keeping ${this.outputPath} as it was (gathered ${this.previousDate()})`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(this.outputPath, `${JSON.stringify(gathered, null, 1)}\n`);
    console.log(`wrote ${gathered.gateways.length} gateways and ${gathered.nodes.length} nodes to ${this.outputPath}`);
  }

  previousDate() {
    try {
      return JSON.parse(readFileSync(this.outputPath, 'utf8')).gatheredAt ?? 'never';
    } catch (error) {
      return `unreadable: ${error.message}`;
    }
  }
}

await new GatherSourcesApp(process.argv[2]).run();
