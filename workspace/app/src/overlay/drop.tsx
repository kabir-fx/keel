/**
 * The agent's figure: an ink drop whose point is its tip, at the top left of its box, with its
 * round body down and right of it. Drawn in a 30 × 30 box, so one unit is a screen pixel at the
 * cursor's size. The tip is the box's corner (0, 0): the cursor's point.
 *
 * Its poses are the style sheet's (`styles/agent.css`), by the cursor's `data-pose`, on these
 * parts: `drop__move` bobs, `drop__turn` leans and scribbles about the tip, `drop__scale` comes
 * out of the drop (a droplet) or swells once as droplets go back in, `drop__lids` close the eyes,
 * `drop__pupils` look, `drop__dots` are the three dots of thinking.
 */

/** The body: straight sides from the tip to the circle of radius 11.5 about (17, 17), where they meet it as tangents, and round the far side of it. */
const BODY = 'M0 0 L20.25 5.97 A11.5 11.5 0 1 1 5.97 20.25 Z';

/** Where the eyes are, in the round part, level with each other. */
const EYES = [
  [13.6, 17.6],
  [20.4, 17.6],
] as const;

/** The drop, `size` pixels square. */
export function Drop({ size }: { size: number }) {
  return (
    <svg className="agent-cursor__drop" width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <g className="drop__move">
        <g className="drop__turn">
          <g className="drop__scale">
            <path className="agent-cursor__halo" d={BODY} />
            <path className="agent-cursor__body" d={BODY} />
            <ellipse className="drop__glint" cx="23.4" cy="11.6" rx="1.9" ry="1.1" transform="rotate(42 23.4 11.6)" />
            <g className="drop__lids">
              {EYES.map(([x, y]) => (
                <ellipse key={x} className="drop__white" cx={x} cy={y} rx="2.5" ry="3" />
              ))}
              <g className="drop__pupils">
                {EYES.map(([x, y]) => (
                  <circle key={x} className="drop__pupil" cx={x} cy={y + 0.3} r="1.4" />
                ))}
              </g>
            </g>
          </g>
        </g>
        <g className="drop__dots">
          <circle cx="22" cy="0.5" r="1.3" />
          <circle cx="25.5" cy="-1.5" r="1.3" />
          <circle cx="29" cy="-3.5" r="1.3" />
        </g>
      </g>
    </svg>
  );
}
