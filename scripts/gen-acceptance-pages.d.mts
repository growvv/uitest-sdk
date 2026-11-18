/** Types for the acceptance page generator; it runs on CI's Node without a build. */
export interface AcceptanceCase {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  screenshots: string[];
}

export interface AcceptanceReport {
  product: "core" | "phone" | "console" | "mirror";
  version: string;
  date: string;
  commit: string;
  devices: { tag: string; model: string; resolution: string }[];
  cases: AcceptanceCase[];
  summary: { passed: number; failed: number; skipped: number };
  rerun: string[];
  issues: string[];
}

export interface HubEntry {
  product: string;
  version: string;
  href: string;
  date: string;
  summary: { passed: number; failed: number; skipped: number };
}

export const PRODUCT_NAMES: Record<string, string>;
export function renderReportPage(report: AcceptanceReport): string;
export function renderHubPage(reports: HubEntry[]): string;
/**
 * The products whose current version has no report. A non-empty result is a
 * release failure: the generator exits 1 on it.
 */
export function unacceptedVersions(
  versions: Record<string, string>,
  reports: { product: string; version: string }[],
): { product: string; version: string }[];
