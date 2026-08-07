import { availableParallelism } from "node:os";

export const maxAutomaticJobs = 8;

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
