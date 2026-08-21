import { z } from 'zod'
import type { DomainSpec as OfficialDomainSpec } from '@deepseek-ai/dsh-storage-domain'
import {
  CALL_STATUSES,
  CALLS_TABLE,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  FAILURE_CATEGORIES,
  POLICIES_TABLE,
  PURPOSES,
} from './constants.ts'
import type { CallRecord, PolicyRecord } from './types.ts'

export const usageBucketsSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

export const failureFactSchema = z.object({
  category: z.enum(FAILURE_CATEGORIES),
  code: z.string().min(1),
}).strict()

export const callRecordSchema: z.ZodType<CallRecord> = z.object({
  callId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionCreatedAt: z.number().int().nonnegative(),
  purpose: z.enum(PURPOSES),
  status: z.enum(CALL_STATUSES),
  usage: usageBucketsSchema,
  usageRecorded: z.boolean(),
  failure: failureFactSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((row, ctx) => {
  if (!row.usageRecorded && Object.values(row.usage).some((value) => value !== 0)) {
    ctx.addIssue({
      code: 'custom',
      message: 'usage must be zero until a provider usage chunk is recorded',
      path: ['usage'],
    })
  }
})

export const policyRecordSchema: z.ZodType<PolicyRecord> = z.object({
  sessionId: z.string().min(1),
  sessionCreatedAt: z.number().int().nonnegative(),
  maxConcurrentCalls: z.number().int().nonnegative(),
  maxCallsPerSession: z.number().int().nonnegative(),
  maxAuxiliaryTotalTokens: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

export const reservationSchema = usageBucketsSchema

export const policyInputSchema = z.object({
  maxConcurrentCalls: z.number().int().nonnegative(),
  maxCallsPerSession: z.number().int().nonnegative(),
  maxAuxiliaryTotalTokens: z.number().int().nonnegative(),
}).strict()

export const auxiliaryRuntimeDomain = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  tables: {
    [CALLS_TABLE]: { valueSchema: callRecordSchema },
    [POLICIES_TABLE]: { valueSchema: policyRecordSchema },
  },
} as const satisfies OfficialDomainSpec
