import React from 'react';
import {useSRAssetUrl} from '@sillyrealms/sdk';

// This previews the opening; opening.content still supplies the first saved assistant message.
export default function ArrivalPreview() {
  const harbor = useSRAssetUrl('sr-asset://assets/harbor.svg');
  return <article style={{maxWidth: 760, margin: '0 auto', color: 'var(--text)', lineHeight: 1.8}}>
    {harbor && <img src={harbor} alt="雾中的港口和灯塔" style={{display: 'block', width: '100%', borderRadius: 12}} />}
    <h2 style={{margin: '16px 0 6px', fontSize: 20}}>从一封旧信开始</h2>
    <p style={{margin: 0, color: 'var(--text-muted)'}}>渡轮刚刚靠岸。你还不认识港口的人，也不知道旧信该交给谁。带着自己的问题，开始调查灯塔的印记。</p>
  </article>;
}
