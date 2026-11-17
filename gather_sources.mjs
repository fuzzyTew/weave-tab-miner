// gather_sources.mjs — writes sources.json: Arweave gateways and nodes that answered from
// this machine, for the page to embed as seeds. Meant for GitHub's runners, which can reach
// Arweave; on a machine that cannot, it keeps the existing file. Run:
//   node gather_sources.mjs [sources.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { SourceGatherer } from './arweave_peers.js';

class GatherSourcesApp {
  constructor(outputPath = 'sources.json') {
    this.outputPath = outputPath;
  }

  async run() {
    const gathered = await new SourceGatherer({ log: (message) => console.log(message) }).gather();
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
