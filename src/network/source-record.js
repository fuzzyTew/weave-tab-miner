// src/network/source-record.js — each source's track record for one kind of request, so
// the sources that answer are asked first, whoever runs them (a gateway or a node).

export class SourceRecord {
  /**
   * Counts, per source address, how often it served a request and how often it failed
   * (not found, an error, or too slow), and ranks sources by that.
   *
   * The rank is the Laplace estimate of the chance it serves the next one:
   * (served + 1) / (served + failed + 2). An untried source scores one half, so it ranks
   * above any source that has failed more than it served and below any that served more:
   * new sources still get tried, and a bad one drops back after a failure or two. Ties
   * keep the order they were given in, so the caller's preference decides among equals.
   *
   * More accurate would be to weigh recent results more (a source can go down or catch
   * up) and to know which byte ranges each source holds (nodes publish theirs at
   * /data_sync_record); this counts all results alike and knows nothing of ranges.
   */

  constructor() {
    this.countsBySource = new Map();
  }

  countsFor(sourceUrl) {
    let counts = this.countsBySource.get(sourceUrl);
    if (!counts) this.countsBySource.set(sourceUrl, counts = { served: 0, failed: 0 });
    return counts;
  }

  /** Notes one request's outcome: `served` true when the source answered with the thing asked for. */
  record(sourceUrl, served) {
    this.countsFor(sourceUrl)[served ? 'served' : 'failed']++;
  }

  /** The Laplace estimate described on the class, in 0..1. */
  score(sourceUrl) {
    const counts = this.countsBySource.get(sourceUrl);
    return counts ? (counts.served + 1) / (counts.served + counts.failed + 2) : 0.5;
  }

  /** `sourceUrls` best first; equal scores keep their given order. */
  ranked(sourceUrls) {
    return sourceUrls
      .map((sourceUrl, index) => ({ sourceUrl, index, score: this.score(sourceUrl) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((entry) => entry.sourceUrl);
  }

  /** One line for a log, best first: "host served of asked" for each source tried. */
  summary() {
    return this.ranked([...this.countsBySource.keys()])
      .map((sourceUrl) => {
        const { served, failed } = this.countsBySource.get(sourceUrl);
        return `${new URL(sourceUrl).host} ${served} of ${served + failed}`;
      })
      .join(', ');
  }
}
