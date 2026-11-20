import { useEffect, useState } from 'react';

/** The faces the board draws in. A picture is measured only once they are in. */
const FONTS = ['600 26px Caveat', '400 14px Inter', '600 14px Inter', '600 16px "Space Grotesk"'];
/** A font that has not come by now is not waited for, in ms. */
const FONTS_WAIT = 2500;

/** Load the board's fonts before anything is measured, so a size never changes under a picture. */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => typeof document === 'undefined' || !document.fonts?.load);
  useEffect(() => {
    if (ready) return;
    let live = true;
    const done = () => live && setReady(true);
    Promise.all(FONTS.map((f) => document.fonts.load(f))).then(done, done);
    const t = setTimeout(done, FONTS_WAIT);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ready]);
  return ready;
}
