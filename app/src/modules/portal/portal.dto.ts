import { z } from 'zod';
import { TICKET_PRIORITY } from './portal.constants';

const t = (n: number) => z.string().trim().max(n);

/**
 * POST /api/portal/tickets — a portal CUSTOMER raises a service ticket. The
 * customer_id is NEVER taken from the body: it is the caller's linked customer
 * (sec.app_user.customer_id) so a portal user can only ever raise a ticket against
 * themselves. priority defaults to MED; subject is the issue text (persisted as the
 * ticket's resolution/notes column). Tenant / branch / user come from context.
 */
export const raiseTicketSchema = z.object({
  priority: z.enum(TICKET_PRIORITY).optional(),
  subject: t(4000).min(1, 'Describe the issue').optional(),
});
export type RaiseTicketDto = z.infer<typeof raiseTicketSchema>;
