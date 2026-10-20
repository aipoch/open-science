/** Only domain-authored messages belong to this class; IO errors remain untrusted. */
export class SpecialistError extends Error {}
export const specialistError = (message: string): SpecialistError => new SpecialistError(message)
