import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';

/**
 * Counts a number up to its value over a duration, on one requestAnimationFrame
 * loop. Used by the podium, and by nothing else.
 *
 * WHY IT IS WORTH ANIMATING HERE AND NOWHERE ELSE. A win rate is the one figure
 * in the product whose *magnitude* is the point — 68% against 10% is the whole
 * comparison. Counting it up draws the eye along the three podium blocks in
 * rank order, which is the reading order the podium is trying to impose. Every
 * other number in Quorum is a fact to be read once (a balance, a cost, a token
 * count), and animating those would be decoration.
 *
 * `restartKey` re-runs it, which is how the My council / All time toggle gets a
 * fresh count rather than a jump.
 *
 * Under `prefers-reduced-motion` it returns the final value immediately and
 * never starts a loop — the JavaScript half of the one media query in
 * global.css, exactly as `CursorGlow` is.
 */
export function useCountUp(target, { durationMs = 800, restartKey = 0 } = {}) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [value, setValue] = useState(reducedMotion ? target : 0);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(target)) {
      setValue(target);
      return undefined;
    }

    if (reducedMotion) {
      setValue(target);
      return undefined;
    }

    // A fresh start on every restartKey, so the toggle re-runs rather than
    // continuing from wherever the previous scope's number happened to be.
    setValue(0);

    const startedAt = performance.now();

    const tick = (now) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / durationMs);

      // easeOutCubic: fast at the start and settling at the end, so the last
      // few percent do not crawl. A linear count reads like a slot machine.
      setValue(target * (1 - (1 - progress) ** 3));

      if (progress < 1) frameRef.current = requestAnimationFrame(tick);
      else setValue(target);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frameRef.current);
  }, [target, durationMs, restartKey, reducedMotion]);

  return value;
}
