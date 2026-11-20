import {useRef,type ButtonHTMLAttributes,type AnchorHTMLAttributes,type InputHTMLAttributes,type Ref,type ReactNode} from 'react';
export type ButtonVariant='primary'|'secondary'|'ghost'|'text';
export type ButtonSize='compact'|'standard'|'prominent';
type Appearance={variant?:ButtonVariant;intent?:'neutral'|'danger';size?:ButtonSize};
type Props=ButtonHTMLAttributes<HTMLButtonElement>&{ref?:Ref<HTMLButtonElement>}&Appearance&{icon?:ReactNode;children?:ReactNode;loading?:boolean;};
export function Button({children,icon,variant='secondary',intent='neutral',size='standard',loading=false,disabled,className='',type='button',...rest}:Props){
 return <button {...rest} type={type} disabled={disabled||loading} aria-busy={loading||undefined} className={'sr-button '+className} data-variant={variant} data-intent={intent} data-size={size}>
  {loading?<span className="sr-spinner" aria-hidden="true"/>:icon&&<span className="sr-button-icon" aria-hidden="true">{icon}</span>}<span className="sr-button-label">{children}</span>
 </button>;
}
export function IconButton({children,icon,variant='ghost',className='',...props}:Omit<Props,'children'>&{'aria-label':string;children?:ReactNode}){
 return <Button {...props} variant={variant} className={'sr-icon-button '+className} icon={icon??children}/>;
}
export function ActionLink({children,variant='secondary',intent='neutral',size='standard',className='',...props}:AnchorHTMLAttributes<HTMLAnchorElement>&Appearance){
 return <a {...props} className={'sr-button '+className} data-variant={variant} data-intent={intent} data-size={size}>{children}</a>;
}
export function UploadButton({children,accept,onChange,disabled,loading,...props}:Omit<Props,'onChange'>&Pick<InputHTMLAttributes<HTMLInputElement>,'accept'|'onChange'>){
 const input=useRef<HTMLInputElement>(null);
 return <><Button {...props} disabled={disabled} loading={loading} onClick={()=>input.current?.click()}>{children}</Button>
 <input ref={input} type="file" hidden disabled={disabled||loading} accept={accept} aria-label={props['aria-label']??'选择导入文件'} onChange={event=>{onChange?.(event);event.currentTarget.value='';}}/></>;
}
