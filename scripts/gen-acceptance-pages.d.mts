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
