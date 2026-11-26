import {useEffect,useState} from 'react';
import {compileComponents} from '../../../../../packages/sr-ui-compiler/src/index';
import {Modal} from '../../components/ui/Modal';
import {WorldComponentView} from './WorldComponentView';
import {compileWorldComponents} from './compile-world-components';
import {createPreviewCompiler} from './preview-compilation-cache';
import {createPreviewSourceCache,previewContentIdentity,retainPreview,type PreviewEntry} from './preview-cache';
import type {WorldDetail} from './api/worlds';

const compilePreview=createPreviewCompiler(compileComponents);
type Props={world:WorldDetail;active:PreviewEntry|null;dialog:PreviewEntry|null;dialogOpen:boolean;onCloseDialog:()=>void};

export function WorldComponentCache(props:Props) {
  // Management revisions and freshly decoded arrays do not change author source.
  const identity=previewContentIdentity(props.world);
  return <PreviewPool key={identity} {...props}/>;
}

function PreviewPool({world,active,dialog,dialogOpen,onCloseDialog}:Props) {
  const [entries,setEntries]=useState<readonly PreviewEntry[]>([]);
  // Only the foreground selection opens/reopens an instance. A covered detail
  // must not continually reinsert a FIFO-evicted preview behind a role dialog.
  const retained=retainPreview(entries,dialog??active);
  if(retained!==entries)setEntries(retained);
  const [source]=useState(()=>createPreviewSourceCache(signal=>
    compileWorldComponents(world,sources=>compilePreview(world.id,sources),signal)));
  useEffect(()=>()=>source.dispose(),[source]);
  return <>{retained.map(item=>{
    const visible=item.surface==='dialog'?item.id===dialog?.id:item.id===active?.id;
    const preview=<WorldComponentView worldId={world.id} entry={item.entry} title={item.title}
      active={visible&&(item.surface==='dialog'||!dialogOpen)} dialog={item.surface==='dialog'} load={source.read}/>;
    const key=JSON.stringify([item.id,item.entry]);
    // The retained portal never changes container or DOM position, so closing
    // and reopening a character does not navigate its iframe or lose its state.
    return item.surface==='dialog'
      ?<Modal key={key} open={visible} title={item.title} onClose={onCloseDialog}><div data-world-preview={item.id}>{preview}</div></Modal>
      :<div key={key} hidden={!visible} inert={!visible} data-world-preview={item.id}>{preview}</div>;
  })}</>;
}
