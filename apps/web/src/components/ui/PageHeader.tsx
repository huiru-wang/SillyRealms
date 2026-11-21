import type {ReactNode} from 'react';
export function PageHeader({title,description,actions,className='',identityClassName=''}:{title:string;description?:string;actions?:ReactNode;className?:string;identityClassName?:string}){
 return <header className={'sr-page-header '+className} data-page-header>
  <div className={'sr-page-title '+identityClassName}><h1>{title}</h1></div>
  {actions&&<div className="sr-page-actions">{actions}</div>}
  {description&&<p className="sr-page-description">{description}</p>}
 </header>;
}
