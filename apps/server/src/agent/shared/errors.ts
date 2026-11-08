export class RuntimeError extends Error {
  constructor(public code: string, public details?: Record<string, string>) { super(code); }
}
