import { z } from 'zod';

import { ERROR_CODES } from './errors.js';
import { PROPOSAL_STATUSES, SOURCE_DIALECTS, SOURCE_TEST_ERROR_CODES } from './types.js';

export const PASSWORD_MIN_LENGTH = 12;
export const SQL_MAX_LENGTH = 64 * 1024;

export const errorCodeSchema = z.enum(
  Object.values(ERROR_CODES) as [string, ...string[]],
);

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  request_id: z.string(),
});

export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export const sourceDialectSchema = z.enum(SOURCE_DIALECTS);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(1024)
  .regex(/[A-Za-z]/, 'password must contain a letter')
  .regex(/[0-9]/, 'password must contain a digit');

export const setupRequestSchema = z
  .object({
    password: passwordSchema,
    confirm: z.string().max(1024),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.password !== value.confirm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirm'],
        message: 'password confirmation does not match',
      });
    }
  });

export const unlockRequestSchema = z
  .object({
    password: z.string().min(1).max(1024),
  })
  .strict();

export const changePasswordRequestSchema = z
  .object({
    current: z.string().min(1).max(1024),
    new: passwordSchema,
  })
  .strict();

export const sourceConnectionSchema = z
  .object({
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().max(1024).optional(),
    username: z.string().max(255).optional(),
    password: z.string().max(2048).optional(),
    file: z.string().max(4096).optional(),
  })
  .passthrough();

export const sourceCreateRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    dialect: sourceDialectSchema,
    connection: sourceConnectionSchema.optional(),
  })
  .strict();

/**
 * Partial source update. The cross-field rule "changing dialect requires a
 * connection" is enforced by the HTTP layer, which can compare against the
 * persisted dialect (passing the *same* dialect alone is a harmless no-op).
 */
export const sourceUpdateRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    dialect: sourceDialectSchema.optional(),
    connection: sourceConnectionSchema.optional(),
  })
  .strict();

export const sourceTestResponseSchema = z.object({
  ok: z.boolean(),
  latency_ms: z.number().int().min(0),
  server: z.string().max(200).optional(),
  readonly: z.object({
    ok: z.boolean(),
    checked: z.boolean(),
    details: z.array(z.string().max(300)),
  }),
  error_code: z.enum(SOURCE_TEST_ERROR_CODES).optional(),
  db_error_number: z.number().int().optional(),
});

export const proposalCreateRequestSchema = z
  .object({
    source_id: z.string().min(1).max(200),
    sql: z.string().max(SQL_MAX_LENGTH),
    purpose: z.string().max(500).optional(),
    params: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
    max_rows: z.number().int().min(1).max(5000).optional(),
    timeout_s: z.number().int().min(1).max(120).optional(),
    request_key: z.string().min(1).max(200).optional(),
  })
  .strict();

export const proposalCreateResponseSchema = z.object({
  id: z.string(),
  status: proposalStatusSchema,
  expires_at: z.string(),
});

export const rejectRequestSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});

export const adminStateResponseSchema = z.object({
  configured: z.boolean(),
  unlocked: z.boolean(),
  version: z.string(),
});

export const setupResponseSchema = z.object({
  ok: z.literal(true),
  agent_token: z.string().optional(),
});

export const unlockResponseSchema = z.object({
  ok: z.literal(true),
  csrfToken: z.string(),
  expiresAt: z.string(),
  token: z.string().optional(),
});

export const proposalResponseSchema = z.object({
  id: z.string(),
  status: proposalStatusSchema,
  expires_at: z.string(),
});

export const sourceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  dialect: sourceDialectSchema,
});

export const sourceListResponseSchema = z.array(sourceSummarySchema);

export const CLIENT_NAME_MAX_LENGTH = 100;

/**
 * Agent token creation. The name is trimmed first, so a whitespace-only name
 * is rejected by the same 1..100 bound as an empty one.
 */
export const clientCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(CLIENT_NAME_MAX_LENGTH),
  })
  .strict();

/** Returned exactly once by `POST /v1/admin/clients`; never listed later. */
export const clientCreateResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  created_at: z.string(),
});

export const clientSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  disabled: z.number().int(),
});

export const clientListResponseSchema = z.array(clientSummarySchema);

export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type UnlockRequest = z.infer<typeof unlockRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type SourceCreateRequest = z.infer<typeof sourceCreateRequestSchema>;
export type SourceUpdateRequest = z.infer<typeof sourceUpdateRequestSchema>;
export type SourceTestResponse = z.infer<typeof sourceTestResponseSchema>;
export type ClientCreateRequest = z.infer<typeof clientCreateRequestSchema>;
export type ClientCreateResponse = z.infer<typeof clientCreateResponseSchema>;
export type ClientSummaryResponse = z.infer<typeof clientSummarySchema>;
export type ProposalCreateRequest = z.infer<typeof proposalCreateRequestSchema>;
export type ProposalCreateResponse = z.infer<typeof proposalCreateResponseSchema>;
export type RejectRequest = z.infer<typeof rejectRequestSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type AdminStateResponse = z.infer<typeof adminStateResponseSchema>;
export type SetupResponse = z.infer<typeof setupResponseSchema>;
export type UnlockResponse = z.infer<typeof unlockResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
