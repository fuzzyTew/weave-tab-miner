// test/library-index.test.mjs — the library's entry point exports every module under src/
// (workers aside, which are entry points of their own), so a module added later cannot be
// left out, and importing it all works. Run: node test/library-index.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

class LibraryIndexTest {
  static SOURCE = fileURLToPath(new URL('../src', import.meta.url));

  /** Every module path under src/, relative to it, except the index and workers. */
  static modules(directory = LibraryIndexTest.SOURCE) {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return name === 'workers' ? [] : LibraryIndexTest.modules(path);
      return name.endsWith('.js') ? [relative(LibraryIndexTest.SOURCE, path)] : [];
    }).filter((path) => path !== 'index.js');
  }

  async run() {
    const index = readFileSync(join(LibraryIndexTest.SOURCE, 'index.js'), 'utf8');
    const missing = LibraryIndexTest.modules().filter((path) => !index.includes(`'./${path}'`));
    console.log(`${missing.length ? 'FAIL' : 'PASS'}  src/index.js exports every module${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
    let loaded = false;
    try {
      loaded = Object.keys(await import('../src/index.js')).length > 0;
    } catch (error) {
      console.log(`      ${error.message}`);
    }
    console.log(`${loaded ? 'PASS' : 'FAIL'}  importing the whole library works`);
    process.exitCode = missing.length || !loaded ? 1 : 0;
  }
}

await new LibraryIndexTest().run();
