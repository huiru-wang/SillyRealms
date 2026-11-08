import React from 'react';
import {WorldDocumentRenderer} from './world-document/WorldDocumentRenderer.js';

/** Safe static Markdown/HTML presentation, retained for SDK compatibility. */
export function RichText({text}:{text:string}) {
  return <WorldDocumentRenderer content={text} presentation="inline"/>;
}
