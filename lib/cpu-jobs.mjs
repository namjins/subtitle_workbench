import { availableParallelism } from "node:os";

export const maxAutomaticJobs = 8;

export function detectSafeJobs(options = {}) {
  const cores = Number.isFinite(Number(options.cores))
    ? Number(options.cores)
    : availableParallelism();
  const cap = Number.isFinite(Number(options.max)) ? Number(options.max) : maxAutomaticJobs;
  return Math.max(1, Math.min(cap, Math.floor(cores) - 1 || 1));
}

export function normalizeJobs(value, options = {}) {
  if (value === undefined || value === null || value === "" || value === "auto") {
    return detectSafeJobs(options);
  }
  const jobs = Number(value);
  return Number.isFinite(jobs) ? Math.max(1, Math.floor(jobs)) : detectSafeJobs(options);
}
