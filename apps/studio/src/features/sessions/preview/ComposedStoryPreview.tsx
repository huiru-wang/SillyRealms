import {SR,useSRSession,useSRState} from '@sillyrealms/sdk';

/** A trusted sample author composition, using the same public SDK as world-card pages. */
export function ComposedStoryPreview(){
  const session=useSRSession();
  const [location]=useSRState('地点','旧城区 · 雨幕酒吧');
  const [time]=useSRState('时间','23:41');
  const [weather]=useSRState('天气','小雨，街道湿滑');
  const [clues]=useSRState('线索',0);
  return <div className="preview-composed" data-preview-composed>
    <header className="preview-scene-header">
      <span className="preview-scene-kicker">NIGHT CITY <i/> 03</span>
      <div><h2>雨夜重逢</h2><p>{location} <span>·</span> {time}</p></div>
      <span className="preview-scene-weather">{weather}</span>
    </header>
    <div className="preview-composed-body">
      <div className="preview-composed-story"><SR.WorldStory showState={false}/></div>
      <aside className="preview-scene-state" aria-label="作者自定义状态">
        <span className="preview-scene-label">此刻</span>
        <h3>{location}</h3>
        <p>雨幕隔开喧闹的街道。你仍有时间，决定下一步。</p>
        <dl><div><dt>时间</dt><dd>{time}</dd></div><div><dt>已知线索</dt><dd data-preview-clues>{clues}</dd></div></dl>
        <button type="button" onClick={()=>session.setDraft('拿起芯片，仔细查看边缘的刻痕。')}>查看芯片</button>
        <small>作者组合样例 · 状态来自 SDK</small>
      </aside>
    </div>
  </div>;
}
