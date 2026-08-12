import { useEffect, useRef } from 'react';
import { useMediaQuery } from '@mantine/hooks';

/**
 * A soft brass wash that follows the pointer. LANDING PAGE ONLY.
 *
 * It is on the one screen with nothing to read closely and nothing to get
 * wrong — a visitor deciding whether the product is serious. It is deliberately
 * absent from every screen where somebody is comparing model outputs, because
 * there it would be a light moving over the thing they are trying to read.
 *
 * THREE RULES IT KEEPS, and the reason each one is here:
 *
 *   It never touches layout. One fixed div, `pointer-events: none`, moved with
 *   `translate3d` on a compositor layer. Animating `top`/`left` would put a
 *   layout and a paint on every frame of every mouse move, on the page whose
 *   whole job is to look effortless.
 *
 *   It lags the pointer. The position is lerped toward the target at 0.12 per
 *   frame inside one requestAnimationFrame loop, so it drifts rather than
 *   snaps. A glow locked to the cursor reads as a cursor; a glow trailing it
 *   reads as light in the room.
 *
 *   It does not exist for people who did not ask for it. Under
 *   `prefers-reduced-motion` and below 768px — where there is no pointer to
 *   follow — the component returns null and the rAF loop is never started.
 *   That is the JavaScript half of the reduced-motion rule in global.css;
 *   hiding it with CSS would leave a loop running for nobody.
 */
const RADIUS = 520;
/** Peak alpha at the centre of the gradient. Above about 0.10 it stops being
 *  peripheral and starts being a thing on the page. */
const ALPHA = 0.09;
/** Fraction of the remaining distance covered per frame. */
const EASE = 0.12;

export function CursorGlow() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const hasPointer = useMediaQuery('(min-width: 768px) and (pointer: fine)');
  const ref = useRef(null);

  const enabled = hasPointer && !reducedMotion;

  useEffect(() => {
    if (!enabled) return undefined;

    const node = ref.current;
    if (!node) return undefined;

    /**
     * Start centred and invisible rather than at 0,0: a glow that flies in from
     * the top-left corner on the first mouse move is the one moment this effect
     * could actually draw the eye.
     */
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 3;
    let targetX = x;
    let targetY = y;
    let visible = false;
    let frame = 0;

    const onMove = (event) => {
      targetX = event.clientX;
      targetY = event.clientY;

      if (!visible) {
        visible = true;
        node.style.opacity = '1';
      }
    };

    const onLeave = () => {
      visible = false;
      node.style.opacity = '0';
    };

    const tick = () => {
      x += (targetX - x) * EASE;
      y += (targetY - y) * EASE;

      node.style.transform = `translate3d(${Math.round(x - RADIUS / 2)}px, ${Math.round(y - RADIUS / 2)}px, 0)`;
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: RADIUS,
        height: RADIUS,
        borderRadius: '50%',
        pointerEvents: 'none',
        zIndex: 0,
        opacity: 0,
        transition: 'opacity 400ms ease',
        background: `radial-gradient(circle, rgba(154, 107, 31, ${ALPHA}) 0%, rgba(154, 107, 31, ${ALPHA * 0.45}) 35%, rgba(154, 107, 31, 0) 70%)`,
        filter: 'blur(28px)',
        willChange: 'transform',
      }}
    />
  );
}
