/** The existing api() helper unwraps ServerV2's HTTP envelope. */
export type HttpRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
export type SharedHttpRequest = HttpRequest;
