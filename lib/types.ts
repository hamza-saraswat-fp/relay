export type StatusChip =
  | "waiting_for_you"
  | "waiting_for_support"
  | "in_progress"
  | "resolved";

export const CHIP_LABEL: Record<StatusChip, string> = {
  waiting_for_you: "Waiting for You",
  waiting_for_support: "Waiting for Support",
  in_progress: "In Progress",
  resolved: "Resolved",
};

export interface Ticket {
  subject: string;
  chip: StatusChip;
  openedISO: string;
  lastActivityISO: string;
  latestUpdate: string;
  resolvedDateISO?: string;
}

export interface AccountView {
  name: string;
  lastUpdatedISO: string;
  tickets: Ticket[];
}
