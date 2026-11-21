/** The existing api() helper unwraps Server's HTTP envelope. */
export type HttpRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
export type SharedHttpRequest = HttpRequest;
