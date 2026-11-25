export const standaloneContactLine = /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/u
export const terminal = (text: string): boolean => /[.!?:;][”’"')\]]?$/.test(text.trim())
export const wordCount = (text: string): number => text.trim().split(/\s+/).length
