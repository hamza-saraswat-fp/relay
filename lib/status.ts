import type { StatusChip } from "./types";

/**
 * Maps a raw Salesforce Case.Status to the customer-facing chip.
 * Source: Saffi's mapping (IAI-236). Unknown/anything-else → in_progress
 * (safe default — never leaks a raw internal status to the customer).
 */
const RAW_TO_CHIP: Record<string, StatusChip> = {
  "Waiting for Customer": "waiting_for_you",

  New: "waiting_for_support",
  "Waiting for Support": "waiting_for_support",

  "In Progress": "in_progress",
  Hold: "in_progress",
  Monitoring: "in_progress",
  "Waiting for CS": "in_progress",
  "Waiting for Sync": "in_progress",
  "Waiting on Engineering": "in_progress",

  Closed: "resolved",
  "Cannot Reproduce": "resolved",
  Rejected: "resolved",
  Merged: "resolved",
};

export function statusToChip(statusRaw: string): StatusChip {
  return RAW_TO_CHIP[statusRaw.trim()] ?? "in_progress";
}

/** Statuses that count as resolved/closed (drives the closed-last-30d retention window). */
export function isResolvedStatus(statusRaw: string): boolean {
  return statusToChip(statusRaw) === "resolved";
}
