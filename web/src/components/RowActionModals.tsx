import { AssignPersonModal } from './AssignPersonModal';
import { FollowupPanel } from './FollowupPanel';

/** A row that may carry the enquiry fields the modals consume. */
export type ActionRow = Record<string, unknown>;

export interface ModalAction {
  kind: 'assignPerson' | 'followups';
  /** resolved enquiry id (via idOf) */
  id: unknown;
  row: ActionRow;
}

interface Props {
  action: ModalAction | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Dispatcher for the in-place row-action modals. ResourceList sets `action` when
 * a clicked rowAction's kind is 'assignPerson' | 'followups'; this maps the kind
 * to the matching modal and threads the enquiry fields off the row.
 */
export function RowActionModals({ action, onClose, onSaved }: Props) {
  if (!action) return null;
  const { kind, id, row } = action;

  if (kind === 'assignPerson') {
    return (
      <AssignPersonModal
        enquiryId={id}
        rowVersion={row.rowVersion}
        currentAssignee={(row.assignedToName as string | null) ?? null}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }

  // kind === 'followups'
  return (
    <FollowupPanel
      enquiryId={id}
      enquiryNo={(row.enquiryNo as string | null) ?? null}
      customerName={(row.customerName as string | null) ?? null}
      onClose={onClose}
    />
  );
}
