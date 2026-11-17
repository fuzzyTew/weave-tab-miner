// build_single_file.mjs — joins the page, its library modules, the VDF worker and the sample
// block into one HTML file that opens by double-click, with no web server.
// Run: node build_single_file.mjs   (writes weave-tab-miner.html next to this script)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

class SingleFileBuilder {
  /**
   * Inlines ES modules by concatenation: each module's `import … from './x.js'` statements
   * are dropped and its `export` keywords removed, in dependency order, so one inline
   * <script type="module"> holds them all. This works because the modules share no
   * conflicting top-level names; a name clash would show up as a SyntaxError on load.
   */
  static LIBRARY_ORDER = [
    'arweave_miner.js', 'arweave_gateway.js', 'arweave_wallet.js', 'arweave_transaction.js', 'arweave_randomx.js',
    'arweave_storage.js', 'arweave_peers.js', 'arweave_vdf_client.js', 'arweave_citations.js',
  ];
  static RANDOMX_BUNDLE = 'vendor/randomx-arweave/randomx-arweave.iife.js';

  constructor(sourceDirectory) {
    this.sourceDirectory = sourceDirectory;
  }

  read(name) {
    return readFileSync(join(this.sourceDirectory, name), 'utf8');
  }

  static withoutModuleSyntax(source) {
    return source
      .replace(/^import\s[\s\S]*?from\s+'\.\/[^']+';[ \t]*\n/gm, '')
      .replace(/^export\s+(class|const|function|async function)\s/gm, '$1 ');
  }

  // "</script" inside inlined text would end the script element early.
  static safeForScriptElement(text) {
    return text.replace(/<\/script/gi, '<\\/script');
  }

  inlinedModules(names) {
    return names.map((name) => `// ---- ${name} ----\n${SingleFileBuilder.withoutModuleSyntax(this.read(name))}`).join('\n');
  }

  build() {
    const library = this.inlinedModules(SingleFileBuilder.LIBRARY_ORDER);
    const pageScript = SingleFileBuilder.safeForScriptElement(`${library}\n${this.inlinedModules(['miner_app.js'])}`);
    const workerScript = SingleFileBuilder.safeForScriptElement(this.inlinedModules(['arweave_miner.js', 'vdf_worker.js']));
    // The RandomX worker: the bundle (a classic script defining RandomxArweave), then the
    // library pieces it uses, then the worker body.
    const randomxWorkerScript = SingleFileBuilder.safeForScriptElement(
      `${this.read(SingleFileBuilder.RANDOMX_BUNDLE)}\n${this.inlinedModules(['arweave_miner.js', 'arweave_randomx.js', 'randomx_worker.js'])}`);
    const sampleBlock = SingleFileBuilder.safeForScriptElement(this.read('sample_block.json'));
    const permaweb = SingleFileBuilder.safeForScriptElement(this.read('permaweb.json'));

    const pageBody = this.read('index.html').replace(
      /<script type="module" src="\.\/miner_app\.js"><\/script>/,
      [
        `<script type="application/json" id="sampleBlockData">${sampleBlock}</script>`,
        `<script type="application/json" id="permawebData">${permaweb}</script>`,
        `<script type="text/plain" id="vdfWorkerSource">${workerScript}</script>`,
        `<script type="text/plain" id="randomxWorkerSource">${randomxWorkerScript}</script>`,
        `<script type="module">\n${pageScript}\n</script>`,
      ].join('\n'),
    );
    if (pageBody.includes('src="./miner_app.js"')) throw new Error('index.html no longer has the expected miner_app.js script tag');

    // index.html is written for a host that adds the document skeleton; a standalone file needs its own.
    return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${pageBody}\n</body>\n</html>\n`;
  }

  run() {
    const outputPath = join(this.sourceDirectory, 'weave-tab-miner.html');
    const html = this.build();
    writeFileSync(outputPath, html);
    console.log(`wrote ${outputPath} (${(html.length / 1024).toFixed(0)} KiB)`);
  }
}

new SingleFileBuilder(dirname(fileURLToPath(import.meta.url))).run();
