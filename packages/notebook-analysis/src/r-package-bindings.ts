import { z } from 'zod'
export const rPackageBindingsSchema = z
  .object({
    before: z.array(z.string().max(128)).max(128),
    after: z.array(z.string().max(128)).max(128),
    reads: z
      .array(z.object({ name: z.string().max(256), package: z.string().max(128) }).strict())
      .max(256),
    complete: z.boolean(),
    // First request in a --vanilla R loop; legacy observations cannot attest this.
    cleanSession: z.boolean().optional()
  })
  .strict()
  .optional()
