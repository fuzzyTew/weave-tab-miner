// src/storage/storage-allowance.js — how much a site may store, from the browser's estimate
// and the person's setting. Pure: no DOM and no storage calls, so any front end (a page, a
// node app, another language's port) can share the same rules and test them alone.

import { ConsensusConstants } from '../core/constants.js';

export class StorageAllowance {
  /**
   * The browser's storage allowance and the person's setting for how much of it to fill.
   *
   * `setting` is "max" (all that may be used, following the allowance as it grows) or a
   * number of bytes. `estimate` is navigator.storage.estimate()'s {quota, usage}, or null
   * before it is known (or where the browser does not report one).
   */

  /** Settings round to this many bytes, so typed and slid amounts land on whole steps. */
  static STEP_BYTES = 64 * 2 ** 20;

  /**
   * The share of the allowance chunks may fill. The allowance is an estimate, writes close
   * to it fail, and the saved chain state (tens of MB) and other site data need room too,
   * so the last tenth is left free.
   */
  static USABLE_SHARE = 0.9;

  /** Bytes Chrome adds to a site's usage to report its quota (its "predictable" figure, hiding incognito). */
  static CHROME_REPORTED_HEADROOM = 10 * 2 ** 30;

  constructor({ estimate = null, setting = 'max' } = {}) {
    this.estimate = estimate;
    this.setting = setting;
  }

  /**
   * Whether `estimate` is Chrome's usage-plus-10-GiB figure rather than a real limit. A
   * real limit of exactly usage + 10 GiB (Firefox's 10 GiB cap on an empty site) reads as
   * floating too; then writes past it fail, and the caller's failed-save stop applies.
   */
  static isFloatingQuota(estimate) {
    return Math.abs(estimate.quota - (estimate.usage ?? 0) - StorageAllowance.CHROME_REPORTED_HEADROOM) < 2 ** 20;
  }

  /** A saved setting's text ("max" or bytes) back to a setting; anything else is "max". */
  static parseSetting(text) {
    return Number(text) > 0 ? Number(text) : 'max';
  }

  /** `bytes` rounded to whole steps, at least one step. */
  static roundedToStep(bytes) {
    const step = StorageAllowance.STEP_BYTES;
    return Math.max(step, Math.round(bytes / step) * step);
  }

  get quotaBytes() {
    return this.estimate?.quota ?? null;
  }

  /** True where the browser's figure grows with use (Chrome's), so it is not a cap. */
  get quotaFloats() {
    return Boolean(this.estimate && StorageAllowance.isFloatingQuota(this.estimate));
  }

  /** The whole allowance in whole steps (a slider's track), or null before it is known. */
  get wholeBytes() {
    const step = StorageAllowance.STEP_BYTES;
    return this.quotaBytes ? Math.max(step, Math.floor(this.quotaBytes / step) * step) : null;
  }

  /** The usable share of the allowance in whole steps, or null before it is known. */
  get usableBytes() {
    const step = StorageAllowance.STEP_BYTES;
    return this.quotaBytes ? Math.max(step, Math.floor(this.quotaBytes * StorageAllowance.USABLE_SHARE / step) * step) : null;
  }

  /**
   * Bytes to fill toward, or null before the allowance is known with "max" set. "max" is
   * the usable share; a set amount is kept as set, except where the browser's figure is a
   * real limit (Firefox's), which caps it. Chrome's figure floats above what is used, so an
   * amount past it is honoured.
   */
  get targetBytes() {
    const usable = this.usableBytes;
    if (this.setting === 'max') return usable;
    return this.quotaFloats || usable === null ? this.setting : Math.min(this.setting, usable);
  }

  /** The setting a slider position picks: "max" at or past the usable share, else the bytes. */
  settingForPosition(bytes) {
    const usable = this.usableBytes;
    return usable && bytes >= usable ? 'max' : bytes;
  }

  /**
   * Chunks still to fetch to reach the target, given what is held; at most `chunkLimit`
   * held chunks in all when one is set (a localnet's). 0 when reached or not yet known.
   * `targetBytes` stands in for the target, e.g. a front end's own default before the
   * allowance is known.
   */
  chunksToReach({ heldBytes, heldChunkCount, chunkLimit = null, targetBytes = this.targetBytes }) {
    const target = targetBytes;
    if (target === null) return 0;
    const toTarget = Math.ceil((target - heldBytes) / ConsensusConstants.DATA_CHUNK_SIZE);
    return Math.max(0, chunkLimit === null ? toTarget : Math.min(toTarget, chunkLimit - heldChunkCount));
  }
}
