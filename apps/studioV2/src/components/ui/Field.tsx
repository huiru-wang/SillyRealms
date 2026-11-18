import {cloneElement,useId,type ReactElement,type InputHTMLAttributes,type TextareaHTMLAttributes,type HTMLAttributes,type Ref,type ReactNode} from 'react';
type ControlProps={id?:string;'aria-describedby'?:string;'aria-invalid'?:boolean};
export function Field({label,description,error,children}:{label:string;description?:string;error?:string;children:ReactElement<ControlProps>}){
 const generated=useId(),id=children.props.id??generated;
 const described=[children.props['aria-describedby'],description?id+'-description':null,error?id+'-error':null].filter(Boolean).join(' ')||undefined;
 return <div className="sr-field"><label htmlFor={id}>{label}</label>{cloneElement(children,{id,'aria-describedby':described,'aria-invalid':!!error})}{description&&<p id={id+'-description'} className="sr-field-description">{description}</p>}{error&&<p id={id+'-error'} className="sr-field-error" role="alert">{error}</p>}</div>;
}
export function Input({className='',...props}:InputHTMLAttributes<HTMLInputElement>&{ref?:Ref<HTMLInputElement>}){return <input {...props} className={'sr-input '+className}/>;}
export function Textarea({className='',...props}:TextareaHTMLAttributes<HTMLTextAreaElement>&{ref?:Ref<HTMLTextAreaElement>}){return <textarea {...props} className={'sr-input sr-textarea '+className}/>;}
export function Panel({className='',...props}:HTMLAttributes<HTMLElement>){return <section {...props} className={'sr-panel '+className}/>;}
export function Badge({children,intent='neutral'}:{children:ReactNode;intent?:'neutral'|'success'|'danger'|'warning'}){return <span className="sr-badge" data-intent={intent}>{children}</span>;}
