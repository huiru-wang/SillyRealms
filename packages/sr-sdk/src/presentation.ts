/** Author-declared player presentation; it is never implicit model context. */
export type Presentation =
  | { type: 'markdown'; text: string }
  | { type: 'component'; component: string };
