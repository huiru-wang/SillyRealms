export function Switch({id,checked,onChange,label,describedBy,disabled=false}:{id?:string;checked:boolean;onChange:(value:boolean)=>void;label:string;describedBy?:string;disabled?:boolean}){
 return <button id={id} type="button" disabled={disabled} className="sr-switch" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} onClick={()=>onChange(!checked)}><span className="sr-switch-track"><span/></span></button>;
}
