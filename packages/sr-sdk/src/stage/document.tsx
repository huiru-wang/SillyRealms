import {WorldDocumentRenderer as DocumentContent} from '../world-document/WorldDocumentRenderer.js';

export type WorldDocumentRendererProps = {
  content: string;
  density?: 'reading' | 'chat';
  className?: string;
};

/** The Stage is already isolated. Documents render within it, never in a nested iframe. */
export function WorldDocumentRenderer({content, density = 'reading', className = ''}: WorldDocumentRendererProps) {
  return <DocumentContent content={content} presentation="inline" density={density} className={className}/>;
}
