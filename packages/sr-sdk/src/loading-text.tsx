import {memo, useMemo, type CSSProperties} from 'react';

export type LoadingTextProps = {text: string; className?: string};

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
const staggerMs = 60, revealMs = 400, pauseMs = 200;

/** Full text stays in layout; animations never update text or schedule React renders. */
export const LoadingText = memo(function LoadingText({text, className}: LoadingTextProps) {
  const characters = useMemo(() => segmenter ? Array.from(segmenter.segment(text), item => item.segment) : [text], [text]);
  if (!text) return null;
  const shineDelay = Math.max(0, characters.length - 1) * staggerMs + revealMs + pauseMs;
  const glyphs = (reveal: boolean) => characters.map((character, index) =>
    /^(?:\r\n|[\r\n\u2028\u2029])$/u.test(character) ? <br key={index}/> :
      <span key={index} className={'sr-loading-glyph' + (reveal ? ' sr-loading-char' : '')}
        style={reveal ? {'--sr-loading-char-delay': index * staggerMs + 'ms'} as CSSProperties : undefined}>{character}</span>);
  return <span className={'sr-loading-text' + (className ? ' ' + className : '')}>
    <span className="sr-loading-accessible">{text}</span>
    <span key={text} className="sr-loading-visual" aria-hidden="true"
      style={{'--sr-loading-shine-delay': shineDelay + 'ms', '--sr-loading-reveal-duration': revealMs + 'ms'} as CSSProperties}>
      <span className="sr-loading-reveal">{glyphs(true)}</span>
      <span className="sr-loading-shine">{glyphs(false)}</span>
    </span>
  </span>;
});
