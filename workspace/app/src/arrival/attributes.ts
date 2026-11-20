/**
 * The attributes an arrival sets on the page, and nothing else: the board's measuring reads them
 * without the player, and the style sheet (`styles/arrival.css`) holds what they mean.
 */

/** On a playing picture's root: its parts are posed, not where they rest, and its drawn parts grow about their own middle. */
export const PLAYS = 'data-arrival';

/** On a waiting picture's element and its arrow: both are kept out of sight until its turn. */
export const WAITS = 'data-arrival-waits';
