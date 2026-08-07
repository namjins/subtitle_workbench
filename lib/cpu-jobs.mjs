import { availableParallelism } from "node:os";

/**
 * Ceiling for automatically chosen concurrency.
 *
 * This was 8, which meant "auto" ignored most of a large machine: on a 24-core
 * host it still ran 8 workers and left two thirds of the CPU idle. The point of
 * the policy is to leave the machine usable, not to pick a small fixed number,
 * so the ceiling is high enough to scale and low enough that memory stays
 * reasonable (each worker runs its own tesseract).
 */
export const maxAutomaticJobs = 16;

/**
 * Reserve one core so the machine stays responsive, then take what is left up
 * to the ceiling. Explicit `--jobs N` from a human is never clamped by this;
 * only values arriving over the network are (see normalizeJobs `clamp`).
 */
export function detectSafeJobs(options = {}) {
  const cores = Number.isFinite(Number(options.cores))
    ? Number(options.cores)
    : availableParallelism();
  const cap = Number.isFinite(Number(options.max)) ? Number(options.max) : maxAutomaticJobs;
  return Math.max(1, Math.min(cap, Math.floor(cores) - 1 || 1));
}

/**
 * `clamp` bounds an explicit value to the automatic cap. Use it for values that
 * arrive over the network: an unbounded job count there is a way to spawn
 * thousands of OCR subprocesses from one request. A human passing `--jobs 12`
 * on the CLI is taken at their word.
 */
export function normalizeJobs(value, options = {}) {
  if (value === undefined || value === null || value === "" || value === "auto") {
    return detectSafeJobs(options);
  }
  const jobs = Number(value);
  if (!Number.isFinite(jobs)) {
    if (options.strict) {
      throw new Error(`Invalid job count: ${value}. Use a positive number or "auto".`);
    }
    return detectSafeJobs(options);
  }
  const normalized = Math.max(1, Math.floor(jobs));
  if (!options.clamp) return normalized;
  const cap = Number.isFinite(Number(options.max)) ? Number(options.max) : maxAutomaticJobs;
  return Math.min(normalized, cap);
}
