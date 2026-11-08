import React from 'react';
import {marked} from 'marked';
import DOMPurify from 'dompurify';

/** Safe static Markdown/HTML presentation. */
export function RichText({text}:{text:string}) {
  return <div className="sr-rich" dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(marked.parse(text,{async:false,breaks:true}) as string)}}/>;
}
