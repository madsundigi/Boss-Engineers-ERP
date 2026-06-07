import { z } from 'zod';

/**
 * Login credentials. companyId/buId are optional: when a user is linked to an
 * employee we derive the company from that record; a user may still pass an
 * explicit company (multi-company login) and an optional business unit (the
 * document-numbering scope carried in the issued token).
 */
export const loginSchema = z.object({
  username: z.string().min(1).max(60),
  password: z.string().min(1).max(200),
  companyId: z.coerce.number().int().positive().optional(),
  buId: z.coerce.number().int().positive().optional(),
});

export type LoginDto = z.infer<typeof loginSchema>;
