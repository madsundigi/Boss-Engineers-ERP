import { FollowupType, FollowupChannel, FollowupStatus, FollowupUrgency } from './followup.constants';

/**
 * A persisted follow-up row (camelCase projection of sales.enquiry_followup),
 * enriched on read with the parent enquiry number + customer, the owner's name,
 * and the DERIVED daysRemaining / urgency (computed in SQL, never stored).
 */
export interface Followup {
  followupId: number;
  enquiryId: number;
  enquiryNo: string | null;
  customerName: string | null;
  seq: number;
  followupType: FollowupType;
  channel: FollowupChannel | null;
  channelOther: string | null;
  location: string | null;
  scheduledDate: string;
  notes: string | null;
  status: FollowupStatus;
  outcome: string | null;
  assignedTo: number | null;
  assignedToName: string | null;
  completedAt: string | null;
  completedBy: number | null;
  daysRemaining: number;
  urgency: FollowupUrgency;
  createdAt: string;
  rowVersion: number;
}

export interface FollowupListResult {
  rows: Followup[];
}

/** Dashboard payload: the PENDING follow-ups (with urgency) + an urgency roll-up. */
export interface FollowupDashboard {
  rows: Followup[];
  summary: {
    due: number;
    upcoming: number;
    missed: number;
  };
}
