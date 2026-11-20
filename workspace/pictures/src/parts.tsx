import type { Markings } from '@keel/protocol';
import type { MouseEvent, ReactNode } from 'react';
import { asPart } from './build';
import type { Look } from './theme';
import { LOOK_WORD } from './theme';
import type { PictureAct } from './types';

/** The agent's four-point star, as in every agent card header. */
export function Star({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1 L9.6 6.4 L15 8 L9.6 9.6 L8 15 L6.4 9.6 L1 8 L6.4 6.4 Z" fill="#1D4ED8" />
    </svg>
  );
}

/** The class a sub gets from the owner's pen: crossed out, circled, or neither. */
export function subClass(m: Markings, sub: string): string | undefined {
  if (m.crossed.includes(sub)) return 'kp--crossed';
  if (m.circled.includes(sub)) return 'kp--circled';
  return undefined;
}

/** The class the whole picture gets from the owner's pen. */
export function wholeClass(m: Markings): string {
  if (m.crossed.includes('')) return ' kp--crossed';
  if (m.circled.includes('')) return ' kp--circled';
  return '';
}

export const isCrossed = (m: Markings, sub: string): boolean => m.crossed.includes(sub);
export const isCircled = (m: Markings, sub: string): boolean => !m.crossed.includes(sub) && m.circled.includes(sub);

/**
 * What a thing a mark can point at carries: `data-sub`, its pen class, and a tap that tells
 * the app. A tap stops at the innermost sub, so a step inside an approach is not also a tap
 * on the approach.
 */
export function tapper(item: string, m: Markings, onAct?: (act: PictureAct) => void) {
  return (sub: string, extraClass?: string) => {
    const cls = [extraClass, subClass(m, sub), onAct ? 'kp-tap' : undefined].filter(Boolean).join(' ');
    return {
      'data-sub': sub,
      className: cls || undefined,
      onClick: onAct
        ? (e: MouseEvent) => {
            e.stopPropagation();
            onAct({ type: 'tap', item, sub });
          }
        : undefined,
    };
  };
}

/** The same, for an SVG group: SVG takes `className` too, but the pen look is drawn by the renderer. */
export function svgTapper(item: string, onAct?: (act: PictureAct) => void) {
  return (sub: string) => ({
    'data-sub': sub,
    className: onAct ? 'kp-tap' : undefined,
    onClick: onAct
      ? (e: MouseEvent) => {
          e.stopPropagation();
          onAct({ type: 'tap', item, sub });
        }
      : undefined,
  });
}

/** A state chip in the state language of section 7, with the look's own word unless given another. */
export function StateChip({ state, children }: { state: Look; children?: ReactNode }) {
  return <span className={`k-state k-state--${state}`}>{children ?? LOOK_WORD[state]}</span>;
}

/** The agent's voice above a picture: a pale blue strip with a star, a head and a sentence. It is the picture's head. */
export function Strip({ head, children, aside }: { head: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="kp-strip" {...asPart('head')}>
      <span className="kp-strip__head">
        <Star />
        {head}
      </span>
      {children && <span className="kp-strip__text">{children}</span>}
      {aside && <span className="kp-strip__aside">{aside}</span>}
    </div>
  );
}

/** What the grammar could not say: a quiet footnote, never a box that shouts. */
export function Gaps({ gaps }: { gaps?: readonly string[] }) {
  if (!gaps?.length) return null;
  return (
    <div className="kp-gaps" role="note" {...asPart('block')}>
      <span className="kp-gaps__head">This picture leaves out</span>
      <ul>
        {gaps.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
    </div>
  );
}

/** A dark round letter: A to D. */
export function Letter({ children }: { children: ReactNode }) {
  return <span className="kp-letter">{children}</span>;
}

export function LeanChip() {
  return <span className="kp-lean">my lean</span>;
}

export function Risk({ children }: { children: ReactNode }) {
  return (
    <p className="kp-risk" {...asPart('block')}>
      <b>Risk:</b> {children}
    </p>
  );
}
