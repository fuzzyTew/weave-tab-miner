// apps/browser/resources.js — The data the single-file build embeds in the page, and the page-download panel.

export class BundledResources {
  /**
   * The sample block and the workers' source texts are embedded in the page by
   * scripts/build-single-file.mjs, so it opens from disk with no web server. Workers are made from
   * blob: URLs and run as classic scripts: Chromium refuses module workers from blob: URLs
   * on pages opened from file://.
   */
  static embeddedText(elementId) {
    const text = document.getElementById(elementId)?.textContent;
    if (!text) throw new Error(`the page is missing its embedded ${elementId}; open the built weave-tab-miner.html`);
    return text;
  }

  /**
   * Gateways and nodes that answered from GitHub's runners when the page was built
   * (scripts/gather-sources.mjs), as { gatheredAt, gateways, nodes }; an empty list when missing.
   */
  static gatheredSources() {
    try {
      return JSON.parse(BundledResources.embeddedText('sourcesData'));
    } catch {
      return { gatheredAt: null, gateways: [], nodes: [], vdfServers: [] };
    }
  }

  /** The shared key published with the page (data/public-key.json). */
  static publicKey() {
    return JSON.parse(BundledResources.embeddedText('publicKeyData'));
  }

  static sampleBlock() {
    return JSON.parse(BundledResources.embeddedText('sampleBlockData'));
  }

  static worker(elementId) {
    return new Worker(URL.createObjectURL(new Blob([BundledResources.embeddedText(elementId)], { type: 'text/javascript' })));
  }
}

export class RunYourself {
  /**
   * Fills the "Run it yourself" panel: a download link when the page came from a web
   * server, and a link to its permanent Arweave copy once one exists (data/permaweb.json).
   */
  static GATEWAYS_FOR_LINKS = ['https://arweave.net', 'https://turbo-gateway.com'];

  constructor(view) {
    this.view = view;
  }

  show() {
    const link = this.view.elements.downloadLink;
    if (location.protocol === 'file:') {
      link.hidden = true;
      this.view.setText('downloadNote', 'You are running a copy from your own disk, which can also reach Arweave nodes directly.');
    } else {
      // Same-origin links honour the download attribute, saving the page as it was served.
      link.href = location.href.split('#')[0];
      this.view.setText('downloadNote', 'Save it and open the file from your disk: it runs with no server, keeps working if this site goes away, and can reach Arweave nodes directly.');
    }

    const { transactionId } = JSON.parse(BundledResources.embeddedText('permawebData'));
    const list = this.view.elements.permawebLinks;
    list.replaceChildren();
    if (!transactionId) {
      this.view.setText('permawebNote', 'Not stored on Arweave yet. Storing this page (about 1 MB) costs a small amount of AR, paid once; whoever pays can put the transaction id in data/permaweb.json, and the next build links to it here, from any gateway.');
      return;
    }
    this.view.setText('permawebNote', `Stored permanently on Arweave as transaction ${transactionId}. Any gateway serves the same bytes:`);
    for (const gateway of RunYourself.GATEWAYS_FOR_LINKS) {
      const item = document.createElement('li');
      const anchor = document.createElement('a');
      anchor.href = `${gateway}/${transactionId}`;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.textContent = anchor.href;
      item.append(anchor);
      list.append(item);
    }
  }
}
